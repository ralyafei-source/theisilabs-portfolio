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

// Verify session token
async function verifySession(sessionToken, githubToken) {
  const usersFile = await ghGet('data/users.json', githubToken);
  const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());
  const user = users.find(u => u.sessionToken === sessionToken);
  if (!user || new Date(user.sessionExpiry) < new Date()) return null;
  return user;
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

    // ── POST: save user's portfolio ──
    if (req.method === 'POST') {
      const { stocks } = req.body || {};
      if (!stocks || !Array.isArray(stocks)) {
        return res.status(400).json({ error: 'stocks array required' });
      }

      // Validate and clean stocks
      const cleanStocks = stocks
        .filter(s => s.sym && s.shares > 0 && s.cost > 0)
        .map(s => ({
          sym: s.sym.toUpperCase().trim(),
          en: s.en || s.sym.toUpperCase().trim(),
          ar: s.ar || s.sym.toUpperCase().trim(),
          shares: parseFloat(s.shares),
          cost: parseFloat(s.cost),
          price: parseFloat(s.cost), // will be updated by live prices
          mv: Math.round(parseFloat(s.shares) * parseFloat(s.cost)),
          gl: 0,
          sec: s.sec || 'tech'
        }));

      const portfolioData = {
        nickname: user.nickname,
        stocks: cleanStocks,
        lastUpdated: new Date().toISOString()
      };

      // Try to update existing file, create if not exists
      try {
        const existing = await ghGet(filePath, githubToken);
        await ghPut(filePath, portfolioData, existing.sha, githubToken);
      } catch(e) {
        // File doesn't exist — create it
        await ghCreate(filePath, portfolioData, githubToken);
      }

      return res.status(200).json({ success: true, count: cleanStocks.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error('user-portfolio error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
