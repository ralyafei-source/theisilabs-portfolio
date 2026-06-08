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

async function ghDelete(path, sha, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ message: `Delete ${path}`, sha });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${path}`,
      method: 'DELETE',
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
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function ghReadRaw(path) {
  return new Promise((resolve) => {
    const url = `https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`;
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function verifyAdmin(sessionToken, githubToken) {
  const usersFile = await ghGet('data/users.json', githubToken);
  const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());
  const user = users.find(u => u.sessionToken === sessionToken && u.isAdmin);
  if (!user || new Date(user.sessionExpiry) < new Date()) return null;
  return { user, users, usersFile };
}

function generateInviteCode() {
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
  const hash = crypto.createHash('sha256');
  const PIN_SALT = process.env.PIN_SALT || 'theisi-pin-salt-v1';
  hash.update(pin + PIN_SALT);
  return hash.digest('hex');
}

function buildPrompt(type, portfolioText, marketText) {
  const today = new Date().toISOString().slice(0, 10);

  if (type === 'daily') return `أنت محلل مالي متخصص في السوق الأمريكي. قدم التحليل كمعلومات فقط وليس توصيات مالية.

بيانات السوق اليوم:
${marketText || 'بيانات السوق غير متاحة'}

محفظة المستثمر:
${portfolioText}

التاريخ: ${today}

قدم تحليلاً يومياً شاملاً بالعربية يتضمن:

═══ DAILY SIGNALS ═══
تقييم كل مركز (شراء قوي / شراء / احتفظ / خفف / بيع) مع السبب
FORMAT: SYMBOL | التوصية | السبب

═══ EARNINGS ═══
الأرباح والأحداث القادمة خلال 2 أسبوع

═══ MACRO ═══
أبرز المؤثرات الاقتصادية الكلية على هذه المحفظة اليوم`;

  if (type === 'weekly') return `أنت محلل مالي متخصص في السوق الأمريكي. قدم التحليل كمعلومات فقط وليس توصيات مالية.

محفظة المستثمر:
${portfolioText}

التاريخ: ${today}

قدم تحليلاً أسبوعياً شاملاً بالعربية يتضمن:

═══ RISK RADAR ═══
تقييم المخاطر لكل مركز

═══ FAIR VALUE ═══
القيمة العادلة لكل سهم

═══ MOMENTUM ═══
تحليل الزخم والاتجاه

═══ SCORING ENGINE ═══
الجزء الأول — أفضل 5 فرص
الجزء الثاني — أعلى 5 مراكز تحتاج مراجعة
الجزء الثالث — جدول الدرجات
الجزء الرابع — ملخص صحة المحفظة`;

  if (type === 'monthly') return `أنت محلل مالي متخصص في السوق الأمريكي. قدم التحليل كمعلومات فقط وليس توصيات مالية.

محفظة المستثمر:
${portfolioText}

التاريخ: ${today}

قدم تحليلاً شهرياً شاملاً بالعربية يتضمن:

═══ COMPETITIVE EDGE ═══
الميزة التنافسية لكل شركة

═══ LONG VIEW ═══
النظرة طويلة المدى 5-10 سنوات

═══ PORTFOLIO HEALTH ═══
صحة المحفظة الشاملة`;

  return '';
}

async function generateAnalysis(nickname, type, githubToken, anthropicKey) {
  // Load portfolio
  const portfolioData = await ghReadRaw(`data/portfolio-${nickname}.json`);
  if (!portfolioData || !portfolioData.stocks || portfolioData.stocks.length === 0) {
    throw new Error(`No portfolio found for ${nickname}`);
  }

  // Format portfolio text
  const lines = portfolioData.stocks.map(s => {
    const val = s.mv || Math.round((s.shares || 0) * (s.price || s.cost || 0));
    const gl = s.gl ? (s.gl >= 0 ? '+' : '') + s.gl.toFixed(1) + '%' : '0%';
    const date = s.purchaseDate ? ` | تاريخ الشراء: ${s.purchaseDate}` : '';
    return `${s.sym}: ${s.shares || 0} سهم | تكلفة $${s.cost || 0} | قيمة $${val.toLocaleString()} | ${gl}${date}`;
  });
  const total = portfolioData.stocks.reduce((a, s) => a + (s.mv || 0), 0);
  lines.push(`الإجمالي: $${total.toLocaleString()}`);
  const portfolioText = lines.join('\n');

  // Load market data (optional)
  const today = new Date().toISOString().slice(0, 10);
  const marketData = await ghReadRaw(`data/market-data-${today}.json`);
  const marketText = marketData ? JSON.stringify(marketData).slice(0, 3000) : '';

  // Build prompt
  const prompt = buildPrompt(type, portfolioText, marketText);

  // Call Claude API
  const claudeBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  });

  const analysisText = await new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(claudeBody)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          if (!text) reject(new Error('Claude error: ' + JSON.stringify(parsed)));
          else resolve(text);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(claudeBody);
    req.end();
  });

  // Save analysis file
  const dateKey = (type === 'weekly' || type === 'monthly') ? today.slice(0, 7) : today;
  const filePath = `data/analysis-${type}-${nickname}-${dateKey}.json`;
  const analysisDoc = {
    type, date: today, nickname,
    content: analysisText,
    generated: new Date().toISOString()
  };

  // Check if exists for SHA
  let sha = null;
  try {
    const existing = await ghGet(filePath, githubToken);
    if (existing && existing.sha) sha = existing.sha;
  } catch(e) {}

  const content = Buffer.from(JSON.stringify(analysisDoc, null, 2)).toString('base64');
  const body = { message: `Generate ${type} analysis for ${nickname}`, content, ...(sha && { sha }) };

  await new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${filePath}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${githubToken}`,
        'User-Agent': 'theisilabs-app',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });

  return filePath;
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
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  try {
    const adminData = await verifyAdmin(sessionToken, githubToken);
    if (!adminData) return res.status(403).json({ error: 'Admin access required' });

    const { users, usersFile } = adminData;

    // ── GET ──
    if (req.method === 'GET') {
      const action = req.query.action;
      if (action === 'codes') {
        const codesFile = await ghGet('data/invite-codes.json', githubToken);
        const codes = JSON.parse(Buffer.from(codesFile.content, 'base64').toString());
        return res.status(200).json({ codes });
      }
      if (action === 'users') {
        const safeUsers = users.map(u => ({
          nickname: u.nickname,
          isAdmin: u.isAdmin || false,
          tier: u.tier || 'fast',               // ← NEW: expose tier (default fast if missing)
          createdAt: u.createdAt,
          failedAttempts: u.failedAttempts || 0,
          lockoutUntil: u.lockoutUntil || null,
          isBlocked: u.isBlocked || false,
          blockReason: u.blockReason || null,
          lastLogin: u.sessionExpiry || null
        }));
        return res.status(200).json({ users: safeUsers });
      }
    }

    // ── POST ──
    if (req.method === 'POST') {
      const { action: bodyAction, nickname, reason, type, tier } = req.body || {};

      if (bodyAction === 'generate-invite') {
        const codesFile = await ghGet('data/invite-codes.json', githubToken);
        const codes = JSON.parse(Buffer.from(codesFile.content, 'base64').toString());
        const newCode = { code: generateInviteCode(), used: false, usedBy: null, usedAt: null, createdAt: new Date().toISOString() };
        codes.push(newCode);
        await ghPut('data/invite-codes.json', codes, codesFile.sha, githubToken);
        return res.status(200).json({ code: newCode.code });
      }

      if (bodyAction === 'reset-pin') {
        if (!nickname) return res.status(400).json({ error: 'Nickname required' });
        const idx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'User not found' });
        const tempPin = generateTempPin();
        users[idx].pinHash = await hashPin(tempPin);
        users[idx].failedAttempts = 0;
        users[idx].lockoutUntil = null;
        users[idx].sessionToken = null;
        users[idx].needsPinSetup = true;
        await ghPut('data/users.json', users, usersFile.sha, githubToken);
        return res.status(200).json({ success: true, tempPin });
      }

      if (bodyAction === 'unlock-user') {
        if (!nickname) return res.status(400).json({ error: 'Nickname required' });
        const idx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'User not found' });
        users[idx].failedAttempts = 0;
        users[idx].lockoutUntil = null;
        await ghPut('data/users.json', users, usersFile.sha, githubToken);
        return res.status(200).json({ success: true });
      }

      if (bodyAction === 'block-user') {
        if (!nickname) return res.status(400).json({ error: 'Nickname required' });
        const idx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'User not found' });
        if (users[idx].isAdmin) return res.status(400).json({ error: 'Cannot block admin' });
        users[idx].isBlocked = true;
        users[idx].blockReason = reason || 'Blocked by admin';
        users[idx].sessionToken = null;
        await ghPut('data/users.json', users, usersFile.sha, githubToken);
        return res.status(200).json({ success: true });
      }

      if (bodyAction === 'unblock-user') {
        if (!nickname) return res.status(400).json({ error: 'Nickname required' });
        const idx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'User not found' });
        users[idx].isBlocked = false;
        users[idx].blockReason = null;
        await ghPut('data/users.json', users, usersFile.sha, githubToken);
        return res.status(200).json({ success: true });
      }

      if (bodyAction === 'delete-user') {
        if (!nickname) return res.status(400).json({ error: 'Nickname required' });
        const idx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'User not found' });
        if (users[idx].isAdmin) return res.status(400).json({ error: 'Cannot delete admin' });
        try {
          const pf = await ghGet(`data/portfolio-${nickname}.json`, githubToken);
          if (pf && pf.sha) await ghDelete(`data/portfolio-${nickname}.json`, pf.sha, githubToken);
        } catch(e) {}
        users.splice(idx, 1);
        await ghPut('data/users.json', users, usersFile.sha, githubToken);
        return res.status(200).json({ success: true });
      }

      // ── NEW: set-tier ──────────────────────────────────────────────────────
      if (bodyAction === 'set-tier') {
        if (!nickname) return res.status(400).json({ error: 'Nickname required' });
        if (!tier || !['fast', 'deep'].includes(tier)) {
          return res.status(400).json({ error: 'tier must be "fast" or "deep"' });
        }
        const idx = users.findIndex(u => u.nickname.toLowerCase() === nickname.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'User not found' });
        users[idx].tier = tier;
        await ghPut('data/users.json', users, usersFile.sha, githubToken);
        return res.status(200).json({ success: true, nickname, tier });
      }
      // ──────────────────────────────────────────────────────────────────────

      if (bodyAction === 'generate-analysis') {
        if (!nickname) return res.status(400).json({ error: 'Nickname required' });
        if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel environment' });
        const analysisType = type || 'daily';
        try {
          const filePath = await generateAnalysis(nickname, analysisType, githubToken, anthropicKey);
          return res.status(200).json({ success: true, type: analysisType, nickname, path: filePath });
        } catch(e) {
          return res.status(500).json({ error: e.message });
        }
      }
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch(e) {
    console.error('admin error:', e);
    return res.status(500).json({ error: e.message });
  }
};
