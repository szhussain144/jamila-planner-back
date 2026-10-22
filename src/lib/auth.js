import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function login(email, password) {
  const ok =
    typeof email === 'string' &&
    typeof password === 'string' &&
    email.toLowerCase() === config.adminEmail.toLowerCase() &&
    safeEqual(password, config.adminPassword);
  if (!ok) return null;
  return jwt.sign({ sub: 'admin', email: config.adminEmail }, config.jwtSecret, { expiresIn: '7d' });
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Express middleware: requires a valid admin JWT in Authorization header or ?token= (for EventSource). */
export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
