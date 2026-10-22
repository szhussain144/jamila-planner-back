import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { DateTime } from 'luxon';
import { config, googleConfigured } from '../config.js';
import { all, DEFAULT_SETTINGS, getSetting, one, run, setSetting } from '../db.js';
import { login, requireAdmin } from '../lib/auth.js';
import { ah, badRequest, notFound } from '../lib/http.js';
import { broadcastCalendarChange, subscribe } from '../lib/realtime.js';
import { createAppointment, getAppointment, listAppointments, serialize, updateAppointment } from '../services/appointments.js';
import { getSlots } from '../services/availability.js';
import * as google from '../services/google.js';
import { channelStatus } from '../services/notifications.js';
import { scheduleForAppointment } from '../services/reminders.js';

export const admin = Router();

admin.post('/auth/login', (req, res) => {
  const token = login(req.body?.email, req.body?.password);
  if (!token) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token });
});

admin.use(requireAdmin);

admin.get('/me', (req, res) => res.json({ email: req.user.email }));
admin.get('/stream', (req, res) => subscribe('admin', req, res));

// ---------------- dashboard
admin.get(
  '/dashboard',
  ah(async (req, res) => {
    const now = new Date();
    const weekAgo = new Date(Date.now() - 30 * 86_400_000);
    const [upcoming] = await all(
      `SELECT COUNT(*) AS n FROM appointments WHERE status IN ('pending','confirmed') AND start_utc >= ?`,
      [now]
    );
    const [pending] = await all(`SELECT COUNT(*) AS n FROM appointments WHERE status = 'pending' AND start_utc >= ?`, [now]);
    const stats = await all(
      `SELECT status, COUNT(*) AS n FROM appointments WHERE start_utc BETWEEN ? AND ? GROUP BY status`,
      [weekAgo, now]
    );
    const [sent] = await all(`SELECT COUNT(*) AS n FROM message_log WHERE direction = 'out' AND created_at >= ?`, [weekAgo]);
    const next = await listAppointments({ from: now, to: new Date(Date.now() + 7 * 86_400_000) });
    const { timezone } = await getSetting('practice');
    const local = DateTime.now().setZone(timezone);
    const today = await listAppointments({ from: local.startOf('day').toJSDate(), to: local.endOf('day').toJSDate() });
    const by = Object.fromEntries(stats.map((s) => [s.status, Number(s.n)]));
    const attended = (by.completed || 0) + (by.confirmed || 0);
    res.json({
      upcoming: Number(upcoming.n),
      pending: Number(pending.n),
      last30: by,
      noShowRate: attended + (by.no_show || 0) ? (by.no_show || 0) / (attended + (by.no_show || 0)) : 0,
      messagesSent30: Number(sent.n),
      next: next.filter((a) => a.status !== 'cancelled').slice(0, 10).map(serialize),
      today: today.filter((a) => a.status !== 'cancelled').map(serialize),
      channels: channelStatus(),
      google: await google.status(),
    });
  })
);

// ---------------- calendar feed (appointments + Google busy blocks)
admin.get(
  '/calendar',
  ah(async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) throw badRequest('from and to are required');
    const appts = await listAppointments({ from, to });
    const external = await all('SELECT * FROM external_events WHERE start_utc < ? AND end_utc > ?', [new Date(to), new Date(from)]);
    res.json({
      appointments: appts.map(serialize),
      external: external.map((e) => ({
        id: e.google_event_id,
        title: e.summary,
        start: new Date(e.start_utc).toISOString(),
        end: new Date(e.end_utc).toISOString(),
        allDay: Boolean(e.all_day),
        description: e.description,
        location: e.location,
        htmlLink: e.html_link,
        meetLink: e.meet_link,
        organizer: e.organizer,
      })),
    });
  })
);

// ---------------- appointments
admin.get(
  '/appointments',
  ah(async (req, res) => res.json((await listAppointments(req.query)).map(serialize)))
);
admin.get(
  '/appointments/:id',
  ah(async (req, res) => {
    const a = await getAppointment(req.params.id);
    if (!a) throw notFound();
    const jobs = await all('SELECT * FROM reminder_jobs WHERE appointment_id = ? ORDER BY send_at_utc', [a.id]);
    res.json({ ...serialize(a), reminders: jobs });
  })
);
admin.post(
  '/appointments',
  ah(async (req, res) => res.status(201).json(serialize(await createAppointment({ ...req.body, source: 'app' }))))
);
admin.patch(
  '/appointments/:id',
  ah(async (req, res) => res.json(serialize(await updateAppointment(Number(req.params.id), req.body))))
);
admin.post(
  '/appointments/:id/resend',
  ah(async (req, res) => {
    await scheduleForAppointment(Number(req.params.id), 'created');
    res.json({ ok: true });
  })
);

admin.get(
  '/availability',
  ah(async (req, res) => {
    const { sessionTypeId, from, to, excludeAppointmentId } = req.query;
    res.json(await getSlots({ sessionTypeId, from, to, excludeAppointmentId: excludeAppointmentId || null, ignoreNotice: true }));
  })
);

// ---------------- clients
const clientRow = (c) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  phone: c.phone,
  isMinor: Boolean(c.is_minor),
  guardianName: c.guardian_name,
  guardianEmail: c.guardian_email,
  guardianPhone: c.guardian_phone,
  notifyChannels: c.notify_channels || [],
  notifyGuardian: Boolean(c.notify_guardian),
  notes: c.notes,
  createdAt: c.created_at,
  upcoming: c.upcoming != null ? Number(c.upcoming) : undefined,
  total: c.total != null ? Number(c.total) : undefined,
});

admin.get(
  '/clients',
  ah(async (req, res) => {
    const q = `%${req.query.q || ''}%`;
    const rows = await all(
      `SELECT c.*,
         (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id AND a.status IN ('pending','confirmed') AND a.start_utc >= UTC_TIMESTAMP()) AS upcoming,
         (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id) AS total
       FROM clients c WHERE c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? ORDER BY c.name LIMIT 500`,
      [q, q, q]
    );
    res.json(rows.map(clientRow));
  })
);

admin.get(
  '/clients/:id',
  ah(async (req, res) => {
    const c = await one('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!c) throw notFound();
    const appts = await listAppointments({ clientId: c.id });
    res.json({ ...clientRow(c), appointments: appts.map(serialize) });
  })
);

function clientValues(b) {
  if (!b.name?.trim()) throw badRequest('Name is required');
  return [
    b.name.trim(),
    b.email?.trim().toLowerCase() || null,
    b.phone?.replace(/[^\d+]/g, '') || null,
    b.isMinor ? 1 : 0,
    b.guardianName || null,
    b.guardianEmail || null,
    b.guardianPhone?.replace(/[^\d+]/g, '') || null,
    JSON.stringify(b.notifyChannels || ['email', 'sms']),
    b.notifyGuardian ? 1 : 0,
    b.notes || null,
  ];
}

admin.post(
  '/clients',
  ah(async (req, res) => {
    const r = await run(
      `INSERT INTO clients (name, email, phone, is_minor, guardian_name, guardian_email, guardian_phone, notify_channels, notify_guardian, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      clientValues(req.body)
    );
    res.status(201).json(clientRow(await one('SELECT * FROM clients WHERE id = ?', [r.insertId])));
  })
);

admin.put(
  '/clients/:id',
  ah(async (req, res) => {
    await run(
      `UPDATE clients SET name = ?, email = ?, phone = ?, is_minor = ?, guardian_name = ?, guardian_email = ?, guardian_phone = ?,
         notify_channels = ?, notify_guardian = ?, notes = ? WHERE id = ?`,
      [...clientValues(req.body), req.params.id]
    );
    res.json(clientRow(await one('SELECT * FROM clients WHERE id = ?', [req.params.id])));
  })
);

admin.delete(
  '/clients/:id',
  ah(async (req, res) => {
    await run('DELETE FROM clients WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  })
);

// ---------------- session types
const typeRow = (t) => ({
  id: t.id,
  name: t.name,
  durationMin: t.duration_min,
  bufferMin: t.buffer_min,
  priceCents: t.price_cents,
  color: t.color,
  locationType: t.location_type,
  isPublic: Boolean(t.is_public),
  active: Boolean(t.active),
  description: t.description,
});
const typeValues = (b) => [
  b.name,
  Number(b.durationMin) || 50,
  Number(b.bufferMin) || 0,
  Number(b.priceCents) || 0,
  b.color || '#4f7cff',
  b.locationType || 'in_person',
  b.isPublic === false ? 0 : 1,
  b.active === false ? 0 : 1,
  b.description || null,
];

admin.get('/session-types', ah(async (req, res) => res.json((await all('SELECT * FROM session_types ORDER BY id')).map(typeRow))));
admin.post(
  '/session-types',
  ah(async (req, res) => {
    if (!req.body.name) throw badRequest('Name is required');
    const r = await run(
      `INSERT INTO session_types (name, duration_min, buffer_min, price_cents, color, location_type, is_public, active, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      typeValues(req.body)
    );
    broadcastCalendarChange('session-types');
    res.status(201).json(typeRow(await one('SELECT * FROM session_types WHERE id = ?', [r.insertId])));
  })
);
admin.put(
  '/session-types/:id',
  ah(async (req, res) => {
    await run(
      `UPDATE session_types SET name = ?, duration_min = ?, buffer_min = ?, price_cents = ?, color = ?, location_type = ?,
         is_public = ?, active = ?, description = ? WHERE id = ?`,
      [...typeValues(req.body), req.params.id]
    );
    broadcastCalendarChange('session-types');
    res.json(typeRow(await one('SELECT * FROM session_types WHERE id = ?', [req.params.id])));
  })
);

// ---------------- settings
const EDITABLE = ['practice', 'workingHours', 'booking', 'reminders', 'privacy'];
admin.get(
  '/settings',
  ah(async (req, res) => {
    const out = {};
    for (const k of EDITABLE) out[k] = await getSetting(k);
    res.json(out);
  })
);
admin.put(
  '/settings/:key',
  ah(async (req, res) => {
    const { key } = req.params;
    if (!EDITABLE.includes(key)) throw badRequest('Unknown setting');
    const merged = Array.isArray(DEFAULT_SETTINGS[key]) ? req.body : { ...(await getSetting(key)), ...req.body };
    await setSetting(key, merged);
    if (['workingHours', 'booking'].includes(key)) broadcastCalendarChange('settings');
    if (key === 'privacy') await run('UPDATE appointments SET google_dirty = 1 WHERE google_event_id IS NOT NULL AND end_utc > UTC_TIMESTAMP()');
    res.json(merged);
  })
);

// ---------------- messages / reminder queue
admin.get(
  '/messages',
  ah(async (req, res) => res.json(await all('SELECT * FROM message_log ORDER BY id DESC LIMIT 200')))
);
admin.get(
  '/reminder-jobs',
  ah(async (req, res) =>
    res.json(
      await all(
        `SELECT j.*, c.name AS client_name FROM reminder_jobs j
         LEFT JOIN appointments a ON a.id = j.appointment_id LEFT JOIN clients c ON c.id = a.client_id
         WHERE j.status = 'scheduled' ORDER BY j.send_at_utc LIMIT 200`
      )
    )
  )
);

// ---------------- Google Calendar
admin.get('/google/status', ah(async (req, res) => res.json(await google.status())));
admin.get('/google/auth-url', (req, res) => {
  if (!googleConfigured()) return res.status(400).json({ error: 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env first' });
  const state = jwt.sign({ purpose: 'google-oauth' }, config.jwtSecret, { expiresIn: '10m' });
  res.json({ url: google.authUrl(state) });
});
admin.post(
  '/google/sync',
  ah(async (req, res) => {
    await google.syncFromGoogle();
    await google.pushDirty();
    res.json(await google.status());
  })
);
admin.post(
  '/google/disconnect',
  ah(async (req, res) => {
    await google.disconnect();
    res.json(await google.status());
  })
);
