// api/update-portfolio.js
// Handles buy/sell/add/remove trades and updates portfolio.json on GitHub

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const BRIEFING_API_KEY = process.env.BRIEFING_API_KEY;
const REPO = 'ralyafei-source/theisilabs-portfolio';
const FILE_PATH = 'data/portfolio.json';

// Verify a session token belongs to a logged-in ADMIN (reads data/users.json)
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: EITHER a logged-in admin session token (browser path — no secret in
  // the page source) OR the static BRIEFING_API_KEY (server-to-server only,
  // e.g. Make.com; never embed this key in any web page).
  const bearer = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const apiKey = req.headers['x-api-key'] || (req.body && req.body.api_key);
  let authorized = false;
  if (apiKey && BRIEFING_API_KEY && apiKey === BRIEFING_API_KEY) authorized = true;
  if (!authorized && bearer) {
    const adminUser = await verifyAdminSession(bearer);
    if (adminUser) authorized = true;
  }
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

  const { action, sym, shares, price, newStock, sec, purchaseDate } = req.body || {};

  if (!action || !sym) {
    return res.status(400).json({ error: 'Missing required fields: action, sym' });
  }
  // shares and price required for BUY/SELL only
  if ((action === 'BUY' || action === 'SELL') && (!shares || !price)) {
    return res.status(400).json({ error: 'BUY/SELL require shares and price' });
  }

  try {
    // 1. Read current portfolio.json from GitHub
    const getRes = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
    );
    if (!getRes.ok) throw new Error('Could not read portfolio.json from GitHub');
    const fileData = await getRes.json();
    const portfolio = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));
    const sha = fileData.sha;

    const holdings = portfolio.holdings || [];
    const existingIdx = holdings.findIndex(h => h.sym === sym.toUpperCase());

    let result = {};

    if (action === 'BUY') {
      if (existingIdx >= 0) {
        // Add to existing position — recalculate weighted average cost
        const existing = holdings[existingIdx];
        const oldValue = existing.shares * existing.cost;
        const newValue = shares * price;
        const newShares = existing.shares + shares;
        const newCost = (oldValue + newValue) / newShares;
        holdings[existingIdx].shares = Math.round(newShares * 10000) / 10000;
        holdings[existingIdx].cost = Math.round(newCost * 100) / 100;
        result = { sym, shares: holdings[existingIdx].shares, cost: holdings[existingIdx].cost, action: 'updated' };
      } else {
        // New stock — requires newStock details
        if (!newStock?.name) return res.status(400).json({ error: 'New stock requires name details' });
        holdings.push({
          sym: sym.toUpperCase(),
          name: newStock.name,
          name_ar: newStock.name_ar || sym.toUpperCase(),
          shares: Math.round(shares * 10000) / 10000,
          cost: Math.round(price * 100) / 100,
          sector: newStock.sector || 'tech'
        });
        result = { sym, shares, cost: price, action: 'added' };
      }
    } else if (action === 'SELL') {
      if (existingIdx < 0) return res.status(400).json({ error: `${sym} not found in portfolio` });
      const existing = holdings[existingIdx];
      const newShares = Math.round((existing.shares - shares) * 10000) / 10000;
      if (newShares < 0) return res.status(400).json({ error: `Cannot sell ${shares} shares — only ${existing.shares} held` });
      if (newShares < 0.01) {
        // Fully sold — remove from portfolio
        holdings.splice(existingIdx, 1);
        result = { sym, shares: 0, action: 'removed' };
      } else {
        holdings[existingIdx].shares = newShares;
        // Cost basis stays the same on sells
        result = { sym, shares: newShares, cost: existing.cost, action: 'updated' };
      }
    } else if (action === 'REMOVE') {
      if (existingIdx < 0) return res.status(400).json({ error: `${sym} not found in portfolio` });
      holdings.splice(existingIdx, 1);
      result = { sym, shares: 0, action: 'removed' };
    } else if (action === 'EDIT') {
      // Edit existing holding: update shares, cost, sector, purchaseDate
      if (existingIdx < 0) return res.status(400).json({ error: `${sym} not found in portfolio` });
      if (shares !== undefined) holdings[existingIdx].shares = Math.round(parseFloat(shares) * 10000) / 10000;
      if (price !== undefined) holdings[existingIdx].cost = Math.round(parseFloat(price) * 100) / 100;
      if (sec !== undefined) holdings[existingIdx].sector = sec;
      if (purchaseDate !== undefined) holdings[existingIdx].purchaseDate = purchaseDate;
      result = { sym, shares: holdings[existingIdx].shares, cost: holdings[existingIdx].cost, action: 'edited' };
    } else {
      return res.status(400).json({ error: 'action must be BUY, SELL, REMOVE, or EDIT' });
    }

    // Update meta
    portfolio.holdings = holdings;
    portfolio.meta.last_updated = new Date().toISOString().split('T')[0];

    // 2. Write updated portfolio.json back to GitHub
    const encoded = Buffer.from(JSON.stringify(portfolio, null, 2)).toString('base64');
    const putRes = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: `${action} ${shares} ${sym} @ $${price}`,
          content: encoded,
          sha
        })
      }
    );
    if (!putRes.ok) {
      const err = await putRes.json();
      throw new Error(err.message);
    }

    return res.status(200).json({ success: true, result, total_holdings: holdings.length });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
