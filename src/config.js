import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const env = process.env;
const trim = (u) => u.replace(/\/$/, '');
const port = Number(env.PORT || 4000);

export const config = {
  port,
  // Where the React app lives: used for links in emails/SMS and redirects after Google sign-in
  frontendUrl: trim(env.FRONTEND_URL || 'http://localhost:5173'),
  // Public address of this API: used for Google push webhooks and Twilio signature checks
  apiUrl: trim(env.API_URL || `http://localhost:${port}`),
  // Browser origins allowed to call the API (comma separated). Defaults to FRONTEND_URL.
  corsOrigins: (env.CORS_ORIGINS || env.FRONTEND_URL || 'http://localhost:5173').split(',').map((s) => trim(s.trim())).filter(Boolean),
  adminEmail: env.ADMIN_EMAIL || 'therapist@example.com',
  adminPassword: env.ADMIN_PASSWORD || 'change-me',
  jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
  timezone: env.PRACTICE_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,

  mysql: {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'therapy_scheduler',
  },

  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: env.GOOGLE_REDIRECT_URI || `${trim(env.API_URL || `http://localhost:${port}`)}/api/public/google/callback`,
    pollSeconds: Number(env.GOOGLE_POLL_SECONDS || 60),
  },

  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'Practice <no-reply@example.com>',
  },

  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    smsFrom: env.TWILIO_SMS_FROM || '',
    whatsappFrom: env.TWILIO_WHATSAPP_FROM || '',
  },
};

export const googleConfigured = () => Boolean(config.google.clientId && config.google.clientSecret);
