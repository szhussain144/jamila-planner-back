// Two-way Google Calendar sync.
//
//  App  ──►  Google : every appointment change marks the row "dirty" and is pushed immediately
//                     (retried by the poller if Google is unreachable).
//  Google ──► App   : push notifications (events.watch → /api/public/google/webhook) trigger an
//                     incremental sync with a syncToken. A backup poll every GOOGLE_POLL_SECONDS
//                     catches anything a webhook missed (and is the only mechanism on plain http/localhost).
//
// Our own events carry extendedProperties.private.appId so we recognise them when they come back.
import crypto from 'node:crypto';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { config, googleConfigured } from '../config.js';
import { all, getSetting, migrated, one, run, setSetting } from '../db.js';
import { broadcastCalendarChange, notifyTherapist } from '../lib/realtime.js';
import { scheduleForAppointment } from './reminders.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar', 'openid', 'email'];
const AUTH_KEY = 'googleAuth'; // { tokens, email, calendarId, syncToken, channel }

async function getAuthState() {
  return (await getSetting(AUTH_KEY)) || null;
}
async function saveAuthState(patch) {
  const current = (await getAuthState()) || {};
  return setSetting(AUTH_KEY, { ...current, ...patch });
}

function oauthClient() {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

async function calendarApi() {
  const state = await getAuthState();
  if (!state?.tokens) return null;
  const auth = oauthClient();
  auth.setCredentials(state.tokens);
  auth.on('tokens', (tokens) => {
    saveAuthState({ tokens: { ...state.tokens, ...tokens } }).catch(() => {});
  });
  return { cal: google.calendar({ version: 'v3', auth }), state };
}

// ---------------------------------------------------------------- connection
export async function status() {
  const state = await getAuthState();
  return {
    configured: googleConfigured(),
    connected: Boolean(state?.tokens),
    email: state?.email || null,
    calendarId: state?.calendarId || 'primary',
    pushNotifications: Boolean(state?.channel?.id),
    lastSyncAt: state?.lastSyncAt || null,
  };
}

export function authUrl(stateToken) {
  return oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state: stateToken });
}

export async function handleCallback(code) {
  const auth = oauthClient();
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  let email = null;
  try {
    const info = await google.oauth2({ version: 'v2', auth }).userinfo.get();
    email = info.data.email;
  } catch {}
  await setSetting(AUTH_KEY, { tokens, email, calendarId: 'primary', syncToken: null, channel: null });
  await run('UPDATE appointments SET google_dirty = 1 WHERE google_event_id IS NULL');

  await syncFromGoogle({ full: true });
  await pushDirty();
  await ensureWatch();
}

export async function disconnect() {
  const api = await calendarApi();
  if (api) {
    await stopWatch(api).catch(() => {});
    await oauthClient().revokeToken(api.state.tokens.refresh_token || api.state.tokens.access_token).catch(() => {});
  }
  await setSetting(AUTH_KEY, null);
  await run('DELETE FROM external_events');
  await run('UPDATE appointments SET google_event_id = NULL, google_etag = NULL, google_dirty = 1');
  broadcastCalendarChange('google-disconnected');
}

// ---------------------------------------------------------------- App → Google
async function eventTitle(appt) {
  const { googleTitleMode } = await getSetting('privacy');
  const name = appt.client_name || appt.title || '';
  if (googleTitleMode === 'full' && name) return `Session – ${name}`;
  if (googleTitleMode === 'initials' && name)
    return `Session – ${name.split(/\s+/).map((p) => p[0]?.toUpperCase() + '.').join('')}`;
  return 'Client session';
}

async function buildEvent(appt) {
  const practice = await getSetting('practice');
  const event = {
    summary: await eventTitle(appt),
    description: `Managed by ${practice.name} scheduler. Edit time here or in the app — both stay in sync.\n${config.frontendUrl}/calendar?appt=${appt.id}`,
    start: { dateTime: new Date(appt.start_utc).toISOString(), timeZone: practice.timezone },
    end: { dateTime: new Date(appt.end_utc).toISOString(), timeZone: practice.timezone },
    location: appt.location || undefined,
    status: appt.status === 'pending' ? 'tentative' : 'confirmed',
    extendedProperties: { private: { appId: String(appt.id) } },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
  };
  return event;
}

export async function pushAppointment(appointmentId) {
  const api = await calendarApi();
  if (!api) return;
  const appt = await one(
    `SELECT a.*, c.name AS client_name, st.location_type FROM appointments a
     LEFT JOIN clients c ON c.id = a.client_id LEFT JOIN session_types st ON st.id = a.session_type_id WHERE a.id = ?`,
    [appointmentId]
  );
  if (!appt) return;
  const { cal, state } = api;
  const calendarId = state.calendarId || 'primary';

  try {
    if (appt.status === 'cancelled') {
      if (appt.google_event_id) {
        await cal.events.delete({ calendarId, eventId: appt.google_event_id, sendUpdates: 'none' }).catch((e) => {
          if (![404, 410].includes(e.code)) throw e;
        });
      }
      await run('UPDATE appointments SET google_dirty = 0 WHERE id = ?', [appt.id]);
      return;
    }

    const body = await buildEvent(appt);
    const wantsMeet = appt.location_type === 'video' && !appt.meet_link;
    if (wantsMeet) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };

    let res;
    if (appt.google_event_id) {
      res = await cal.events
        .patch({ calendarId, eventId: appt.google_event_id, requestBody: body, conferenceDataVersion: 1, sendUpdates: 'none' })
        .catch((e) => {
          if (e.code === 404 || e.code === 410) return null; // deleted in Google → recreate
          throw e;
        });
    }
    if (!res) res = await cal.events.insert({ calendarId, requestBody: body, conferenceDataVersion: 1, sendUpdates: 'none' });

    const meet = res.data.hangoutLink || appt.meet_link || null;
    await run('UPDATE appointments SET google_event_id = ?, google_etag = ?, meet_link = ?, google_dirty = 0 WHERE id = ?', [
      res.data.id,
      res.data.etag,
      meet,
      appt.id,
    ]);
    if (meet && meet !== appt.meet_link) broadcastCalendarChange('meet-link');
  } catch (err) {
    console.error(`[google] push appointment ${appointmentId} failed:`, err.message);
  }
}

export async function pushDirty() {
  if (!(await getAuthState())?.tokens) return;
  const rows = await all(
    `SELECT id FROM appointments WHERE google_dirty = 1 AND (google_event_id IS NOT NULL OR (status <> 'cancelled' AND end_utc > UTC_TIMESTAMP())) LIMIT 100`
  );
  for (const r of rows) await pushAppointment(r.id);
}

// ---------------------------------------------------------------- Google → App
function eventTimes(ev, tz) {
  if (ev.start?.dateTime) return { start: new Date(ev.start.dateTime), end: new Date(ev.end.dateTime), allDay: false };
  const zone = ev.start?.timeZone || tz;
  return {
    start: DateTime.fromISO(ev.start.date, { zone }).toUTC().toJSDate(),
    end: DateTime.fromISO(ev.end.date, { zone }).toUTC().toJSDate(),
    allDay: true,
  };
}

let syncing = null;
export function syncFromGoogle(opts) {
  // serialise syncs: webhook bursts and the poller share one in-flight run
  if (!syncing) syncing = doSync(opts).finally(() => (syncing = null));
  return syncing;
}

const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

/**
 * Pull Google changes if the last sync is older than maxAgeMs. Used before showing booking slots
 * so a new Google event disappears from the booking page within seconds, not after the next poll.
 * Never blocks the page for more than ~3s if Google is slow.
 */
export async function syncIfStale(maxAgeMs = 15_000) {
  const state = await getAuthState();
  if (!state?.tokens) return;
  const age = state.lastSyncAt ? Date.now() - Date.parse(state.lastSyncAt) : Infinity;
  if (age < maxAgeMs) return;
  await withTimeout(syncFromGoogle().catch(() => {}), 3000);
}

/**
 * Live double-booking guard: asks Google right now whether anything (other than this app's own
 * sessions, which the database already covers) overlaps [start, end] ± buffer.
 * Returns the clashing events, [] when free, or null when Google isn't connected / didn't answer
 * (the caller then relies on the last synced data).
 */
export async function liveBusyCheck(start, end, bufferMin = 0) {
  const api = await calendarApi();
  if (!api) return null;
  const pad = bufferMin * 60_000;
  const from = new Date(start.getTime() - pad);
  const to = new Date(end.getTime() + pad);
  const { timezone } = await getSetting('practice');
  try {
    const res = await withTimeout(
      api.cal.events.list({ calendarId: api.state.calendarId || 'primary', timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, maxResults: 50 }),
      4000,
      null
    );
    if (!res) return null;
    const clashes = [];
    for (const ev of res.data.items || []) {
      if (ev.extendedProperties?.private?.appId) continue; // our own session
      if (ev.status === 'cancelled' || ev.transparency === 'transparent' || !ev.start) continue;
      const t = eventTimes(ev, timezone);
      if (t.start < to && t.end > from) {
        clashes.push({ id: ev.id, summary: ev.summary || 'Busy', start: t.start, end: t.end });
        // store it now so the calendar and booking page reflect it immediately
        await applyGoogleEvent(ev, timezone, { horizon: Infinity, past: 0 }).catch(() => {});
      }
    }
    return clashes;
  } catch (err) {
    console.error('[google] live busy check failed (using synced data):', err.message);
    return null;
  }
}

async function doSync({ full = false } = {}) {
  const api = await calendarApi();
  if (!api) return;
  const { cal, state } = api;
  const calendarId = state.calendarId || 'primary';
  const { timezone } = await getSetting('practice');
  let syncToken = full ? null : state.syncToken;
  if (!syncToken) await run('DELETE FROM external_events');

  let pageToken;
  let nextSyncToken;
  let changed = 0;
  const horizon = Date.now() + 400 * 86_400_000;
  const past = Date.now() - 30 * 86_400_000;

  try {
    do {
      const res = await cal.events.list({
        calendarId,
        singleEvents: true,
        showDeleted: Boolean(syncToken),
        maxResults: 250,
        pageToken,
        ...(syncToken ? { syncToken } : {}),
      });
      for (const ev of res.data.items || []) changed += await applyGoogleEvent(ev, timezone, { horizon, past });
      pageToken = res.data.nextPageToken;
      nextSyncToken = res.data.nextSyncToken || nextSyncToken;
    } while (pageToken);
  } catch (err) {
    if (err.code === 410) {
      // sync token expired → full resync
      await saveAuthState({ syncToken: null });
      return doSync({ full: true });
    }
    console.error('[google] sync failed:', err.message);
    return;
  }

  await saveAuthState({ syncToken: nextSyncToken, lastSyncAt: new Date().toISOString() });
  if (changed) broadcastCalendarChange('google-sync');
}

async function applyGoogleEvent(ev, timezone, { horizon, past }) {
  const appId = ev.extendedProperties?.private?.appId;

  if (appId) {
    // One of ours — reflect edits the therapist made directly in Google Calendar.
    const appt = await one('SELECT * FROM appointments WHERE id = ?', [Number(appId)]);
    if (!appt || appt.google_etag === ev.etag) return 0; // unknown or our own echo
    if (ev.status === 'cancelled') {
      if (appt.status === 'cancelled') return 0;
      await run(
        `UPDATE appointments SET status = 'cancelled', cancel_reason = 'Deleted in Google Calendar', google_event_id = NULL, google_etag = NULL, google_dirty = 0 WHERE id = ?`,
        [appt.id]
      );
      await scheduleForAppointment(appt.id, 'cancelled');
      notifyTherapist('Appointment cancelled from Google Calendar', `Appointment #${appt.id} was deleted in Google.`);
      return 1;
    }
    const { start, end } = eventTimes(ev, timezone);
    const moved = start.getTime() !== new Date(appt.start_utc).getTime() || end.getTime() !== new Date(appt.end_utc).getTime();
    await run('UPDATE appointments SET start_utc = ?, end_utc = ?, google_etag = ?, meet_link = COALESCE(?, meet_link) WHERE id = ?', [
      start,
      end,
      ev.etag,
      ev.hangoutLink || null,
      appt.id,
    ]);
    if (moved && appt.status !== 'cancelled') {
      await scheduleForAppointment(appt.id, 'rescheduled');
      notifyTherapist('Appointment moved in Google Calendar', `Appointment #${appt.id} was rescheduled; the client has been notified.`);
    }
    return moved ? 1 : 0;
  }

  // Not ours → treat as a busy block (unless cancelled, free/transparent, or outside the window)
  if (ev.status === 'cancelled' || ev.transparency === 'transparent' || !ev.start) {
    const r = await run('DELETE FROM external_events WHERE google_event_id = ?', [ev.id]);
    return r.affectedRows;
  }
  const { start, end, allDay } = eventTimes(ev, timezone);
  if (end.getTime() < past || start.getTime() > horizon) return 0;
  const cut = (s, n) => (s ? String(s).slice(0, n) : null);
  await run(
    `INSERT INTO external_events (google_event_id, summary, start_utc, end_utc, all_day, description, location, html_link, meet_link, organizer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE summary = VALUES(summary), start_utc = VALUES(start_utc), end_utc = VALUES(end_utc), all_day = VALUES(all_day),
       description = VALUES(description), location = VALUES(location), html_link = VALUES(html_link), meet_link = VALUES(meet_link), organizer = VALUES(organizer)`,
    [
      ev.id,
      (ev.summary || 'Busy').slice(0, 250),
      start,
      end,
      allDay ? 1 : 0,
      cut(ev.description, 10000),
      cut(ev.location, 500),
      cut(ev.htmlLink, 1000),
      cut(ev.hangoutLink || ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri, 500),
      cut(ev.organizer?.self ? null : ev.organizer?.displayName || ev.organizer?.email, 255),
    ]
  );
  return 1;
}

// ---------------------------------------------------------------- push notifications (watch channels)
async function stopWatch(api) {
  const ch = api.state.channel;
  if (!ch?.id) return;
  await api.cal.channels.stop({ requestBody: { id: ch.id, resourceId: ch.resourceId } });
  await saveAuthState({ channel: null });
}

export async function ensureWatch() {
  if (!config.apiUrl.startsWith('https://')) return; // Google only delivers webhooks to https endpoints
  const api = await calendarApi();
  if (!api) return;
  const ch = api.state.channel;
  if (ch?.expiration && Number(ch.expiration) - Date.now() > 24 * 3600_000) return; // still valid > 1 day

  await stopWatch(api).catch(() => {});
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(16).toString('hex');
  try {
    const res = await api.cal.events.watch({
      calendarId: api.state.calendarId || 'primary',
      requestBody: { id, type: 'web_hook', address: `${config.apiUrl}/api/public/google/webhook`, token, params: { ttl: String(7 * 86400) } },
    });
    await saveAuthState({ channel: { id, token, resourceId: res.data.resourceId, expiration: res.data.expiration } });
  } catch (err) {
    console.error('[google] watch failed (polling still active):', err.message);
  }
}

export async function handleWebhook(headers) {
  const state = await getAuthState();
  if (!state?.channel || headers['x-goog-channel-id'] !== state.channel.id || headers['x-goog-channel-token'] !== state.channel.token) return false;
  if (headers['x-goog-resource-state'] !== 'sync') syncFromGoogle().catch(() => {});
  return true;
}

export function startGoogleSync() {
  const loop = async () => {
    if (!(await getAuthState())?.tokens) return;
    // new detail columns were just added → fetch everything once so existing busy blocks get their details
    const full = migrated.delete('external_events');
    await syncFromGoogle({ full });
    await pushDirty();
    await ensureWatch();
  };
  const run = () => loop().catch((e) => console.error('[google] loop failed:', e.message));
  setTimeout(run, 3000);
  return setInterval(run, Math.max(15, config.google.pollSeconds) * 1000);
}
