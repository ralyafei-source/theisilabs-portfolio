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

async function ghCreate(path, content, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message: `Create ${path}`,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64')
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

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  const { inviteCode, nickname, pinHash } = req.body || {};

  if (!inviteCode || !nickname || !pinHash) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate nickname format: 3-20 chars, letters/numbers/underscores only
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(nickname)) {
    return res.status(400).json({ error: 'Nickname must be 3-20 characters, letters/numbers/underscores only' });
  }

  try {
    // Load invite codes
    const codesFile = await ghGet('data/invite-codes.json', token);
    const codes = JSON.parse(Buffer.from(codesFile.content, 'base64').toString());

    // Find and validate invite code
    const codeIdx = codes.findIndex(c =>
      c.code.toUpperCase() === inviteCode.toUpperCase().trim() && !c.used
    );

    if (codeIdx === -1) {
      return res.status(400).json({ error: 'Invalid or already used invite code' });
    }

    // Load users
    const usersFile = await ghGet('data/users.json', token);
    const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());

    // Check nickname not taken
    const nicknameExists = users.some(u => u.nickname.toLowerCase() === nickname.toLowerCase().trim());
    if (nicknameExists) {
      return res.status(400).json({ error: 'Nickname already taken — please choose another' });
    }

    // Create new user
    const sessionToken = generateToken();
    const newUser = {
      id: generateId(),
      nickname: nickname.toLowerCase().trim(),
      pinHash,
      needsPinSetup: false,
      sessionToken,
      sessionExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      failedAttempts: 0,
      lockoutUntil: null,
      isAdmin: false,
      portfolioFile: `portfolio-${nickname.toLowerCase().trim()}.json`,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);

    // Mark invite code as used
    codes[codeIdx].used = true;
    codes[codeIdx].usedBy = nickname.toLowerCase().trim();
    codes[codeIdx].usedAt = new Date().toISOString();

    // Create empty portfolio file for new user
    const emptyPortfolio = {
      nickname: nickname.toLowerCase().trim(),
      stocks: [],
      lastUpdated: new Date().toISOString()
    };

    // Save all changes
    await ghPut('data/users.json', users, usersFile.sha, token);
    await ghPut('data/invite-codes.json', codes, codesFile.sha, token);

    // Try to create portfolio file (ignore if fails — will be created on first save)
    try {
      await ghCreate(`data/portfolio-${nickname.toLowerCase().trim()}.json`, emptyPortfolio, token);
    } catch (e) {
      // Non-fatal — portfolio file creation can be retried
    }

    return res.status(200).json({
      token: sessionToken,
      nickname: newUser.nickname,
      isAdmin: false
    });

  } catch (e) {
    console.error('auth-signup error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
