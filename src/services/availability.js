import { DateTime } from 'luxon';
import { all, getSetting, one } from '../db.js';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** All busy intervals (ms epoch) overlapping [from, to]. */
async function busyIntervals(fromUtc, toUtc, { excludeAppointmentId = null, q = all } = {}) {
  const appts = await q(
    `SELECT a.id, a.start_utc, a.end_utc FROM appointments a
     WHERE a.status NOT IN ('cancelled') AND a.start_utc < ? AND a.end_utc > ? AND (? IS NULL OR a.id <> ?)`,
    [toUtc, fromUtc, excludeAppointmentId, excludeAppointmentId]
  );
  const external = await q(
    `SELECT start_utc, end_utc FROM external_events WHERE start_utc < ? AND end_utc > ?`,
    [toUtc, fromUtc]
  );
  return [...appts, ...external].map((r) => [new Date(r.start_utc).getTime(), new Date(r.end_utc).getTime()]);
}

const overlaps = (s, e, busy, bufferMs) => busy.some(([bs, be]) => s < be + bufferMs && e + bufferMs > bs);

/**
 * Bookable slots for a session type between two ISO dates (inclusive, practice-local days).
 * Returns [{ start, end }] as ISO UTC strings.
 */
export async function getSlots({ sessionTypeId, from, to, excludeAppointmentId = null, ignoreNotice = false }) {
  const type = await one('SELECT * FROM session_types WHERE id = ? AND active = 1', [sessionTypeId]);
  if (!type) return [];
  const { timezone } = await getSetting('practice');
  const hours = await getSetting('workingHours');
  const booking = await getSetting('booking');

  const now = DateTime.utc();
  const earliest = ignoreNotice ? now : now.plus({ hours: booking.minNoticeHours });
  const latest = now.plus({ days: booking.maxDaysAhead }).endOf('day');

  let day = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  const lastDay = DateTime.fromISO(to, { zone: timezone }).endOf('day');
  if (!day.isValid || !lastDay.isValid) return [];

  const busy = await busyIntervals(day.toUTC().toJSDate(), lastDay.toUTC().toJSDate(), { excludeAppointmentId });
  const durMs = type.duration_min * 60_000;
  const bufMs = type.buffer_min * 60_000;
  const stepMin = Math.max(5, booking.slotIntervalMin);
  const slots = [];

  for (let guard = 0; day <= lastDay && guard < 120; guard++, day = day.plus({ days: 1 })) {
    const ranges = hours[WEEKDAYS[day.weekday - 1]] || [];
    for (const { start, end } of ranges) {
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      const rangeEnd = day.set({ hour: eh, minute: em });
      for (let s = day.set({ hour: sh, minute: sm }); s.plus({ minutes: type.duration_min }) <= rangeEnd; s = s.plus({ minutes: stepMin })) {
        const sUtc = s.toUTC();
        if (sUtc < earliest || sUtc > latest) continue;
        const sMs = sUtc.toMillis();
        if (overlaps(sMs, sMs + durMs, busy, bufMs)) continue;
        slots.push({ start: sUtc.toISO(), end: sUtc.plus({ milliseconds: durMs }).toISO() });
      }
    }
  }
  return slots;
}

/** Double-booking guard. Call while holding the booking lock (see appointments.withBookingLock). */
export async function isTimeFree(conn, start, end, bufferMin, excludeAppointmentId = null) {
  const q = async (sql, params) => (await conn.query(sql, params))[0];
  const pad = bufferMin * 60_000;
  const from = new Date(start.getTime() - pad);
  const to = new Date(end.getTime() + pad);
  const busy = await busyIntervals(from, to, { excludeAppointmentId, q });
  return !overlaps(start.getTime(), end.getTime(), busy, pad);
}
