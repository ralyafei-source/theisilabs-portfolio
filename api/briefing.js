const BRIEFING_API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'ralyafei-source/theisilabs-portfolio';

// ── Helper: resolve file path by nickname ────────────────────────────────────
// Per-user:  data/briefing-ahmed-2026-06-08.json
// Rashed:    data/briefing-rashed-2026-06-08.json
// Legacy:    data/briefing.json  (read-only fallback for old saved briefs)
function getTodayUAE() {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function getFilePath(nickname, date) {
  const d = date || getTodayUAE();
  if (!nickname || nickname === '') return `data/briefing.json`; // legacy fallback
  return `data/briefing-${nickname.toLowerCase()}-${d}.json`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET — load brief for a user ─────────────────────────────────────────
  if (req.method === 'GET') {
    const nickname = req.query.nickname || '';
    const date = req.query.date || getTodayUAE();
    const filePath = getFilePath(nickname, date);

    try {
      const r = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/${filePath}?t=${Date.now()}`
      );

      // If per-user file not found, try legacy file as fallback (only for rashed)
      if (!r.ok) {
        if (nickname === 'rashed' || nickname === '') {
          const legacy = await fetch(
            `https://raw.githubusercontent.com/${REPO}/main/data/briefing.json?t=${Date.now()}`
          );
          if (!legacy.ok) return res.status(200).json({ content: null });
          const data = await legacy.json();
          return res.status(200).json(data);
        }
        return res.status(200).json({ content: null });
      }

      const data = await r.json();
      return res.status(200).json(data);
    } catch (e) {
      return res.status(200).json({ content: null });
    }
  }

  // ── POST — save brief for a user ─────────────────────────────────────────
  if (req.method === 'POST') {
    // Auth: accept both x-api-key header and Authorization Bearer header
    const apiKey =
      req.headers['x-api-key'] ||
      (req.headers['authorization'] || '').replace('Bearer ', '').trim() ||
      (req.body && req.body.api_key);

    if (apiKey !== BRIEFING_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let content = (req.body && req.body.content) || '';
    const nickname = (req.body && req.body.nickname) || '';
    const date = (req.body && req.body.date) || getTodayUAE();

    // Handle case where content is a JSON string with type/text structure
    try {
      const parsed = JSON.parse(content);
      if (parsed.text) content = parsed.text;
      if (parsed.content) content = parsed.content;
    } catch (e) {
      // content is already plain text, keep as is
    }

    if (!content) return res.status(400).json({ error: 'No content' });

    const filePath = getFilePath(nickname, date);

    try {
      const fileData = {
        content,
        nickname: nickname || 'rashed',
        date,
        savedAt: new Date().toISOString()
      };
      const encoded = Buffer.from(JSON.stringify(fileData)).toString('base64');

      // Get current file SHA (if exists)
      const getRes = await fetch(
        `https://api.github.com/repos/${REPO}/contents/${filePath}`,
        {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json'
          }
        }
      );
      const getSha = getRes.ok ? (await getRes.json()).sha : null;

      // Write to GitHub
      const putRes = await fetch(
        `https://api.github.com/repos/${REPO}/contents/${filePath}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: `Update briefing for ${nickname || 'rashed'} ${date}`,
            content: encoded,
            ...(getSha && { sha: getSha })
          })
        }
      );

      if (!putRes.ok) {
        const err = await putRes.json();
        return res.status(500).json({ error: err.message });
      }

      return res.status(200).json({ success: true, file: filePath });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
