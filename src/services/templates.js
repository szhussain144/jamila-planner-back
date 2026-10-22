import { DateTime } from 'luxon';
import { config } from '../config.js';

// Messages deliberately avoid clinical details (diagnosis, session type names like "anxiety therapy")
// so a lock-screen preview or a shared phone doesn't leak sensitive information.

const fmtWhen = (date, tz) =>
  DateTime.fromJSDate(new Date(date)).setZone(tz).toFormat("ccc, d LLL yyyy 'at' h:mm a (ZZZZ)");

export function buildMessage(kind, { appt, client, practice, channel }) {
  const when = fmtWhen(appt.start_utc, practice.timezone);
  const link = `${config.frontendUrl}/a/${appt.manage_token}`;
  const firstName = (client?.name || '').split(' ')[0] || 'there';
  const sig = `— ${practice.therapistName}, ${practice.name}`;
  const where = appt.meet_link ? `Join online: ${appt.meet_link}` : appt.location ? `Location: ${appt.location}` : '';
  const short = channel === 'sms' || channel === 'whatsapp';

  switch (kind) {
    case 'confirmation':
      return {
        subject: `Appointment booked: ${when}`,
        text: short
          ? `Hi ${firstName}, your appointment with ${practice.therapistName} is booked for ${when}. Manage: ${link}`
          : `Hi ${firstName},\n\nYour appointment is booked for ${when}.\n${where}\n\nNeed to confirm, reschedule or cancel? ${link}\n\n${sig}`,
      };
    case 'reminder':
      return {
        subject: `Reminder: appointment ${when}`,
        text: short
          ? `Reminder: you have an appointment ${when}. Reply C to confirm, X to cancel, R to reschedule. ${appt.meet_link || ''}`.trim()
          : `Hi ${firstName},\n\nThis is a friendly reminder of your appointment on ${when}.\n${where}\n\nConfirm, reschedule or cancel: ${link}\n\n${sig}`,
      };
    case 'followup':
      return {
        subject: `Thank you — book your next session`,
        text: short
          ? `Thanks for today, ${firstName}. Book your next session any time: ${config.frontendUrl}/book`
          : `Hi ${firstName},\n\nThank you for your session today. Whenever you're ready, you can book your next appointment here: ${config.frontendUrl}/book\n\nIf you are in crisis, please contact your local emergency number or a crisis line immediately.\n\n${sig}`,
      };
    case 'cancellation':
      return {
        subject: `Appointment cancelled: ${when}`,
        text: short
          ? `Your appointment on ${when} has been cancelled. Rebook: ${config.frontendUrl}/book`
          : `Hi ${firstName},\n\nYour appointment on ${when} has been cancelled.\nYou can book a new time here: ${config.frontendUrl}/book\n\n${sig}`,
      };
    case 'reschedule':
      return {
        subject: `Appointment moved to ${when}`,
        text: short
          ? `Your appointment has moved to ${when}. Manage: ${link}`
          : `Hi ${firstName},\n\nYour appointment has been moved to ${when}.\n${where}\n\nManage your booking: ${link}\n\n${sig}`,
      };
    default:
      throw new Error(`Unknown template ${kind}`);
  }
}

export function agendaMessage(appts, practice) {
  const day = DateTime.now().setZone(practice.timezone).toFormat('cccc d LLLL');
  if (!appts.length) return { subject: `Today's agenda (${day})`, text: `No sessions booked today. Enjoy your day!` };
  const lines = appts.map((a) => {
    const t = DateTime.fromJSDate(new Date(a.start_utc)).setZone(practice.timezone).toFormat('h:mm a');
    return `• ${t} — ${a.client_name || a.title || 'Session'} (${a.type_name || 'Session'})${a.status === 'pending' ? ' [unconfirmed]' : ''}`;
  });
  return { subject: `Today's agenda: ${appts.length} session(s) (${day})`, text: lines.join('\n') };
}
