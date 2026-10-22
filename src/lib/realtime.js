// Server-Sent Events hub: pushes live updates to the therapist dashboard and to open booking pages.
const channels = { admin: new Set(), public: new Set() };

export function subscribe(channel, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // retry: browser reconnect delay. hello/ping are real events so the page can detect a dead connection.
  res.write(`retry: 3000\nevent: hello\ndata: {}\n\n`);
  const client = { res };
  channels[channel].add(client);
  const ping = setInterval(() => res.write(`event: ping\ndata: {}\n\n`), 15000);
  req.on('close', () => {
    clearInterval(ping);
    channels[channel].delete(client);
  });
}

function send(channel, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  for (const c of channels[channel]) c.res.write(payload);
}

/** Calendar data changed (appointments, Google events). Booking pages refresh their slots. */
export function broadcastCalendarChange(reason = 'update') {
  send('admin', 'calendar', { reason, at: Date.now() });
  send('public', 'availability', { at: Date.now() });
}

/** In-app notification / toast for the therapist. */
export function notifyTherapist(title, body, extra = {}) {
  send('admin', 'notification', { title, body, ...extra, at: Date.now() });
}
