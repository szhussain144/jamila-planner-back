import { all, getSetting, one, pool } from '../db.js';
import { randomToken } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { broadcastCalendarChange, notifyTherapist } from '../lib/realtime.js';
import { isTimeFree } from './availability.js';
import { liveBusyCheck, pushAppointment } from './google.js';
import { scheduleForAppointment } from './reminders.js';

const STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'];

const SELECT = `
  SELECT a.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
         st.name AS type_name, st.color AS type_color, st.duration_min, st.buffer_min, st.location_type
  FROM appointments a
  LEFT JOIN clients c ON c.id = a.client_id
  LEFT JOIN session_types st ON st.id = a.session_type_id`;

export function serialize(a) {
  if (!a) return a;
  return {
    id: a.id,
    clientId: a.client_id,
    clientName: a.client_name,
    clientEmail: a.client_email,
    clientPhone: a.client_phone,
    sessionTypeId: a.session_type_id,
    typeName: a.type_name,
    color: a.type_color,
    locationType: a.location_type,
    start: new Date(a.start_utc).toISOString(),
    end: new Date(a.end_utc).toISOString(),
    status: a.status,
    source: a.source,
    title: a.title,
    notes: a.notes,
    location: a.location,
    meetLink: a.meet_link,
    googleEventId: a.google_event_id,
    cancelReason: a.cancel_reason,
    clientConfirmedAt: a.client_confirmed_at,
    manageToken: a.manage_token,
    createdAt: a.created_at,
  };
}

export async function getAppointment(id) {
  return one(`${SELECT} WHERE a.id = ?`, [id]);
}

export async function getByToken(token) {
  return one(`${SELECT} WHERE a.manage_token = ?`, [token]);
}

export async function listAppointments({ from, to, clientId }) {
  const where = [];
  const params = [];
  if (from) (where.push('a.end_utc > ?'), params.push(new Date(from)));
  if (to) (where.push('a.start_utc < ?'), params.push(new Date(to)));
  if (clientId) (where.push('a.client_id = ?'), params.push(clientId));
  return all(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.start_utc`, params);
}

/** Serialises all booking writes so two people can never grab the same slot. */
async function withBookingLock(fn) {
  const conn = await pool.getConnection();
  try {
    const [[{ got }]] = await conn.query(`SELECT GET_LOCK('therapy_booking', 10) AS got`);
    if (!got) throw conflict('Booking system busy, please retry');
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      await conn.query(`SELECT RELEASE_LOCK('therapy_booking')`);
    }
  } finally {
    conn.release();
  }
}

/**
 * Live check against Google Calendar (runs inside the booking lock). Clients only ever see a
 * generic message: the therapist's private event titles are never revealed to them.
 */
async function assertGoogleFree(start, end, bufferMin, forClient) {
  const clashes = await liveBusyCheck(start, end, bufferMin);
  if (clashes?.length) {
    broadcastCalendarChange('google-busy'); // the clashing event was just stored; refresh open pages
    throw conflict(forClient ? 'That time is no longer available' : `That time overlaps "${clashes[0].summary}" in your Google Calendar`);
  }
}

/** Side effects of a change: reminders, Google Calendar event (created before we reply), live UI refresh. */
async function afterChange(id, event) {
  await scheduleForAppointment(id, event);
  broadcastCalendarChange(event);
  // Wait (up to 8s) so the Google event exists by the time the booking is confirmed.
  // If Google is slow or down the row stays "dirty" and the sync loop retries it.
  const pushed = pushAppointment(id).then(() => broadcastCalendarChange('google-push'));
  await Promise.race([pushed.catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
}

export async function findOrCreateClient(conn, { name, email, phone }) {
  email = email?.trim().toLowerCase() || null;
  phone = phone?.replace(/[^\d+]/g, '') || null;
  if (!name?.trim()) throw badRequest('Client name is required');
  if (!email && !phone) throw badRequest('Email or phone is required');
  const [rows] = await conn.query(
    'SELECT * FROM clients WHERE (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?) LIMIT 1',
    [email, phone]
  );
  if (rows[0]) return rows[0].id;
  const [res] = await conn.query('INSERT INTO clients (name, email, phone, notify_channels) VALUES (?, ?, ?, ?)', [
    name.trim(),
    email,
    phone,
    JSON.stringify(['email', 'sms', 'whatsapp']),
  ]);
  return res.insertId;
}

export async function createAppointment(input) {
  const { sessionTypeId, start, source = 'app', notes = null, title = null, location = null, force = false } = input;
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) throw badRequest('Invalid start time');

  const type = sessionTypeId ? await one('SELECT * FROM session_types WHERE id = ?', [sessionTypeId]) : null;
  if (sessionTypeId && !type) throw badRequest('Unknown session type');
  const durationMin = input.durationMin || type?.duration_min || 50;
  const endDate = input.end ? new Date(input.end) : new Date(startDate.getTime() + durationMin * 60_000);
  if (endDate <= startDate) throw badRequest('End must be after start');

  const booking = await getSetting('booking');
  const status = input.status || (source === 'website' && booking.requireApproval ? 'pending' : 'confirmed');
  if (!STATUSES.includes(status)) throw badRequest('Invalid status');

  const id = await withBookingLock(async (conn) => {
    const clientId = input.clientId || (input.client ? await findOrCreateClient(conn, input.client) : null);
    if (!force) {
      if (!(await isTimeFree(conn, startDate, endDate, type?.buffer_min ?? 0))) {
        throw conflict(source === 'website' ? 'That time is no longer available' : 'That time overlaps another session or a busy block from your Google Calendar');
      }
      await assertGoogleFree(startDate, endDate, type?.buffer_min ?? 0, source === 'website');
    }
    const [res] = await conn.query(
      `INSERT INTO appointments (client_id, session_type_id, start_utc, end_utc, status, source, title, notes, location, manage_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [clientId, sessionTypeId || null, startDate, endDate, status, source, title, notes, location, randomToken()]
    );
    return res.insertId;
  });

  await afterChange(id, 'created');
  const appt = await getAppointment(id);
  if (source === 'website') notifyTherapist('New online booking', `${appt.client_name} booked ${appt.type_name || 'a session'}.`, { appointmentId: id });
  return appt;
}

export async function updateAppointment(id, patch, { actor = 'therapist' } = {}) {
  const current = await getAppointment(id);
  if (!current) throw notFound('Appointment not found');

  const next = {
    client_id: patch.clientId !== undefined ? patch.clientId : current.client_id,
    session_type_id: patch.sessionTypeId !== undefined ? patch.sessionTypeId : current.session_type_id,
    start_utc: patch.start ? new Date(patch.start) : new Date(current.start_utc),
    end_utc: patch.end ? new Date(patch.end) : new Date(current.end_utc),
    status: patch.status || current.status,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
    title: patch.title !== undefined ? patch.title : current.title,
    location: patch.location !== undefined ? patch.location : current.location,
    cancel_reason: patch.cancelReason !== undefined ? patch.cancelReason : current.cancel_reason,
  };
  if (!STATUSES.includes(next.status)) throw badRequest('Invalid status');

  // moving start without an explicit end keeps the duration
  if (patch.start && !patch.end) {
    next.end_utc = new Date(next.start_utc.getTime() + (new Date(current.end_utc) - new Date(current.start_utc)));
  }
  if (next.end_utc <= next.start_utc) throw badRequest('End must be after start');

  const moved =
    next.start_utc.getTime() !== new Date(current.start_utc).getTime() || next.end_utc.getTime() !== new Date(current.end_utc).getTime();
  const reactivated = current.status === 'cancelled' && next.status !== 'cancelled';

  await withBookingLock(async (conn) => {
    if ((moved || reactivated) && next.status !== 'cancelled' && !patch.force) {
      const [[type]] = await conn.query('SELECT buffer_min FROM session_types WHERE id = ?', [next.session_type_id]);
      if (!(await isTimeFree(conn, next.start_utc, next.end_utc, type?.buffer_min ?? 0, id))) {
        throw conflict(actor === 'client' ? 'That time is no longer available' : 'That time overlaps another appointment');
      }
      await assertGoogleFree(next.start_utc, next.end_utc, type?.buffer_min ?? 0, actor === 'client');
    }
    await conn.query(
      `UPDATE appointments SET client_id = ?, session_type_id = ?, start_utc = ?, end_utc = ?, status = ?, notes = ?, title = ?,
         location = ?, cancel_reason = ?, google_dirty = 1,
         client_confirmed_at = IF(?, NULL, client_confirmed_at) WHERE id = ?`,
      [next.client_id, next.session_type_id, next.start_utc, next.end_utc, next.status, next.notes, next.title, next.location, next.cancel_reason, moved, id]
    );
  });

  let event = 'updated';
  if (next.status === 'cancelled' && current.status !== 'cancelled') event = 'cancelled';
  else if (moved || reactivated) event = 'rescheduled';
  else if (current.status !== next.status && next.status === 'confirmed') event = 'confirmed';

  await afterChange(id, event === 'confirmed' ? 'updated' : event);
  const appt = await getAppointment(id);
  if (actor === 'client' && event !== 'updated') {
    const label = { cancelled: 'cancelled', rescheduled: 'rescheduled', confirmed: 'confirmed' }[event];
    notifyTherapist(`Client ${label} an appointment`, `${appt.client_name || 'A client'} ${label} their session.`, { appointmentId: id });
  }
  return appt;
}

/** Can a client still change this booking themselves? */
export async function clientCanChange(appt) {
  const { cancelWindowHours } = await getSetting('booking');
  const hoursLeft = (new Date(appt.start_utc) - Date.now()) / 3600_000;
  return ['pending', 'confirmed'].includes(appt.status) && hoursLeft >= cancelWindowHours;
}
