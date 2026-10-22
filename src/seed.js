import { pathToFileURL } from 'node:url';
import { one, run } from './db.js';

/** Inserts default session types the first time the app starts. */
export async function ensureSeedData() {
  const row = await one('SELECT COUNT(*) AS n FROM session_types');
  if (Number(row.n) > 0) return;
  const types = [
    ['Initial consultation', 60, 15, 0, '#7c5cff', 'in_person', 'First meeting to understand your needs and goals.'],
    ['Individual therapy session', 50, 10, 0, '#2f80ed', 'in_person', 'Standard one-to-one session.'],
    ['Online session (video)', 50, 10, 0, '#16a085', 'video', 'Secure video session — a meeting link is sent automatically.'],
    ['Student counseling', 30, 5, 0, '#f2994a', 'in_person', 'Short session for students (academic, stress, wellbeing).'],
  ];
  for (const t of types) {
    await run(
      `INSERT INTO session_types (name, duration_min, buffer_min, price_cents, color, location_type, description) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      t
    );
  }
  console.log('Seeded default session types');
}

// `npm run seed` → also add a few demo clients and appointments
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dbModule = await import('./db.js');
  await dbModule.initDb();
  await ensureSeedData();
  const { createAppointment } = await import('./services/appointments.js');
  const { getSlots } = await import('./services/availability.js');

  const demo = [
    { name: 'Ayesha Khan', email: 'ayesha@example.com', phone: '+923001234567' },
    { name: 'Omar Siddiqui', email: 'omar@example.com', phone: '+923007654321' },
    { name: 'Sara Ahmed', email: 'sara@example.com', phone: '+923331112223' },
  ];
  const today = new Date().toISOString().slice(0, 10);
  const in10 = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  let i = 0;
  for (const client of demo) {
    const typeId = (i % 4) + 1;
    const slots = await getSlots({ sessionTypeId: typeId, from: today, to: in10 });
    const slot = slots[(i + 1) * 7];
    if (slot) {
      await createAppointment({ sessionTypeId: typeId, start: slot.start, client, source: 'app' });
      console.log(`Booked ${client.name} at ${slot.start}`);
    }
    i++;
  }
  await new Promise((r) => setTimeout(r, 500));
  await dbModule.pool.end();
  process.exit(0);
}
