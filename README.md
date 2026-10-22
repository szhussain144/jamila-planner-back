# Therapy Scheduler: Backend (API)

Node.js + Express + MySQL API for the therapy scheduler. It handles:

- Appointments with double-booking protection.
- The public booking and manage-link endpoints.
- Two-way Google Calendar sync.
- The reminder engine: email, SMS, WhatsApp and in-app alerts.
- Real-time updates over Server-Sent Events.

The UI lives in a separate repo, **therapy-scheduler-frontend**.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Before starting, fill in DB_*, ADMIN_*, JWT_SECRET and FRONTEND_URL in `.env`. `npm run dev` starts the API on http://localhost:4000 and restarts it on file changes.

- The MySQL database and tables are created automatically on first start. Default session types are seeded.
- `npm run seed` adds a few demo clients and appointments.
- `npm start` runs it in production, without the file watcher.

## Environment

| Variable | Purpose |
|---|---|
| `FRONTEND_URL` | Where the React app runs. Used in links inside emails and SMS, the redirect after Google sign-in, and the default CORS origin. |
| `API_URL` | Public address of this API. Used for the Google push webhook (it must be https for live push) and Twilio signature checks. |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API. Defaults to `FRONTEND_URL`. |
| `DB_*` | MySQL connection details. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `JWT_SECRET` | Therapist login. |
| `GOOGLE_*` | OAuth client for Calendar sync. The redirect URI is `<API_URL>/api/public/google/callback`. |
| `SMTP_*` | Email delivery. Leave empty for demo mode: messages are logged, not sent. |
| `TWILIO_*` | SMS and WhatsApp delivery. Leave empty for demo mode. |

## API overview

| Path | Auth | Purpose |
|---|---|---|
| `POST /api/auth/login` | none | Returns a JWT |
| `GET /api/stream?token=` | JWT | Live events for the therapist dashboard (SSE) |
| `/api/dashboard`, `/api/calendar`, `/api/appointments`, `/api/clients`, `/api/session-types`, `/api/settings`, `/api/messages`, `/api/reminder-jobs`, `/api/google/*` | JWT | Therapist app |
| `/api/public/practice`, `/api/public/slots`, `POST /api/public/book` | none | Public booking page |
| `/api/public/manage/:token[/confirm\|cancel\|reschedule]` | secret link | Client self-service |
| `GET /api/public/stream` | none | Live availability updates (SSE) |
| `POST /api/public/webhooks/twilio` | Twilio signature | Client SMS/WhatsApp replies: C confirms, X cancels, R sends a reschedule link |
| `GET /api/public/google/callback`, `POST /api/public/google/webhook` | Google | OAuth and Calendar push notifications |

## Layout

```
src/
  index.js            Express app, CORS, starts the reminder worker and Google sync loop
  config.js           Reads .env
  db.js               MySQL pool, schema, settings store
  seed.js             Default session types and demo data
  routes/admin.js     Therapist API (JWT)
  routes/public.js    Booking, manage links, webhooks
  services/           appointments, availability, google, reminders, notifications, templates
  lib/                auth, http helpers, realtime (SSE hub)
```

## Deploying

Run it on any Node 20+ host: Railway, Render, a VPS with pm2, and so on. Use a managed MySQL instance. Then:

1. Set `API_URL` to the API's public https address.
2. Set `FRONTEND_URL` to the deployed frontend's address.
3. Point the Twilio incoming-message webhook at `POST <API_URL>/api/public/webhooks/twilio`.
