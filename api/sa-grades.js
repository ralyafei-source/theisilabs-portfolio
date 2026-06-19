// api/sa-grades.js
// Stores SA grades in data/sa-grades.json on GitHub. Upsert + delete + replace.
// Keyed by symbol. Mirrors update-portfolio.js auth + GitHub read/write pattern.

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const BRIEFING_API_KEY = process.env.BRIEFING_API_KEY;
const REPO = 'ralyafei-source/theisilabs-portfolio';
const FILE_PATH = 'data/sa-grades.json';

async function verifyAdminSession(sessionToken) {
  if (!sessionToken) return null;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${REPO}/contents/data/users.json`,
      { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
    );
    if (!r.ok) return null;
    const fileData = await r.json();
    const users = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));
    const list = Array.isArray(users) ? users : (users.users || []);
    const user = list.find(u => u.sessionToken === sessionToken);
    if (!user) return null;
    if (user.sessionExpiry && new Date(user.sessionExpiry) < new Date()) return null;
    if (!user.isAdmin) return null;
    return user;
  } catch (e) { return null; }
}

// Read the current store (returns {store, sha} or {store:empty, sha:null} if file absent)
async function readStore() {
  const getRes = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
    { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
  );
  if (getRes.status === 404) {
    return { store: { updated: null, source: null, stocks: {} }, sha: null };
  }
  if (!getRes.ok) throw new Error('Could not read sa-grades.json from GitHub');
  const fileData = await getRes.json();
  const store = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));
  if (!store.stocks) store.stocks = {};
  return { store, sha: fileData.sha };
}

async function writeStore(store, sha, message) {
  store.updated = new Date().toISOString();
  const encoded = Buffer.from(JSON.stringify(store, null, 2)).toString('base64');
  const body = { message, content: encoded };
  if (sha) body.sha = sha;
  const putRes = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
  if (!putRes.ok) { const err = await putRes.json(); throw new Error(err.message); }
  return true;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET = read store (open read, like portfolio is readable). No auth required to READ.
  if (req.method === 'GET') {
    try {
      const { store } = await readStore();
      return res.status(200).json(store);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Ensure body is parsed (Vercel raw functions may deliver it as string or stream)
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    } catch (e) { body = {}; }
  }

  // Auth (writes only): admin session token OR BRIEFING_API_KEY
  const bearer = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const apiKey = req.headers['x-api-key'] || body.api_key;
  let authorized = false;
  if (apiKey && BRIEFING_API_KEY && apiKey === BRIEFING_API_KEY) authorized = true;
  if (!authorized && bearer) {
    const adminUser = await verifyAdminSession(bearer);
    if (adminUser) authorized = true;
  }
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

  // action: 'upsert' (rows[]), 'delete' (sym), 'replace' (rows[] full wipe+load)
  const { action, rows, sym, source } = body;
  if (!action) return res.status(400).json({ error: 'Missing action' });

  try {
    let { store, sha } = await readStore();
    let result = {};

    if (action === 'upsert') {
      if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'upsert requires rows[]' });
      let added = 0, updated = 0;
      rows.forEach(r => {
        if (!r || !r.symbol) return;
        const s = String(r.symbol).trim().toUpperCase();
        if (!s) return;
        r._updated = new Date().toISOString();
        if (store.stocks[s]) updated++; else added++;
        store.stocks[s] = Object.assign({}, store.stocks[s] || {}, r, { symbol: s });
      });
      if (source) store.source = source;
      await writeStore(store, sha, `SA grades upsert: +${added} ~${updated}`);
      result = { added, updated, total: Object.keys(store.stocks).length };

    } else if (action === 'delete') {
      if (!sym) return res.status(400).json({ error: 'delete requires sym' });
      const s = String(sym).trim().toUpperCase();
      if (!store.stocks[s]) return res.status(404).json({ error: `${s} not in store` });
      delete store.stocks[s];
      await writeStore(store, sha, `SA grades delete: ${s}`);
      result = { deleted: s, total: Object.keys(store.stocks).length };

    } else if (action === 'replace') {
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'replace requires rows[]' });
      const fresh = { updated: null, source: source || 'replace', stocks: {} };
      rows.forEach(r => {
        if (!r || !r.symbol) return;
        const s = String(r.symbol).trim().toUpperCase();
        if (!s) return;
        r._updated = new Date().toISOString();
        fresh.stocks[s] = Object.assign({}, r, { symbol: s });
      });
      await writeStore(fresh, sha, `SA grades replace: ${Object.keys(fresh.stocks).length} stocks`);
      result = { total: Object.keys(fresh.stocks).length };

    } else {
      return res.status(400).json({ error: 'action must be upsert, delete, or replace' });
    }

    return res.status(200).json({ success: true, result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
