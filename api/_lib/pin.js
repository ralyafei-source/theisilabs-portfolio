// api/_lib/pin.js
// Credential helpers for THEISI auth.
//
// WHY THIS EXISTS
// ---------------
// data/users.json lives in a PUBLIC repo (the dashboard and 15 API files read it
// over unauthenticated raw.githubusercontent.com, so it cannot be made private).
// Before this module, that file stored:
//
//   pinHash      = SHA-256(pin + PIN_SALT), computed IN THE BROWSER and compared
//                  literally by the server. The stored value WAS the credential:
//                  replay it to /api/auth?action=login and you get a session.
//                  PIN_SALT is a constant in index.html, and the PIN space is
//                  10^4..10^6, so the PIN itself fell out in milliseconds too.
//   sessionToken = the raw bearer token, in plaintext.
//
// Now the file stores VERIFIERS only:
//
//   pinVerifier      = HMAC-SHA256(PIN_PEPPER, nickname + ':' + clientPinHash)
//   sessions[].tokenHash = SHA-256(rawToken)
//
// PIN_PEPPER is a server-only env var. Without it a reader of the public file
// can neither replay a value nor brute-force the PIN: the search space is the
// 256-bit pepper, not the 4-6 digit PIN. Raw session tokens are never stored, so
// a leaked file yields no usable bearer token either.
//
// The browser still sends SHA-256(pin + PIN_SALT) exactly as before — index.html
// needs NO change. The peppering happens entirely server-side.

const crypto = require('crypto');

const PEPPER = process.env.PIN_PEPPER || '';
const VERSION = 'v2:';

/** True when the server is configured to verify PINs at all. */
function pepperReady() {
  return typeof PEPPER === 'string' && PEPPER.length >= 32;
}

/**
 * Derive the stored verifier from the hash the browser sends.
 * @param {string} nickname      user's nickname (case-insensitive)
 * @param {string} clientPinHash SHA-256(pin + PIN_SALT) from index.html
 * @returns {string} 'v2:<hex>'
 */
function pinVerifier(nickname, clientPinHash) {
  if (!pepperReady()) {
    throw new Error('PIN_PEPPER is not set (needs >=32 chars) — refusing to verify PINs');
  }
  const material = String(nickname || '').toLowerCase().trim() + ':' + String(clientPinHash || '');
  return VERSION + crypto.createHmac('sha256', PEPPER).update(material).digest('hex');
}

/** Hash a raw session token for storage. Tokens are 256-bit random, so no pepper. */
function tokenHash(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length === 0 || A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/**
 * Verify a login attempt against a stored user record.
 * Legacy `pinHash` values are NEVER accepted — they were public, so every one
 * of them is considered compromised. Such a user must go through PIN setup.
 */
function checkPin(user, clientPinHash) {
  if (!user || !user.pinVerifier) return false;
  return safeEqual(user.pinVerifier, pinVerifier(user.nickname, clientPinHash));
}

/** Find the live session matching a raw bearer token, or null. */
function findSession(user, rawToken) {
  const h = tokenHash(rawToken);
  const s = (user && Array.isArray(user.sessions) ? user.sessions : [])
    .find(x => x && typeof x.tokenHash === 'string' && safeEqual(x.tokenHash, h));
  if (!s) return null;
  if (new Date(s.sessionExpiry) < new Date()) return null;
  return s;
}

module.exports = { pinVerifier, tokenHash, safeEqual, checkPin, findSession, pepperReady };
