import nodemailer from 'nodemailer';
import twilio from 'twilio';
import { config } from '../config.js';
import { run } from '../db.js';
import { notifyTherapist } from '../lib/realtime.js';

const mailer = config.smtp.host
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

const sms = config.twilio.accountSid && config.twilio.authToken
  ? twilio(config.twilio.accountSid, config.twilio.authToken)
  : null;

export function channelStatus() {
  return {
    email: Boolean(mailer),
    sms: Boolean(sms && config.twilio.smsFrom),
    whatsapp: Boolean(sms && config.twilio.whatsappFrom),
    inapp: true,
  };
}

/**
 * Send one message. Unconfigured channels run in "simulated" mode: the message is logged
 * (and visible in Settings → Message log) but not delivered, so the app is fully demo-able.
 * @returns {Promise<'sent'|'simulated'>}
 */
export async function sendMessage({ channel, to, subject, text, html, appointmentId = null }) {
  let status = 'sent';
  try {
    if (channel === 'email') {
      if (mailer) await mailer.sendMail({ from: config.smtp.from, to, subject, text, html });
      else status = 'simulated';
    } else if (channel === 'sms') {
      if (sms && config.twilio.smsFrom) await sms.messages.create({ from: config.twilio.smsFrom, to, body: text });
      else status = 'simulated';
    } else if (channel === 'whatsapp') {
      if (sms && config.twilio.whatsappFrom)
        await sms.messages.create({ from: config.twilio.whatsappFrom, to: `whatsapp:${to}`, body: text });
      else status = 'simulated';
    } else if (channel === 'inapp') {
      notifyTherapist(subject || 'Reminder', text, { appointmentId });
    } else {
      throw new Error(`Unknown channel ${channel}`);
    }
  } catch (err) {
    await logMessage({ appointmentId, channel, to, subject, text, status: 'failed', error: err.message });
    throw err;
  }
  if (status === 'simulated') console.log(`[simulated ${channel}] → ${to}: ${subject ? subject + ' | ' : ''}${text}`);
  await logMessage({ appointmentId, channel, to, subject, text, status });
  return status;
}

export async function logMessage({ appointmentId, direction = 'out', channel, to, subject, text, status, error = null }) {
  await run(
    `INSERT INTO message_log (appointment_id, direction, channel, recipient, subject, body, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [appointmentId, direction, channel, to, subject || null, text, status, error]
  );
}

/** Verify a Twilio webhook signature (skipped when Twilio isn't configured, e.g. local demo). */
export function verifyTwilio(req) {
  if (!config.twilio.authToken) return true;
  const signature = req.headers['x-twilio-signature'];
  const url = `${config.apiUrl}${req.originalUrl}`;
  return twilio.validateRequest(config.twilio.authToken, signature, url, req.body);
}
