// api/_auth.js
// Shared session-validation helper.
// Used by any endpoint that needs to verify a login token.
// Returns the user object if valid, or null if invalid/expired.
//
// Sliding session: each time a valid token is used, its expiry is rolled
// forward, so an active user is never logged out. The write is throttled
// (only when the expiry would move by ~a day or more) to avoid GitHub churn.

const https = require('https');
const { tokenHash, findSession } = require('./_lib/pin');
const REPO = 'ralyafei-source/theisilabs-portfolio';

const SESSION_DAYS       = 90;
const SESSION_MS         = SESSION_DAYS * 24 * 60 * 60 * 1000;
const RENEW_IF_UNDER_MS  = SESSION_MS - 24 * 60 * 60 * 1000;   // renew at most ~once/day

function ghGet(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${path}`,
      headers: { 'Authorization': `token ${token}`, 'User-Agent': 'theisilabs-app' }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function ghPut(path, content, sha, token) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      message: `Update ${path}`,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
      sha
    });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${path}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'theisilabs-app',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));   // renewal failure must never block a valid request
    req.write(body);
    req.end();
  });
}

async function verifySession(req, githubToken) {
  const authHeader = req.headers.authorization || '';
  const sessionToken = authHeader.replace('Bearer ', '').trim();
  if (!sessionToken) return null;
  try {
    const usersFile = await ghGet('data/users.json', githubToken);
    const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());
    let user = null, session = null;
    for (const u of users) {
      const s = findSession(u, sessionToken);
      if (s) { user = u; session = s; break; }
    }
    if (!user) return null;

    // ── Sliding renewal — keeps active users signed in indefinitely ──
    try {
      const remaining = new Date(session.sessionExpiry) - new Date();
      if (remaining < RENEW_IF_UNDER_MS) {
        session.sessionExpiry = new Date(Date.now() + SESSION_MS).toISOString();
        await ghPut('data/users.json', users, usersFile.sha, githubToken);
      }
    } catch (e) { /* non-fatal — session already validated above */ }

    return user;
  } catch(e) {
    console.error('verifySession error:', e);
    return null;
  }
}

module.exports = { verifySession };
