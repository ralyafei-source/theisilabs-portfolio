// api/_auth.js
// ── Shared session-validation helper ──
// Used by auth.js and any endpoint that needs to verify a login token.
// Accepts: the request object + a GitHub token (process.env.GITHUB_TOKEN)
// Returns: the user object if valid, or null if invalid/expired.

const https = require('https');
const REPO = 'ralyafei-source/theisilabs-portfolio';

async function ghGet(path, token) {
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

// Returns the authenticated user object, or null if token is missing/invalid/expired.
async function verifySession(req, githubToken) {
  const authHeader = req.headers.authorization || '';
  const sessionToken = authHeader.replace('Bearer ', '').trim();
  if (!sessionToken) return null;
  try {
    const usersFile = await ghGet('data/users.json', githubToken);
    const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());
    const user = users.find(u => u.sessionToken === sessionToken);
    if (!user) return null;
    if (new Date(user.sessionExpiry) < new Date()) return null;
    return user; // { nickname, isAdmin, portfolioFile, telegram_chat_id, ... }
  } catch(e) {
    console.error('verifySession error:', e);
    return null;
  }
}

module.exports = { verifySession };
