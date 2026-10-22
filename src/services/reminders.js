import { DateTime } from 'luxon';
import { all, getSetting, one, run, setSetting } from '../db.js';
import { sendMessage } from './notifications.js';
import { agendaMessage, buildMessage } from './templates.js';

const MAX_ATTEMPTS = 3;

/** Who receives which channel for this client. */
function recipientsFor(client, channels) {
  const allowed = new Set(Array.isArray(client.notify_channels) ? client.notify_channels : []);
  const out = [];
  for (const ch of channels) {
    if (!allowed.has(ch)) continue;
    const addr = ch === 'email' ? client.email : client.phone;
    if (addr) out.push({ channel: ch, recipient: addr });
    if (client.is_minor && client.notify_guardian) {
      const g = ch === 'email' ? client.guardian_email : client.guardian_phone;
      if (g) out.push({ channel: ch, recipient: g, guardian: true });
    }
  }
  return out;
}

async function queue(appointmentId, kind, list, sendAt) {
  const ids = [];
  for (const { channel, recipient, guardian } of list) {
    const r = await run(
      `INSERT INTO reminder_jobs (appointment_id, kind, channel, recipient, send_at_utc, meta) VALUES (?, ?, ?, ?, ?, ?)`,
      [appointmentId, kind, channel, recipient, sendAt, JSON.stringify({ guardian: Boolean(guardian) })]
    );
    ids.push(r.insertId);
  }
  // Messages due now (confirmations, cancellations) go out immediately instead of waiting for the next worker tick
  if (sendAt <= new Date()) {
    for (const id of ids) {
      const job = await one('SELECT * FROM reminder_jobs WHERE id = ?', [id]);
      if (job) await processJob(job);
    }
  }
}

/**
 * (Re)builds the reminder schedule for an appointment.
 * event: created | rescheduled | cancelled | updated
 */
export async function scheduleForAppointment(appointmentId, event) {
  await run(`UPDATE reminder_jobs SET status = 'cancelled' WHERE appointment_id = ? AND status = 'scheduled'`, [appointmentId]);

  const appt = await one('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
  if (!appt) return;
  const client = appt.client_id ? await one('SELECT * FROM clients WHERE id = ?', [appt.client_id]) : null;
  const cfg = await getSetting('reminders');
  const now = new Date();
  const start = new Date(appt.start_utc);
  const end = new Date(appt.end_utc);
  const allChannels = ['email', 'sms', 'whatsapp'];

  if (appt.status === 'cancelled') {
    if (event === 'cancelled' && client && start > now) await queue(appt.id, 'cancellation', recipientsFor(client, allChannels), now);
    return;
  }
  if (!['pending', 'confirmed'].includes(appt.status)) return;

  if (client) {
    if (event === 'created' && cfg.sendConfirmation) await queue(appt.id, 'confirmation', recipientsFor(client, ['email', 'sms']), now);
    if (event === 'rescheduled') await queue(appt.id, 'reschedule', recipientsFor(client, ['email', 'sms']), now);

    for (const rule of cfg.rules || []) {
      const at = new Date(start.getTime() - rule.offsetMin * 60_000);
      if (at > now) await queue(appt.id, 'reminder', recipientsFor(client, rule.channels), at);
    }
    if (cfg.followup?.enabled) {
      await queue(appt.id, 'followup', recipientsFor(client, ['email']), new Date(end.getTime() + cfg.followup.offsetMin * 60_000));
    }
  }

  // Heads-up for the therapist in the dashboard
  if (cfg.therapistHeadsUpMin > 0) {
    const at = new Date(start.getTime() - cfg.therapistHeadsUpMin * 60_000);
    if (at > now) await queue(appt.id, 'headsup', [{ channel: 'inapp', recipient: 'therapist' }], at);
  }
}

async function processJob(job) {
  // claim the job so two workers never send it twice
  const claim = await run(`UPDATE reminder_jobs SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'scheduled'`, [job.id]);
  if (!claim.affectedRows) return;

  try {
    const appt = await one(
      `SELECT a.*, st.name AS type_name FROM appointments a LEFT JOIN session_types st ON st.id = a.session_type_id WHERE a.id = ?`,
      [job.appointment_id]
    );
    const stillRelevant =
      appt && (job.kind === 'cancellation' || job.kind === 'followup' ? true : ['pending', 'confirmed'].includes(appt.status));
    if (!stillRelevant || (job.kind === 'followup' && appt.status === 'no_show')) {
      await run(`UPDATE reminder_jobs SET status = 'cancelled' WHERE id = ?`, [job.id]);
      return;
    }
    const practice = await getSetting('practice');
    let msg;
    if (job.kind === 'headsup') {
      const t = DateTime.fromJSDate(new Date(appt.start_utc)).setZone(practice.timezone).toFormat('h:mm a');
      const client = appt.client_id ? await one('SELECT name FROM clients WHERE id = ?', [appt.client_id]) : null;
      msg = { subject: 'Session starting soon', text: `${client?.name || appt.title || 'Session'} at ${t}${appt.meet_link ? ' — ' + appt.meet_link : ''}` };
    } else {
      const client = await one('SELECT * FROM clients WHERE id = ?', [appt.client_id]);
      msg = buildMessage(job.kind, { appt, client, practice, channel: job.channel });
    }
    const status = await sendMessage({ channel: job.channel, to: job.recipient, subject: msg.subject, text: msg.text, appointmentId: appt.id });
    await run(`UPDATE reminder_jobs SET status = ?, sent_at = UTC_TIMESTAMP(), last_error = NULL WHERE id = ?`, [status, job.id]);
  } catch (err) {
    const attempts = job.attempts + 1;
    const retry = attempts < MAX_ATTEMPTS;
    await run(
      `UPDATE reminder_jobs SET status = ?, last_error = ?, send_at_utc = ? WHERE id = ?`,
      [retry ? 'scheduled' : 'failed', err.message, new Date(Date.now() + attempts * 5 * 60_000), job.id]
    );
    console.error(`[reminders] job ${job.id} failed (attempt ${attempts}):`, err.message);
  }
}

async function tick() {
  const due = await all(
    `SELECT * FROM reminder_jobs WHERE status = 'scheduled' AND send_at_utc <= UTC_TIMESTAMP() ORDER BY send_at_utc LIMIT 50`
  );
  for (const job of due) await processJob(job);
  await maybeSendDailyAgenda();
}

async function maybeSendDailyAgenda() {
  const cfg = await getSetting('reminders');
  if (!cfg.dailyAgenda?.enabled) return;
  const practice = await getSetting('practice');
  const local = DateTime.now().setZone(practice.timezone);
  const today = local.toISODate();
  const state = (await getSetting('state')) || {};
  if (state.lastAgendaDate === today || local.toFormat('HH:mm') < cfg.dailyAgenda.time) return;
  await setSetting('state', { ...state, lastAgendaDate: today });

  const appts = await all(
    `SELECT a.*, c.name AS client_name, st.name AS type_name FROM appointments a
     LEFT JOIN clients c ON c.id = a.client_id LEFT JOIN session_types st ON st.id = a.session_type_id
     WHERE a.status IN ('pending','confirmed') AND a.start_utc >= ? AND a.start_utc < ? ORDER BY a.start_utc`,
    [local.startOf('day').toUTC().toJSDate(), local.endOf('day').toUTC().toJSDate()]
  );
  const msg = agendaMessage(appts, practice);
  await sendMessage({ channel: 'inapp', to: 'therapist', ...msg });
  if (practice.therapistEmail) await sendMessage({ channel: 'email', to: practice.therapistEmail, ...msg }).catch(() => {});
}

export function startReminderWorker(intervalMs = 20_000) {
  // recover jobs stuck in "sending" after a crash
  run(`UPDATE reminder_jobs SET status = 'scheduled' WHERE status = 'sending'`).catch(() => {});
  const loop = () => tick().catch((e) => console.error('[reminders] tick failed:', e.message));
  loop();
  return setInterval(loop, intervalMs);
}
