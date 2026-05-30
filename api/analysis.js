// api/analysis.js
// Supports 3 analysis types: daily, weekly, monthly
// Supports per-user analysis via optional nickname param
// GET: reads appropriate file based on type + date + nickname params
// POST: writes to appropriate file (with nickname prefix if provided)

const REPO  = 'ralyafei-source/theisilabs-portfolio';
const TOKEN = process.env.GITHUB_TOKEN;
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';

function getFilePath(type, date, week, month, nickname) {
  const nick = nickname ? `-${nickname}` : '';
  if (type === 'market-data') return `data/market-data-${date}.json`;
  if (type === 'weekly')  return `data/analysis-weekly${nick}-${week || date?.slice(0,7)}.json`;
  if (type === 'monthly') return `data/analysis-monthly${nick}-${month || date?.slice(0,7)}.json`;
  return `data/analysis-daily${nick}-${date}.json`;
}

async function readFile(path) {
  const r = await fetch(
    `https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`
  );
  if (!r.ok) return null;
  return await r.json();
}

async function writeFile(path, data) {
  const check = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}`,
    { headers: { Authorization: `token ${TOKEN}` } }
  );
  let sha = null;
  if (check.ok) {
    const existing = await check.json();
    sha = existing.sha;
  }
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = { message: `Update ${path}`, content, ...(sha && { sha }) };
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: { Authorization: `token ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  return r.ok;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: read analysis ──
  if (req.method === 'GET') {
    const { date, type, week, month, nickname } = req.query;
    const nick = nickname || null;

    // Specific type requested
    if (type) {
      const path = getFilePath(type, date, week, month, nick);
      const data = await readFile(path);
      if (data) return res.json(data);
      if (nick) {
        const fallbackPath = getFilePath(type, date, week, month, null);
        const fallback = await readFile(fallbackPath);
        if (fallback) return res.json(fallback);
      }
      return res.json({ error: 'Not found' });
    }

    // Default: return all 3 types for dashboard
    const today = date || new Date().toISOString().slice(0, 10);

    // Daily — no fallback between users
    let dailyData = null;
    if (nick) {
      dailyData = await readFile(`data/analysis-daily-${nick}-${today}.json`);
    } else {
      dailyData = await readFile(`data/analysis-daily-${today}.json`);
    }

    // Weekly — no fallback between users
    let weeklyData = null;
    for (let i = 0; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const w = d.toISOString().slice(0, 7);
      if (nick) {
        const data = await readFile(`data/analysis-weekly-${nick}-${w}.json`);
        if (data) { weeklyData = data; break; }
      } else {
        const data = await readFile(`data/analysis-weekly-${w}.json`);
        if (data) { weeklyData = data; break; }
      }
    }

    // Monthly — no fallback between users
    let monthlyData = null;
    for (let i = 0; i <= 2; i++) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      const m = d.toISOString().slice(0, 7);
      if (nick) {
        const data = await readFile(`data/analysis-monthly-${nick}-${m}.json`);
        if (data) { monthlyData = data; break; }
      } else {
        const data = await readFile(`data/analysis-monthly-${m}.json`);
        if (data) { monthlyData = data; break; }
      }
    }

    return res.json({ daily: dailyData, weekly: weeklyData, monthly: monthlyData, date: today });
  }

  // ── POST: save analysis ──
  if (req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    const key = authHeader?.replace('Bearer ', '') || req.body?.api_key;
    if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });

    let { type, date, week, month, content, generated, nickname } = req.body;
    if (!content) return res.status(400).json({ error: 'No content' });

    // Sanitize content
    if (typeof content === 'string' && content.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.text) content = parsed.text;
        else if (parsed.content) content = parsed.content;
      } catch(e) { /* keep as is */ }
    }
    if (Array.isArray(content)) {
      content = content.map(c => c.text || c).join('');
    }

    const nick = nickname || null;
    const path = getFilePath(type || 'daily', date, week, month, nick);
    const data = {
      type:      type || 'daily',
      date:      date || new Date().toISOString().slice(0, 10),
      nickname:  nick || null,
      content,
      generated: generated || new Date().toISOString()
    };

    const ok = await writeFile(path, data);
    if (ok) return res.json({ success: true, path });
    return res.status(500).json({ error: 'Failed to save' });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
