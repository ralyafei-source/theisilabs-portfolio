// api/sa-analyze.js — THEISI SA PRO Intelligence Engine
// Saves inputs to GitHub, returns structured JSON analysis + token count

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const REPO          = 'ralyafei-source/theisilabs-portfolio';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { inputs, prompt, saveOnly } = req.body || {};
  if (!prompt && !saveOnly) return res.status(400).json({ error: 'prompt required' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  // ── Step 1: Save inputs to GitHub ──────────────────────────────────────
  let savedPath = null;
  if (inputs && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const filePath = `data/sa-inputs-${date}.json`;
      const fileContent = JSON.stringify({ date, inputs, savedAt: new Date().toISOString() }, null, 2);

      let sha = null;
      try {
        const existing = await fetch(`https://api.github.com/repos/${REPO}/contents/${filePath}`, {
          headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' }
        });
        if (existing.ok) { const d = await existing.json(); sha = d.sha; }
      } catch {}

      const saveBody = {
        message: `SA Intel inputs — ${date}`,
        content: Buffer.from(fileContent).toString('base64'),
        ...(sha ? { sha } : {})
      };
      const saveRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${filePath}`, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'theisi'
        },
        body: JSON.stringify(saveBody)
      });
      if (saveRes.ok) savedPath = filePath;
    } catch (e) { console.error('Save error:', e.message); }
  }

  if (saveOnly) return res.status(200).json({ saved: savedPath || false });

  // ── Step 2: Call Claude ─────────────────────────────────────────────────
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 10000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await r.json();
    if (!data.content?.[0]?.text) {
      return res.status(500).json({ error: 'No response', raw: JSON.stringify(data).slice(0,300) });
    }

    return res.status(200).json({
      result: data.content[0].text,
      savedPath,
      usage: {
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
        input_cost: ((data.usage?.input_tokens || 0) / 1000000 * 3).toFixed(4),
        output_cost: ((data.usage?.output_tokens || 0) / 1000000 * 15).toFixed(4),
        total_cost: (((data.usage?.input_tokens || 0) / 1000000 * 3) + ((data.usage?.output_tokens || 0) / 1000000 * 15)).toFixed(4)
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
