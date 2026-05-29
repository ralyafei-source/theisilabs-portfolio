const https = require('https');
const crypto = require('crypto');

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

async function ghPut(path, content, sha, token) {
  return new Promise((resolve, reject) => {
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
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Verify session is admin
async function verifyAdmin(sessionToken, githubToken) {
  const usersFile = await ghGet('data/users.json', githubToken);
  const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());
  const user = users.find(u => u.sessionToken === sessionToken && u.isAdmin);
  if (!user || new Date(user.sessionExpiry) < new Date()) return null;
  return { user, users, usersFile };
}

function generateInviteCode() {
  // Format: XXXX-XXXX (8 uppercase chars with dash)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateTempPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function hashPin(pin) {
  // Simple SHA-256 hash with salt (same salt as frontend)
  const hash = crypto.createHash('sha256');
  hash.update(pin + 'theisilabs2026salt');
  return hash.digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization || '';
  const sessionToken = authHeader.replace('Bearer ', '').trim();
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' });

  const githubToken = process.env.GITHUB_TOKEN;

  try {
    const adminData = await verifyAdmin(sessionToken, githubToken);
    if (!adminData) return res.status(403).json({ error: 'Admin access required' });

    const { users, usersFile } = adminData;
    const action = req.query.action;

    // GET: list users or list invite codes
    if (req.method === 'GET') {
      if (action === 'codes') {
        const codesFile = await ghGet('data/invite-codes.json', githubToken);
        const codes = JSON.parse(Buffer.from(codesFile.content, 'base64').toString());
        return res.status(200).json({ codes });
      }

      if (action === 'users') {
        const safeUsers = users.map(u => ({
          nickname: u.nickname,
          isAdmin: u.isAdmin || false,
          createdAt: u.createdAt,
          failedAttempts: u.failedAttempts || 0,
          lockoutUntil: u.lockoutUntil || null,
          lastLogin: u.sessionExpiry || null
        }));
        return res.status(200).json({ users: safeUsers });
      }
    }

    // POST actions
    if (req.method === 'POST') {
      const { action: bodyAction, nickname } = req.body || {};

      // Generate invite code
      if (bodyAction === 'generate-invite') {
        const codesFile = await ghGet('data/invite-codes.json', githubToken);
        const codes = JSON.parse(Buffer.from(codesFile.content, 'base64').toString());

        const newCode = {
          code: generateInviteCode(),
          used: false,
          usedBy: null,
          usedAt: null,
          createdAt: new Date().toISOString()
        };

        codes.push(newCode);
        await ghPut('data/invite-codes.json', codes, codesFile.sha, githubToken);

        return res.status(200).json({ code: newCode.code });
      }

      // Reset user PIN
      if (bodyAction === 'reset-pin') {
        if (!nickname) return res.status(400).json({ error: 'Nickname required' });

        const userIdx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase());
        if (userIdx === -1) return res.status(404).json({ error: 'User not found' });

        const tempPin = generateTempPin();
        const tempPinHash = await hashPin(tempPin);

        users[userIdx].pinHash = tempPinHash;
        users[userIdx].failedAttempts = 0;
        users[userIdx].lockoutUntil = null;
        users[userIdx].sessionToken = null;
        users[userIdx].needsPinSetup = true; // force them to reset on next login

        await ghPut('data/users.json', users, usersFile.sha, githubToken);

        return res.status(200).json({
          success: true,
          tempPin,
          message: `Send this PIN to ${nickname}: ${tempPin}. They must change it on first login.`
        });
      }

      // Unlock user (clear lockout)
      if (bodyAction === 'unlock-user') {
        if (!nickname) return res.status(400).json({ error: 'Nickname required' });

        const userIdx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase());
        if (userIdx === -1) return res.status(404).json({ error: 'User not found' });

        users[userIdx].failedAttempts = 0;
        users[userIdx].lockoutUntil = null;

        await ghPut('data/users.json', users, usersFile.sha, githubToken);
        return res.status(200).json({ success: true });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (e) {
    console.error('admin error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
