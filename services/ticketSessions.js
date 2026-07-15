const crypto = require('crypto');
const { getPool, isDatabaseEnabled } = require('../db');

const COOKIE_NAME = 'aesop_ticket_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCookie(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === COOKIE_NAME) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return '';
}

async function createTicketSession(personId) {
  if (!isDatabaseEnabled() || !getPool()) throw new Error('Ticket sessions require the database.');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getPool().query(
    `INSERT INTO portal_ticket_sessions (token_hash, person_id, expires_at)
     VALUES ($1,$2,$3)`,
    [tokenHash(token), personId, expiresAt],
  );
  return { token, expiresAt };
}

function setTicketSessionCookie(res, session) {
  const secure = Boolean(process.env.FLY_APP_NAME || /^https:/i.test(process.env.PORTAL_BASE_URL || process.env.BASE_URL || '')) ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

async function revokeTicketSession(req, res) {
  const token = readCookie(req);
  if (/^[a-f0-9]{64}$/.test(token) && isDatabaseEnabled() && getPool()) {
    await getPool().query('DELETE FROM portal_ticket_sessions WHERE token_hash=$1', [tokenHash(token)]);
  }
  const secure = Boolean(process.env.FLY_APP_NAME || /^https:/i.test(process.env.PORTAL_BASE_URL || process.env.BASE_URL || '')) ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

async function getTicketSessionPerson(req) {
  const token = readCookie(req);
  if (!/^[a-f0-9]{64}$/.test(token) || !isDatabaseEnabled() || !getPool()) return null;
  const result = await getPool().query(
    `SELECT p.id, p.aesop_id, p.email, p.name, p.portal_role, p.admin_role
       FROM portal_ticket_sessions s
       JOIN people p ON p.id=s.person_id
      WHERE s.token_hash=$1 AND s.expires_at>NOW()
      LIMIT 1`,
    [tokenHash(token)],
  );
  return result.rows[0] || null;
}

module.exports = { createTicketSession, setTicketSessionCookie, getTicketSessionPerson, revokeTicketSession };
