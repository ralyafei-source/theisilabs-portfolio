// api/auth.js
// Consolidated auth handler — replaces auth-login.js, auth-signup.js, auth-me.js
// Routes via ?action=login | signup | me

const https = require('https');
const crypto = require('crypto');
const { verifySession } = require('./_auth');   // ← ADD THIS LINE

const REPO = 'ralyafei-source/theisilabs-portfolio';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

// ── GitHub helpers ──
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

// ── Telegram alert ──
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

// ── Helpers ──
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function generateId() { return crypto.randomBytes(8).toString('hex'); }
function getLockoutMinutes(attempts) {
  if (attempts <= 3) return 0;
  return (attempts - 3) * 5;
}

// ══════════════════════════════════════════
// ACTION: LOGIN
// ══════════════════════════════════════════
async function handleLogin(req, res, token) {
  const { nickname, pinHash } = req.body || {};
  if (!nickname || !pinHash) return res.status(400).json({ error: 'Missing nickname or PIN' });

  const usersFile = await ghGet('data/users.json', token);
  const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());

  const userIdx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase().trim());
  if (userIdx === -1) return res.status(401).json({ error: 'Invalid nickname or PIN' });

  const user = users[userIdx];

  // Check lockout
  if (user.lockoutUntil && new Date(user.lockoutUntil) > new Date()) {
    const remainingSeconds = Math.ceil((new Date(user.lockoutUntil) - new Date()) / 1000);
    return res.status(429).json({ error: 'locked', remainingSeconds });
  }

  // First-time PIN setup
  if (user.needsPinSetup) {
    users[userIdx].pinHash = pinHash;
    users[userIdx].needsPinSetup = false;
    users[userIdx].failedAttempts = 0;
    const sessionToken = generateToken();
    users[userIdx].sessionToken = sessionToken;
    users[userIdx].sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await ghPut('data/users.json', users, usersFile.sha, token);
    return res.status(200).json({ token: sessionToken, nickname: user.nickname, isAdmin: user.isAdmin || false, firstLogin: true });
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
    return res.status(401).json({ error: 'Invalid nickname or PIN', attempts, lockoutMinutes: lockoutMins });
  }

  // Correct PIN
  users[userIdx].failedAttempts = 0;
  users[userIdx].lockoutUntil = null;
  const sessionToken = generateToken();
  users[userIdx].sessionToken = sessionToken;
  users[userIdx].sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await ghPut('data/users.json', users, usersFile.sha, token);
  return res.status(200).json({ token: sessionToken, nickname: user.nickname, isAdmin: user.isAdmin || false });
}

// ══════════════════════════════════════════
// ACTION: SIGNUP
// ══════════════════════════════════════════
async function handleSignup(req, res, token) {
  const { inviteCode, nickname, pinHash } = req.body || {};
  if (!inviteCode || !nickname || !pinHash) return res.status(400).json({ error: 'Missing required fields' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(nickname)) return res.status(400).json({ error: 'Nickname must be 3-20 characters, letters/numbers/underscores only' });

  const codesFile = await ghGet('data/invite-codes.json', token);
  const codes = JSON.parse(Buffer.from(codesFile.content, 'base64').toString());
  const codeIdx = codes.findIndex(c => c.code.toUpperCase() === inviteCode.toUpperCase().trim() && !c.used);
  if (codeIdx === -1) return res.status(400).json({ error: 'Invalid or already used invite code' });

  const usersFile = await ghGet('data/users.json', token);
  const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());
  if (users.some(u => u.nickname.toLowerCase() === nickname.toLowerCase().trim())) {
    return res.status(400).json({ error: 'Nickname already taken — please choose another' });
  }

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
  codes[codeIdx].used = true;
  codes[codeIdx].usedBy = nickname.toLowerCase().trim();
  codes[codeIdx].usedAt = new Date().toISOString();

  await ghPut('data/users.json', users, usersFile.sha, token);
  await ghPut('data/invite-codes.json', codes, codesFile.sha, token);

  try {
    await ghCreate(`data/portfolio-${nickname.toLowerCase().trim()}.json`, {
      nickname: nickname.toLowerCase().trim(), stocks: [], lastUpdated: new Date().toISOString()
    }, token);
  } catch(e) { /* non-fatal */ }

  return res.status(200).json({ token: sessionToken, nickname: newUser.nickname, isAdmin: false });
}

// ══════════════════════════════════════════
// ACTION: ME (session check)
// ══════════════════════════════════════════
async function handleMe(req, res, token) {
  const authHeader = req.headers.authorization || '';
  const sessionToken = authHeader.replace('Bearer ', '').trim();
  if (!sessionToken) return res.status(401).json({ error: 'No session token' });
  const usersFile = await ghGet('data/users.json', token);
  const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());
  const user = users.find(u => u.sessionToken === sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  if (new Date(user.sessionExpiry) < new Date()) return res.status(401).json({ error: 'Session expired' });
  return res.status(200).json({ nickname: user.nickname, isAdmin: user.isAdmin || false, portfolioFile: user.portfolioFile || null, telegram_chat_id: user.telegram_chat_id || null });
}

// ── SET TELEGRAM (Session 29): save/clear the user's Telegram chat id ──────
// POST ?action=set-telegram  body: { telegram_chat_id: "1234567" | "" }
// Auth: the user's own session token. On save, sends a TEST message so the
// user knows instantly whether the link works (bot must be started first).
async function handleSetTelegram(req, res, token) {
  const authHeader = req.headers.authorization || '';
  const sessionToken = authHeader.replace('Bearer ', '').trim();
  if (!sessionToken) return res.status(401).json({ error: 'No session token' });

  const raw = (req.body && req.body.telegram_chat_id != null) ? String(req.body.telegram_chat_id).trim() : '';
  if (raw && !/^-?\d{5,15}$/.test(raw)) {
    return res.status(400).json({ error: 'invalid_chat_id', message_ar: 'معرّف المحادثة يجب أن يكون أرقاماً فقط (مثال: 1365815413)' });
  }

  const usersFile = await ghGet('data/users.json', token);
  const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());
  const user = users.find(u => u.sessionToken === sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  if (new Date(user.sessionExpiry) < new Date()) return res.status(401).json({ error: 'Session expired' });

  if (raw) user.telegram_chat_id = raw;
  else delete user.telegram_chat_id;

  await ghPut('data/users.json', users, usersFile.sha, token);

  // Test message — proves the link end-to-end (requires user to have started the bot)
  let tested = null, test_error = null;
  if (raw && TELEGRAM_TOKEN) {
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: raw,
          parse_mode: 'HTML',
          text: `✅ <b>تم ربط حسابك بنجاح يا ${user.nickname}!</b>\n\nستصلك نشرة THEISI الصباحية هنا كل يوم الساعة 7:00 صباحاً بتوقيت الإمارات. 📊`,
        }),
      });
      const tgData = await tgRes.json();
      tested = !!tgData.ok;
      if (!tgData.ok) test_error = tgData.description || `telegram ${tgRes.status}`;
    } catch (e) { tested = false; test_error = e.message; }
  }
  return res.status(200).json({ ok: true, telegram_chat_id: raw || null, tested, test_error });
}

// ══════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const githubToken = process.env.GITHUB_TOKEN;

  try {
    if (action === 'login' && req.method === 'POST') return await handleLogin(req, res, githubToken);
    if (action === 'signup' && req.method === 'POST') return await handleSignup(req, res, githubToken);
    if (action === 'me' && req.method === 'GET') return await handleMe(req, res, githubToken);
    if (action === 'set-telegram' && req.method === 'POST') return await handleSetTelegram(req, res, githubToken);
    return res.status(400).json({ error: 'Unknown action. Use ?action=login|signup|me' });
  } catch(e) {
    console.error('auth error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
