import express, { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { all, getSetting, one, run } from '../db.js';
import { ah, badRequest, HttpError, notFound } from '../lib/http.js';
import { broadcastCalendarChange, notifyTherapist, subscribe } from '../lib/realtime.js';
import { clientCanChange, createAppointment, getAppointment, getByToken, serialize, updateAppointment } from '../services/appointments.js';
import { getSlots } from '../services/availability.js';
import * as google from '../services/google.js';
import { logMessage, verifyTwilio } from '../services/notifications.js';

export const pub = Router();

pub.get('/stream', (req, res) => subscribe('public', req, res));

pub.get(
  '/practice',
  ah(async (req, res) => {
    const practice = await getSetting('practice');
    const booking = await getSetting('booking');
    const types = await all('SELECT * FROM session_types WHERE active = 1 AND is_public = 1 ORDER BY id');
    const hours = await getSetting('workingHours');
    res.json({
      name: practice.name,
      therapistName: practice.therapistName,
      timezone: practice.timezone,
      address: practice.address,
      maxDaysAhead: booking.maxDaysAhead,
      minNoticeHours: booking.minNoticeHours,
      cancelWindowHours: booking.cancelWindowHours,
      // per weekday (practice timezone): [{start, end}] — lets the booking page say "Closed" vs "Full"
      workingHours: hours,
      sessionTypes: types.map((t) => ({
        id: t.id,
        name: t.name,
        durationMin: t.duration_min,
        priceCents: t.price_cents,
        color: t.color,
        locationType: t.location_type,
        description: t.description,
      })),
    });
  })
);

pub.get(
  '/slots',
  ah(async (req, res) => {
    const { sessionTypeId, from, to } = req.query;
    if (!sessionTypeId || !from || !to) throw badRequest('sessionTypeId, from and to are required');
    const type = await one('SELECT id FROM session_types WHERE id = ? AND is_public = 1 AND active = 1', [sessionTypeId]);
    if (!type) throw notFound('Session type not available');
    // Pick up anything just added in Google Calendar. fresh=1 (a day was clicked) re-checks
    // unless we synced in the last 3 seconds; otherwise a 15-second-old sync is good enough.
    await google.syncIfStale(req.query.fresh ? 3_000 : 15_000);
    res.json(await getSlots({ sessionTypeId, from, to, excludeAppointmentId: req.query.exclude ? await excludeId(req.query.exclude) : null }));
  })
);

async function excludeId(token) {
  const a = await getByToken(token);
  return a?.id || null;
}

// simple in-memory rate limit for the public booking endpoint
const hits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 10 * 60_000);
  if (list.length >= 10) return res.status(429).json({ error: 'Too many bookings, please try again later' });
  list.push(now);
  hits.set(key, list);
  next();
}

pub.post(
  '/book',
  rateLimit,
  ah(async (req, res) => {
    const { sessionTypeId, start, name, email, phone, notes, consent, isMinor, guardianName, guardianEmail, guardianPhone } = req.body || {};
    if (!consent) throw badRequest('Please accept the booking & privacy terms');
    const type = await one('SELECT * FROM session_types WHERE id = ? AND is_public = 1 AND active = 1', [sessionTypeId]);
    if (!type) throw badRequest('Session type not available');

    // Only allow times that are actually offered (respects notice period, hours, buffers, Google busy time)
    if (!(await isOffered(type.id, start))) throw new HttpError(409, 'That time is no longer available — please pick another slot');

    const appt = await createAppointment({
      sessionTypeId: type.id,
      start,
      source: 'website',
      notes: notes ? `Client note: ${String(notes).slice(0, 1000)}` : null,
      client: { name, email, phone },
    });
    if (isMinor && appt.client_id) {
      await run(
        'UPDATE clients SET is_minor = 1, guardian_name = ?, guardian_email = ?, guardian_phone = ?, notify_guardian = 1 WHERE id = ?',
        [guardianName || null, guardianEmail || null, guardianPhone?.replace(/[^\d+]/g, '') || null, appt.client_id]
      );
    }
    res.status(201).json(await manageView(appt));
  })
);

const shiftDay = (iso, d) => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);

/** Is `start` one of the slots we'd show? (day ±1 covers any timezone offset) */
async function isOffered(sessionTypeId, start, excludeAppointmentId = null) {
  const t = new Date(start).getTime();
  if (Number.isNaN(t)) return false;
  const day = new Date(t).toISOString().slice(0, 10);
  const slots = await getSlots({ sessionTypeId, from: shiftDay(day, -1), to: shiftDay(day, 1), excludeAppointmentId });
  return slots.some((s) => new Date(s.start).getTime() === t);
}

async function markClientConfirmed(a, channel) {
  await run('UPDATE appointments SET client_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [a.id]);
  await logMessage({ appointmentId: a.id, direction: 'in', channel, to: 'client', text: 'Client confirmed attendance', status: 'received' });
  broadcastCalendarChange('client-confirmed');
  notifyTherapist('Client confirmed', `${a.client_name || 'A client'} confirmed their session.`, { appointmentId: a.id });
}

async function manageView(a) {
  return {
    token: a.manage_token,
    start: new Date(a.start_utc).toISOString(),
    end: new Date(a.end_utc).toISOString(),
    status: a.status,
    typeName: a.type_name,
    sessionTypeId: a.session_type_id,
    clientName: a.client_name,
    meetLink: a.meet_link,
    location: a.location,
    clientConfirmed: Boolean(a.client_confirmed_at),
    canChange: await clientCanChange(a),
  };
}

// ---------------- manage booking by secret link (/a/:token)
pub.get(
  '/manage/:token',
  ah(async (req, res) => {
    const a = await getByToken(req.params.token);
    if (!a) throw notFound('Booking not found');
    res.json(await manageView(a));
  })
);

pub.post(
  '/manage/:token/:action',
  ah(async (req, res) => {
    const a = await getByToken(req.params.token);
    if (!a) throw notFound('Booking not found');
    const { action } = req.params;

    if (action === 'confirm') {
      if (!['pending', 'confirmed'].includes(a.status)) throw badRequest('This booking can no longer be confirmed');
      await markClientConfirmed(a, 'web');
      return res.json(await manageView(await getByToken(a.manage_token)));
    }

    if (!(await clientCanChange(a))) {
      const { cancelWindowHours } = await getSetting('booking');
      throw badRequest(`Changes are only possible up to ${cancelWindowHours} hours before the session. Please contact the practice.`);
    }
    if (action === 'cancel') {
      const updated = await updateAppointment(a.id, { status: 'cancelled', cancelReason: req.body?.reason || 'Cancelled by client' }, { actor: 'client' });
      return res.json(await manageView(updated));
    }
    if (action === 'reschedule') {
      const { start } = req.body || {};
      if (!(await isOffered(a.session_type_id, start, a.id))) throw new HttpError(409, 'That time is no longer available');
      const updated = await updateAppointment(a.id, { start }, { actor: 'client' });
      return res.json(await manageView(updated));
    }
    throw badRequest('Unknown action');
  })
);

// ---------------- Twilio inbound SMS / WhatsApp: reply C / X / R
pub.post(
  '/webhooks/twilio',
  express.urlencoded({ extended: false }),
  ah(async (req, res) => {
    if (!verifyTwilio(req)) return res.status(403).end();
    const from = String(req.body.From || '').replace(/^whatsapp:/, '').replace(/[^\d+]/g, '');
    const body = String(req.body.Body || '').trim();
    const channel = String(req.body.From || '').startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const reply = await handleReply(from, body, channel);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
  })
);

async function handleReply(phone, body, channel) {
  const client = await one('SELECT * FROM clients WHERE phone = ? OR guardian_phone = ? LIMIT 1', [phone, phone]);
  const appt = client
    ? await one(
        `SELECT id FROM appointments WHERE client_id = ? AND status IN ('pending','confirmed') AND start_utc > UTC_TIMESTAMP() ORDER BY start_utc LIMIT 1`,
        [client.id]
      )
    : null;
  await logMessage({ appointmentId: appt?.id || null, direction: 'in', channel, to: phone, text: body, status: 'received' });
  if (!appt) return `We couldn't find an upcoming appointment for this number. Book at ${config.frontendUrl}/book`;

  const a = await getAppointment(appt.id);
  const cmd = body.toUpperCase()[0];
  if (cmd === 'C') {
    await markClientConfirmed(a, channel);
    return `Thanks! Your appointment is confirmed. See you then.`;
  }
  if (cmd === 'R') return `Pick a new time here: ${config.frontendUrl}/a/${a.manage_token}`;
  if (cmd === 'X') {
    if (!(await clientCanChange(a))) return `It's too late to cancel online. Please call the practice directly.`;
    await updateAppointment(a.id, { status: 'cancelled', cancelReason: `Cancelled via ${channel} reply` }, { actor: 'client' });
    return `Your appointment has been cancelled. Rebook any time: ${config.frontendUrl}/book`;
  }
  return `Reply C to confirm, X to cancel, or R to reschedule.`;
}

const escapeXml = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

// ---------------- Google OAuth callback + push-notification webhook
pub.get(
  '/google/callback',
  ah(async (req, res) => {
    try {
      jwt.verify(String(req.query.state || ''), config.jwtSecret);
    } catch {
      throw badRequest('Invalid OAuth state');
    }
    if (req.query.error) return res.redirect(`${config.frontendUrl}/settings?tab=google&google=denied`);
    await google.handleCallback(String(req.query.code));
    res.redirect(`${config.frontendUrl}/settings?tab=google&google=connected`);
  })
);

pub.post(
  '/google/webhook',
  ah(async (req, res) => {
    await google.handleWebhook(req.headers);
    res.status(200).end();
  })
);
