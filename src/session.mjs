import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const cookieName = 'dmland_session';
const lifetime = 8 * 60 * 60 * 1000;
const retryWindow = 60_000;
const sessions = new Map();
const failures = new Map();

const digest = (value) => createHash('sha256').update(value).digest();
export const passwordMatches = (value) => timingSafeEqual(digest(value), digest(process.env.DASHBOARD_PASSWORD));
const sessionId = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)dmland_session=([a-f0-9]{64})(?:;|$)/)?.[1];
const secure = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
const cookie = (req, token, age) => `${cookieName}=${token}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Strict${secure(req) ? '; Secure' : ''}`;

export function hasSession(req) {
  return sessions.get(sessionId(req)) > Date.now();
}

export function startSession(req, res) {
  const now = Date.now();
  for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
  endSession(req, res);
  if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
  const id = randomBytes(32).toString('hex');
  sessions.set(id, now + lifetime);
  res.setHeader('Set-Cookie', cookie(req, id, lifetime / 1000));
}

export function endSession(req, res) {
  sessions.delete(sessionId(req));
  res.setHeader('Set-Cookie', cookie(req, '', 0));
}

export function canAttemptLogin(req) {
  const now = Date.now();
  for (const [ip, entry] of failures) if (entry.until <= now) failures.delete(ip);
  const ip = req.socket.remoteAddress;
  return (failures.get(ip)?.count ?? 0) < 8 && (failures.has(ip) || failures.size < 512);
}

export function recordLoginFailure(req) {
  const ip = req.socket.remoteAddress;
  const entry = failures.get(ip) || { count: 0, until: Date.now() + retryWindow };
  entry.count++;
  failures.set(ip, entry);
}

export function sameOriginMutation(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const expected = new URL(`${secure(req) ? 'https' : 'http'}://${req.headers.host}`);
    return new URL(origin).origin === expected.origin;
  } catch { return false; }
}
