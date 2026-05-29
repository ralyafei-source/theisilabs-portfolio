const https = require('https');
const crypto = require('crypto');

const REPO = 'ralyafei-source/theisilabs-portfolio';
const TELEGRAM_TOKEN = '8644558518:AAFMViTWxCm-mS5x8g9emnI-iDkAmH7iIzs';
const ADMIN_CHAT_ID = '1365815413';

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

async function sendTelegram(message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: message, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getLockoutMinutes(attempts) {
  // 3 free attempts, then multiples of 5
  if (attempts <= 3) return 0;
  return (attempts - 3) * 5;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  const { nickname, pinHash } = req.body || {};

  if (!nickname || !pinHash) return res.status(400).json({ error: 'Missing nickname or PIN' });

  try {
    const usersFile = await ghGet('data/users.json', token);
    const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());

    const userIdx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase().trim());
    if (userIdx === -1) {
      return res.status(401).json({ error: 'Invalid nickname or PIN' });
    }

    const user = users[userIdx];

    // Check lockout
    if (user.lockoutUntil && new Date(user.lockoutUntil) > new Date()) {
      const remainingSeconds = Math.ceil((new Date(user.lockoutUntil) - new Date()) / 1000);
      return res.status(429).json({ error: 'locked', remainingSeconds });
    }

    // First-time PIN setup (admin account with no PIN yet)
    if (user.needsPinSetup) {
      users[userIdx].pinHash = pinHash;
      users[userIdx].needsPinSetup = false;
      users[userIdx].failedAttempts = 0;
      const sessionToken = generateToken();
      users[userIdx].sessionToken = sessionToken;
      users[userIdx].sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await ghPut('data/users.json', users, usersFile.sha, token);
      return res.status(200).json({
        token: sessionToken,
        nickname: user.nickname,
        isAdmin: user.isAdmin || false,
        firstLogin: true
      });
    }

    // Wrong PIN
    if (user.pinHash !== pinHash) {
      users[userIdx].failedAttempts = (user.failedAttempts || 0) + 1;
      const attempts = users[userIdx].failedAttempts;
      const lockoutMins = getLockoutMinutes(attempts);

      if (lockoutMins > 0) {
        users[userIdx].lockoutUntil = new Date(Date.now() + lockoutMins * 60 * 1000).toISOString();
      }

      await ghPut('data/users.json', users, usersFile.sha, token);

      // Telegram alert from 3rd attempt onwards
      if (attempts >= 3) {
        const uaeTime = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' });
        await sendTelegram(
          `🚨 <b>Security Alert — Failed Login</b>\n\n` +
          `👤 Nickname: <b>${nickname}</b>\n` +
          `❌ Failed attempts: <b>${attempts}</b>\n` +
          `⏳ Lockout: <b>${lockoutMins > 0 ? lockoutMins + ' minutes' : 'none yet'}</b>\n` +
          `🕐 Time: ${uaeTime} (UAE)`
        );
      }

      return res.status(401).json({
        error: 'Invalid nickname or PIN',
        attempts,
        lockoutMinutes: lockoutMins
      });
    }

    // Correct PIN — create session
    users[userIdx].failedAttempts = 0;
    users[userIdx].lockoutUntil = null;
    const sessionToken = generateToken();
    users[userIdx].sessionToken = sessionToken;
    users[userIdx].sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await ghPut('data/users.json', users, usersFile.sha, token);

    return res.status(200).json({
      token: sessionToken,
      nickname: user.nickname,
      isAdmin: user.isAdmin || false
    });

  } catch (e) {
    console.error('auth-login error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
