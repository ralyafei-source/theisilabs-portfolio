const https = require('https');

const REPO = 'ralyafei-source/theisilabs-portfolio';

// ── Profile field whitelist (extend here to add fields later) ──────────────
const PROFILE_FIELDS = ['riskTolerance', 'timeHorizon', 'cashToInvest', 'goals', 'constraints', 'notes'];
const RISK_VALUES    = ['low', 'medium', 'high'];
const HORIZON_VALUES = ['short', 'medium', 'long'];
const TEXT_CAPS      = { goals: 280, constraints: 280, notes: 1000 };
const SAVE_COOLDOWN_MS = 5000;

// Validate + normalize an incoming profile patch.
//  → { ok:true, patch, clears }  (patch = keys to set; clears = keys to delete)
//  → { ok:false, message }       (bad enum/number; reject whole save)
// Unknown keys are silently dropped; empty-string text/cash clears the field.
function validateProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Invalid profile' };
  }
  const patch = {};
  const clears = [];
  for (const key of PROFILE_FIELDS) {          // unknown keys never enter the loop → dropped
    if (!(key in input)) continue;
    let v = input[key];
    if (key === 'riskTolerance' || key === 'timeHorizon') {
      if (typeof v !== 'string') return { ok: false, message: `${key} must be a string` };
      v = v.toLowerCase().trim();
      if (v === '') { clears.push(key); continue; }
      const allowed = key === 'riskTolerance' ? RISK_VALUES : HORIZON_VALUES;
      if (!allowed.includes(v)) return { ok: false, message: `${key} must be one of: ${allowed.join(', ')}` };
      patch[key] = v;
    } else if (key === 'cashToInvest') {
      if (v === '' || v === null) { clears.push(key); continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n >= 1e12) {
        return { ok: false, message: 'cashToInvest must be a number between 0 and 1,000,000,000,000' };
      }
      patch[key] = n;
    } else {                                    // goals | constraints | notes
      if (typeof v !== 'string') return { ok: false, message: `${key} must be text` };
      v = v.trim();
      if (v === '') { clears.push(key); continue; }
      patch[key] = v.slice(0, TEXT_CAPS[key]);  // over-cap → truncate (not an error)
    }
  }
  return { ok: true, patch, clears };
}

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
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.defineProperty(parsed, '_statusCode', { value: res.statusCode, enumerable: false });
          }
          resolve(parsed);
        } catch (e) { reject(e); }
      });
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
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.defineProperty(parsed, '_statusCode', { value: res.statusCode, enumerable: false });
          }
          resolve(parsed);
        } catch (e) { reject(e); }
      });
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
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.defineProperty(parsed, '_statusCode', { value: res.statusCode, enumerable: false });
          }
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Verify session token
async function verifySession(sessionToken, githubToken) {
  const usersFile = await ghGet('data/users.json', githubToken);
  const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());
  const user = users.find(u => u.sessionToken === sessionToken);
  if (!user || new Date(user.sessionExpiry) < new Date()) return null;
  return user;
}

// List files in a repo directory
async function ghList(path, token) {
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
    const user = await verifySession(sessionToken, githubToken);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    const portfolioFile = user.portfolioFile || `portfolio-${user.nickname}.json`;
    const filePath = `data/${portfolioFile}`;

    // ── GET: load user's portfolio ──
    if (req.method === 'GET') {

      // ── top-tickers: count most common stocks across all user portfolios ──
      if (req.query && req.query.action === 'top-tickers') {
        if (!user.isAdmin) return res.status(403).json({ error: 'Admin only' });
        try {
          const files = await ghList('data', githubToken);
          const portfolioFiles = Array.isArray(files)
            ? files.filter(f => f.name && f.name.match(/^portfolio(-[a-z0-9_]+)?\.json$/))
            : [];
          const tickerCount = {};
          await Promise.all(portfolioFiles.map(async f => {
            try {
              const pf = await ghGet(`data/${f.name}`, githubToken);
              const data = JSON.parse(Buffer.from(pf.content, 'base64').toString());
              // Support both schemas: holdings[] (admin) and stocks[] (users)
              const items = data.holdings || data.stocks || [];
              const seen = new Set();
              items.forEach(item => {
                const sym = (item.sym || item.symbol || '').toUpperCase().trim();
                if (sym && !seen.has(sym)) {
                  seen.add(sym);
                  tickerCount[sym] = (tickerCount[sym] || 0) + 1;
                }
              });
            } catch(e) { /* skip unreadable files */ }
          }));
          const top10 = Object.entries(tickerCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([sym]) => sym);
          return res.status(200).json({ tickers: top10, computed: new Date().toISOString() });
        } catch(e) {
          return res.status(500).json({ error: 'Failed to compute top tickers', detail: e.message });
        }
      }
      // Admin (rashed) gets portfolio.json which is already managed separately
      if (user.isAdmin && portfolioFile === 'portfolio.json') {
        try {
          const pf = await ghGet('data/portfolio.json', githubToken);
          const data = JSON.parse(Buffer.from(pf.content, 'base64').toString());
          return res.status(200).json({ portfolio: data, isAdmin: true });
        } catch(e) {
          return res.status(200).json({ portfolio: { stocks: [] }, isAdmin: true });
        }
      }

      // Regular user — get their portfolio file
      try {
        const pf = await ghGet(filePath, githubToken);
        const data = JSON.parse(Buffer.from(pf.content, 'base64').toString());
        return res.status(200).json({ portfolio: data, isAdmin: false });
      } catch(e) {
        // File doesn't exist yet — return empty
        return res.status(200).json({
          portfolio: { nickname: user.nickname, stocks: [], lastUpdated: null },
          isAdmin: false
        });
      }
    }

    // ── POST: save portfolio (stocks and/or profile) — read-modify-write ──
    if (req.method === 'POST') {
      try {
        const body = req.body || {};
        const hasProfile = body.profile != null && typeof body.profile === 'object';
        const hasStocks  = Array.isArray(body.stocks);
        if (!hasProfile && !hasStocks) {
          return res.status(400).json({ ok: false, message: 'Nothing to save', error: 'Nothing to save' });
        }

        // Validate up front — reject the whole save on bad enum/number
        let profilePatch = {}, profileClears = [];
        if (hasProfile) {
          const v = validateProfile(body.profile);
          if (!v.ok) return res.status(400).json({ ok: false, message: v.message, error: v.message });
          profilePatch = v.patch; profileClears = v.clears;
        }
        let cleanStocks = null;
        if (hasStocks) {
          cleanStocks = body.stocks
            .filter(s => s.sym && s.shares > 0 && s.cost > 0)
            .map(s => ({
              sym: s.sym.toUpperCase().trim(),
              en: s.en || s.sym.toUpperCase().trim(),
              ar: s.ar || s.sym.toUpperCase().trim(),
              shares: parseFloat(s.shares),
              cost: parseFloat(s.cost),
              price: parseFloat(s.cost),
              mv: Math.round(parseFloat(s.shares) * parseFloat(s.cost)),
              gl: 0,
              sec: s.sec || 'tech'
            }));
        }

        // Apply validated change onto a freshly-read file object (re-run each retry)
        const applyMerge = (fileObj) => {
          const isHoldings = Array.isArray(fileObj.holdings);
          if (hasStocks && isHoldings) {
            return { refuse: "Stock edits aren't supported here — use the holdings tools" };
          }
          if (hasProfile) {
            const merged = { ...(fileObj.profile || {}), ...profilePatch };
            for (const k of profileClears) delete merged[k];
            fileObj.profile = merged;
            fileObj.profileUpdatedAt = new Date().toISOString();
          }
          if (hasStocks) fileObj.stocks = cleanStocks;
          fileObj.lastUpdated = new Date().toISOString();
          return { fileObj };
        };

        const MAX_RETRIES = 2;
        let lastCode = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          // 1. Read fresh
          let existing = null;
          try { existing = await ghGet(filePath, githubToken); } catch (e) { existing = null; }
          let fileObj, sha = null;
          if (existing && existing.content) {
            fileObj = JSON.parse(Buffer.from(existing.content, 'base64').toString());
            sha = existing.sha;
          } else {
            fileObj = { nickname: user.nickname, stocks: [], lastUpdated: null };
          }

          // 2. Rate limit (profile saves only) via dedicated profileUpdatedAt
          if (hasProfile && fileObj.profileUpdatedAt) {
            const elapsed = Date.now() - Date.parse(fileObj.profileUpdatedAt);
            if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < SAVE_COOLDOWN_MS) {
              return res.status(429).json({
                ok: false,
                message: 'Please wait a moment before saving again',
                error: 'Please wait a moment before saving again'
              });
            }
          }

          // 3. Merge (schema-aware)
          const merged = applyMerge(fileObj);
          if (merged.refuse) {
            return res.status(409).json({ ok: false, message: merged.refuse, error: merged.refuse });
          }

          // 4. Write with optimistic lock
          const writeRes = sha
            ? await ghPut(filePath, merged.fileObj, sha, githubToken)
            : await ghCreate(filePath, merged.fileObj, githubToken);
          lastCode = writeRes && writeRes._statusCode;
          if (lastCode === 200 || lastCode === 201) {
            return res.status(200).json({ ok: true, message: 'Saved' });
          }
          if (lastCode === 409 || lastCode === 422) continue;  // stale SHA / create race → re-read & retry
          break;                                               // other error → stop
        }

        const finalCode = (lastCode === 409 || lastCode === 422) ? 409 : 500;
        const failMsg = "Couldn't save — please try again";
        return res.status(finalCode).json({ ok: false, message: failMsg, error: failMsg });
      } catch (e) {
        console.error('user-portfolio POST error:', e);
        const failMsg = "Couldn't save — please try again";
        return res.status(500).json({ ok: false, message: failMsg, error: failMsg });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error('user-portfolio error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
