import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { initDb } from './db.js';
import { admin } from './routes/admin.js';
import { pub } from './routes/public.js';
import { startGoogleSync } from './services/google.js';
import { startReminderWorker } from './services/reminders.js';
import { ensureSeedData } from './seed.js';

await initDb();
await ensureSeedData();

const app = express();
app.set('trust proxy', 1);

// Only the frontend may call the API from a browser. Server-to-server callers
// (Google, Twilio) send no Origin header and are unaffected.
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
);
app.use(express.json({ limit: '200kb' }));

app.get('/', (req, res) => res.json({ name: 'therapy-scheduler-api', ok: true }));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/public', pub); // booking page API, manage links, Google + Twilio webhooks
app.use('/api', admin); // therapist API (JWT)

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
});

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
  console.log(`Frontend: ${config.frontendUrl} · CORS: ${config.corsOrigins.join(', ')} · TZ: ${config.timezone}`);
  startReminderWorker();
  startGoogleSync();
});
