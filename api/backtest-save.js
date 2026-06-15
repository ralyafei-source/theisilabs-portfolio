// api/backtest-save.js
// ONE job: receive all week results from browser, merge with existing, save once
// POST /api/backtest-save  Body: { runs: [...] }
// Called ONCE at the end of a backtest session — eliminates all SHA conflicts

const REPO         = 'ralyafei-source/theisilabs-portfolio';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

async function ghGet(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app' }
  });
  if (!r.ok) return null;
  return r.json();
}

async function ghPut(path, content, message, sha) {
  const body = { message, content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64') };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'theisilabs-app',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`GitHub PUT failed: ${r.status} — ${err.message || 'unknown'}`);
  }
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { runs: newRuns } = req.body || {};
    if (!newRuns || !Array.isArray(newRuns) || newRuns.length === 0)
      return res.status(400).json({ error: 'runs array required' });

    // Read current file — ONE read
    let existingData = { runs: [] };
    let existingSha  = null;
    const existing = await ghGet('data/backtest-extended.json');
    if (existing?.content) {
      try {
        existingData = JSON.parse(Buffer.from(existing.content, 'base64').toString());
        existingSha  = existing.sha;
      } catch {}
    }

    // Merge: existing + new (new overwrites same date)
    const existingMap = {};
    (existingData.runs || []).forEach(r => { existingMap[r.date] = r; });
    newRuns.forEach(r => { existingMap[r.date] = r; }); // new wins on conflict

    const allRuns = Object.values(existingMap)
      .sort((a, b) => a.date > b.date ? 1 : -1);

    // ONE write
    await ghPut(
      'data/backtest-extended.json',
      { lastUpdated: new Date().toISOString(), totalRuns: allRuns.length, runs: allRuns },
      `Backtest: add ${newRuns.length} weeks (${newRuns[0]?.date} to ${newRuns[newRuns.length-1]?.date})`,
      existingSha
    );

    return res.status(200).json({
      saved:     newRuns.length,
      totalRuns: allRuns.length,
      from:      allRuns[0]?.date,
      to:        allRuns[allRuns.length-1]?.date
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
