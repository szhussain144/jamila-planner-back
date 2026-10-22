import mysql from 'mysql2/promise';
import { config } from './config.js';

/** @type {import('mysql2/promise').Pool} */
export let pool;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
    \`key\`  VARCHAR(64) PRIMARY KEY,
    value   JSON NOT NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS session_types (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(120) NOT NULL,
    duration_min  INT NOT NULL DEFAULT 50,
    buffer_min    INT NOT NULL DEFAULT 10,
    price_cents   INT NOT NULL DEFAULT 0,
    color         VARCHAR(16) NOT NULL DEFAULT '#4f7cff',
    location_type VARCHAR(16) NOT NULL DEFAULT 'in_person',
    is_public     TINYINT(1) NOT NULL DEFAULT 1,
    active        TINYINT(1) NOT NULL DEFAULT 1,
    description   TEXT
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS clients (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    name             VARCHAR(160) NOT NULL,
    email            VARCHAR(190),
    phone            VARCHAR(40),
    is_minor         TINYINT(1) NOT NULL DEFAULT 0,
    guardian_name    VARCHAR(160),
    guardian_email   VARCHAR(190),
    guardian_phone   VARCHAR(40),
    notify_channels  JSON NOT NULL,
    notify_guardian  TINYINT(1) NOT NULL DEFAULT 0,
    notes            TEXT,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_clients_email (email),
    INDEX idx_clients_phone (phone)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS appointments (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    client_id        INT NULL,
    session_type_id  INT NULL,
    start_utc        DATETIME NOT NULL,
    end_utc          DATETIME NOT NULL,
    status           VARCHAR(16) NOT NULL DEFAULT 'pending',
    source           VARCHAR(16) NOT NULL DEFAULT 'app',
    title            VARCHAR(255),
    notes            TEXT,
    location         VARCHAR(255),
    meet_link        VARCHAR(255),
    manage_token     VARCHAR(64) NOT NULL UNIQUE,
    google_event_id  VARCHAR(255) UNIQUE,
    google_etag      VARCHAR(255),
    google_dirty     TINYINT(1) NOT NULL DEFAULT 1,
    cancel_reason    VARCHAR(255),
    client_confirmed_at DATETIME NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_appt_start (start_utc),
    CONSTRAINT fk_appt_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
    CONSTRAINT fk_appt_type FOREIGN KEY (session_type_id) REFERENCES session_types(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,

  // Events that live only in Google Calendar (personal stuff, meetings...). Treated as "busy".
  `CREATE TABLE IF NOT EXISTS external_events (
    google_event_id VARCHAR(255) PRIMARY KEY,
    summary         VARCHAR(255),
    start_utc       DATETIME NOT NULL,
    end_utc         DATETIME NOT NULL,
    all_day         TINYINT(1) NOT NULL DEFAULT 0,
    description     TEXT,
    location        VARCHAR(500),
    html_link       VARCHAR(1000),
    meet_link       VARCHAR(500),
    organizer       VARCHAR(255),
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ext_start (start_utc)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS reminder_jobs (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT NULL,
    kind           VARCHAR(24) NOT NULL,
    channel        VARCHAR(16) NOT NULL,
    recipient      VARCHAR(190) NOT NULL,
    send_at_utc    DATETIME NOT NULL,
    status         VARCHAR(16) NOT NULL DEFAULT 'scheduled',
    attempts       INT NOT NULL DEFAULT 0,
    last_error     TEXT,
    sent_at        DATETIME NULL,
    meta           JSON NULL,
    INDEX idx_jobs_due (status, send_at_utc),
    CONSTRAINT fk_job_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS message_log (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT NULL,
    direction      VARCHAR(4) NOT NULL DEFAULT 'out',
    channel        VARCHAR(16) NOT NULL,
    recipient      VARCHAR(190),
    subject        VARCHAR(255),
    body           TEXT,
    status         VARCHAR(16) NOT NULL,
    error          TEXT,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_msg_created (created_at)
  ) ENGINE=InnoDB`,
];

/** Creates the database (if missing), the pool and all tables. Call once at startup. */
export async function initDb() {
  const { host, port, user, password, database } = config.mysql;
  const bootstrap = await mysql.createConnection({ host, port, user, password });
  await bootstrap.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await bootstrap.end();

  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    connectionLimit: 10,
    timezone: 'Z', // all DATETIME columns are stored in UTC
    dateStrings: false,
    supportBigNumbers: true,
  });
  // Make NOW()/CURRENT_TIMESTAMP UTC as well
  pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

  for (const ddl of SCHEMA) await pool.query(ddl);
  await migrate();
  return pool;
}

/** Columns added after the first release. CREATE TABLE IF NOT EXISTS doesn't add them to existing tables. */
const COLUMN_MIGRATIONS = [
  ['external_events', 'description', 'TEXT'],
  ['external_events', 'location', 'VARCHAR(500)'],
  ['external_events', 'html_link', 'VARCHAR(1000)'],
  ['external_events', 'meet_link', 'VARCHAR(500)'],
  ['external_events', 'organizer', 'VARCHAR(255)'],
];

/** Tables whose columns changed in this start-up (e.g. so Google sync can re-fetch details). */
export const migrated = new Set();

async function migrate() {
  for (const [table, column, type] of COLUMN_MIGRATIONS) {
    const [rows] = await pool.query(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column]
    );
    if (!rows.length) {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
      migrated.add(table);
    }
  }
}

/** SELECT many rows */
export async function all(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** SELECT one row (or null) */
export async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

/** INSERT/UPDATE/DELETE — returns { insertId, affectedRows } */
export async function run(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result;
}

/** Run fn(conn) inside a transaction. */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------- settings helpers ----------
export const DEFAULT_SETTINGS = {
  practice: {
    name: 'Mindful Practice',
    therapistName: 'Dr. Therapist',
    therapistEmail: config.adminEmail,
    therapistPhone: '',
    timezone: config.timezone,
    address: '',
  },
  workingHours: {
    mon: [{ start: '09:00', end: '17:00' }],
    tue: [{ start: '09:00', end: '17:00' }],
    wed: [{ start: '09:00', end: '17:00' }],
    thu: [{ start: '09:00', end: '17:00' }],
    fri: [{ start: '09:00', end: '15:00' }],
    sat: [],
    sun: [],
  },
  booking: {
    minNoticeHours: 12,
    maxDaysAhead: 60,
    slotIntervalMin: 30,
    cancelWindowHours: 24,
    requireApproval: false, // true = website bookings start as "pending" until the therapist approves
  },
  reminders: {
    sendConfirmation: true,
    rules: [
      { offsetMin: 1440, channels: ['email'] },
      { offsetMin: 120, channels: ['sms', 'whatsapp'] },
    ],
    followup: { enabled: true, offsetMin: 120 },
    dailyAgenda: { enabled: true, time: '07:30' },
    therapistHeadsUpMin: 10,
  },
  privacy: {
    googleTitleMode: 'initials', // initials | generic | full
  },
};

const settingsCache = new Map();

export async function getSetting(key) {
  if (!settingsCache.has(key)) {
    const row = await one('SELECT value FROM settings WHERE `key` = ?', [key]);
    let value = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : null;
    const fallback = DEFAULT_SETTINGS[key];
    if (value == null) value = fallback === undefined ? null : structuredClone(fallback);
    else if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) value = { ...fallback, ...value };
    settingsCache.set(key, value);
  }
  return structuredClone(settingsCache.get(key));
}

export async function setSetting(key, value) {
  await run(
    'INSERT INTO settings (`key`, value) VALUES (?, CAST(? AS JSON)) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, JSON.stringify(value)]
  );
  settingsCache.set(key, structuredClone(value));
  return value;
}
