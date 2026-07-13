// api/auth.js
// Consolidated auth handler — replaces auth-login.js, auth-signup.js, auth-me.js
// Routes via ?action=login | signup | me | set-telegram

const crypto = require('crypto');

const REPO = 'ralyafei-source/theisilabs-portfolio';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

// ══════════════════════════════════════════
// GitHub helpers (fetch-based, fail loudly)
// ══════════════════════════════════════════
const GH_HEADERS = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'theisilabs-app'
});

async function ghFetch(path, token, init = {}) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const r = await fetch(url, {
    ...init,
    headers: { ...GH_HEADERS(token), ...(init.headers || {}) }
  });
  const text = await r.text();

  if (!r.ok) {
    console.error('GitHub API error', r.status, path, text.slice(0, 300));
    throw new Error(`GitHub ${r.status} on ${path}: ${text.slice(0, 120)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('GitHub non-JSON response', path, text.slice(0, 300));
    throw new Error(`GitHub returned non-JSON on ${path}`);
  }
}

async function ghGet(path, token) {
  return ghFetch(`${path}?ref=main`, token);
}

async function ghPut(path, content, sha, token) {
  return ghFetch(path, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Update ${path}`,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
      ...(sha ? { sha } : {})
    })
  });
}

async function ghCreate(path, content, token) {
  return ghPut(path, content, null, token);
}

// Decode a contents-API payload into an object
function ghDecode(file) {
  if (!file || !file.content) throw new Error('GitHub file payload missing content');
  return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
}

// ══════════════════════════════════════════
// Telegram alert
// ══════════════════════════════════════════
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('telegram alert failed:', e.message);
  }
}

// ══════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function generateId() { return crypto.randomBytes(8).toString('hex'); }
function getLockoutMinutes(attempts) {
  if (attempts <= 3) return 0;
  return (attempts - 3) * 5;
}
function newSession() {
  return {
    sessionToken: generateToken(),
    sessionExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };
}
function pushSession(user, session) {
  user.sessions = (user.sessions || []).filter(s => new Date(s.sessionExpiry) > new Date());
  user.sessions.push(session);
  while (user.sessions.length > 3) user.sessions.shift();
}
// Resolve the caller's session token -> user object (or null)
function findBySession(users, sessionToken) {
  const user = users.find(u => (u.sessions || []).some(s => s.sessionToken === sessionToken));
  if (!user) return null;
  const session = user.sessions.find(s => s.sessionToken === sessionToken);
  if (new Date(session.sessionExpiry) < new Date()) return null;
  return user;
}
function bearer(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

// ══════════════════════════════════════════
// ACTION: LOGIN
// ══════════════════════════════════════════
async function handleLogin(req, res, token) {
  const { nickname, pinHash } = req.body || {};
  if (!nickname || !pinHash) return res.status(400).json({ error: 'Missing nickname or PIN' });

  const usersFile = await ghGet('data/users.json', token);
  const users = ghDecode(usersFile);

  const userIdx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase().trim());
  if (userIdx === -1) return res.status(401).json({ error: 'Invalid nickname or PIN' });
  const user = users[userIdx];

  // Lockout
  if (user.lockoutUntil && new Date(user.lockoutUntil) > new Date()) {
    const remainingSeconds = Math.ceil((new Date(user.lockoutUntil) - new Date()) / 1000);
    return res.status(429).json({ error: 'locked', remainingSeconds });
  }

  // First-time PIN setup
  if (user.needsPinSetup) {
    user.pinHash = pinHash;
    user.needsPinSetup = false;
    user.failedAttempts = 0;
    user.lockoutUntil = null;
    const session = newSession();
    pushSession(user, session);
    await ghPut('data/users.json', users, usersFile.sha, token);
    return res.status(200).json({
      token: session.sessionToken,
      nickname: user.nickname,
      isAdmin: user.isAdmin || false,
      firstLogin: true
    });
  }

  // Wrong PIN
  if (user.pinHash !== pinHash) {
    user.failedAttempts = (user.failedAttempts || 0) + 1;
    const attempts = user.failedAttempts;
    const lockoutMins = getLockoutMinutes(attempts);
    if (lockoutMins > 0) {
      user.lockoutUntil = new Date(Date.now() + lockoutMins * 60 * 1000).toISOString();
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
  user.failedAttempts = 0;
  user.lockoutUntil = null;
  const session = newSession();
  pushSession(user, session);
  await ghPut('data/users.json', users, usersFile.sha, token);

  return res.status(200).json({
    token: session.sessionToken,
    nickname: user.nickname,
    isAdmin: user.isAdmin || false
  });
}

// ══════════════════════════════════════════
// ACTION: SIGNUP
// ══════════════════════════════════════════
async function handleSignup(req, res, token) {
  const { inviteCode, nickname, pinHash } = req.body || {};
  if (!inviteCode || !nickname || !pinHash) return res.status(400).json({ error: 'Missing required fields' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(nickname)) {
    return res.status(400).json({ error: 'Nickname must be 3-20 characters, letters/numbers/underscores only' });
  }

  const codesFile = await ghGet('data/invite-codes.json', token);
  const codes = ghDecode(codesFile);

  const codeIdx = codes.findIndex(c =>
    c.code.toUpperCase() === inviteCode.toUpperCase().trim() && !c.used
  );
  if (codeIdx === -1) return res.status(400).json({ error: 'Invalid or already used invite code' });

  const usersFile = await ghGet('data/users.json', token);
  const users = ghDecode(usersFile);

  const nick = nickname.toLowerCase().trim();
  if (users.some(u => u.nickname.toLowerCase() === nick)) {
    return res.status(400).json({ error: 'Nickname already taken — please choose another' });
  }

  const session = newSession();
  const newUser = {
    id: generateId(),
    nickname: nick,
    pinHash,
    needsPinSetup: false,
    sessions: [session],
    failedAttempts: 0,
    lockoutUntil: null,
    isAdmin: false,
    portfolioFile: `portfolio-${nick}.json`,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  codes[codeIdx].used = true;
  codes[codeIdx].usedBy = nick;
  codes[codeIdx].usedAt = new Date().toISOString();

  await ghPut('data/users.json', users, usersFile.sha, token);
  await ghPut('data/invite-codes.json', codes, codesFile.sha, token);

  try {
    await ghCreate(`data/portfolio-${nick}.json`, {
      nickname: nick,
      stocks: [],
      lastUpdated: new Date().toISOString()
    }, token);
  } catch (e) {
    console.error('portfolio create failed (non-fatal):', e.message);
  }

  return res.status(200).json({ token: session.sessionToken, nickname: nick, isAdmin: false });
}

// ══════════════════════════════════════════
// ACTION: ME (session check)
// ══════════════════════════════════════════
async function handleMe(req, res, token) {
  const sessionToken = bearer(req);
  if (!sessionToken) return res.status(401).json({ error: 'No session token' });

  const usersFile = await ghGet('data/users.json', token);
  const users = ghDecode(usersFile);

  const user = findBySession(users, sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

  return res.status(200).json({
    nickname: user.nickname,
    isAdmin: user.isAdmin || false,
    portfolioFile: user.portfolioFile || null,
    telegram_chat_id: user.telegram_chat_id || null
  });
}

// ══════════════════════════════════════════
// ACTION: SET-TELEGRAM
// POST ?action=set-telegram  body: { telegram_chat_id: "1234567" | "" }
// ══════════════════════════════════════════
async function handleSetTelegram(req, res, token) {
  const sessionToken = bearer(req);
  if (!sessionToken) return res.status(401).json({ error: 'No session token' });

  const raw = (req.body && req.body.telegram_chat_id != null)
    ? String(req.body.telegram_chat_id).trim()
    : '';

  if (raw && !/^-?\d{5,15}$/.test(raw)) {
    return res.status(400).json({
      error: 'invalid_chat_id',
      message_ar: 'معرّف المحادثة يجب أن يكون أرقاماً فقط (مثال: 1365815413)'
    });
  }

  const usersFile = await ghGet('data/users.json', token);
  const users = ghDecode(usersFile);

  const user = findBySession(users, sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

  if (raw) user.telegram_chat_id = raw;
  else delete user.telegram_chat_id;

  await ghPut('data/users.json', users, usersFile.sha, token);

  // Test message — proves the link end-to-end (user must have started the bot)
  let tested = null, test_error = null;
  if (raw && TELEGRAM_TOKEN) {
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: raw,
          parse_mode: 'HTML',
          text: `✅ <b>تم ربط حسابك بنجاح يا ${user.nickname}!</b>\n\nستصلك نشرة THEISI الصباحية هنا كل يوم الساعة 7:00 صباحاً بتوقيت الإمارات. 📊`
        })
      });
      const tgData = await tgRes.json();
      tested = !!tgData.ok;
      if (!tgData.ok) test_error = tgData.description || `telegram ${tgRes.status}`;
    } catch (e) {
      tested = false;
      test_error = e.message;
    }
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

  if (!githubToken) {
    console.error('GITHUB_TOKEN is not set in this environment');
    return res.status(500).json({ error: 'Server misconfigured: GITHUB_TOKEN not set' });
  }

  try {
    if (action === 'login' && req.method === 'POST') return await handleLogin(req, res, githubToken);
    if (action === 'signup' && req.method === 'POST') return await handleSignup(req, res, githubToken);
    if (action === 'me' && req.method === 'GET') return await handleMe(req, res, githubToken);
    if (action === 'set-telegram' && req.method === 'POST') return await handleSetTelegram(req, res, githubToken);
    return res.status(400).json({ error: 'Unknown action. Use ?action=login|signup|me|set-telegram' });
  } catch (e) {
    console.error('auth error:', e);
    return res.status(500).json({ error: 'Server error', detail: e.message });
  }
};
