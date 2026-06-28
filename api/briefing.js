const BRIEFING_API_KEY = process.env.BRIEFING_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'ralyafei-source/theisilabs-portfolio';

function getTodayUAE() {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function getDateDaysAgo(n) {
  return new Date(Date.now() + 4 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
}

function getFilePath(nickname, date) {
  const d = date || getTodayUAE();
  if (!nickname || nickname === '') return `data/briefing.json`;
  return `data/briefing-${nickname.toLowerCase()}-${d}.json`;
}

async function fetchFromGitHub(path) {
  const r = await fetch(
    `https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`
  );
  if (!r.ok) return null;
  return await r.json();
}

// ───────────────────────── AUTH helper (added) ─────────────────────────
// Mirrors verifySession() in user-portfolio.js / handleMe() in auth.js so the
// session check behaves identically across the backend. Returns the user object
// for a valid, unexpired session token, else null.
async function verifySession(sessionToken) {
  if (!sessionToken) return null;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${REPO}/contents/data/users.json`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app' } }
    );
    if (!r.ok) return null;
    const file = await r.json();
    const users = JSON.parse(Buffer.from(file.content, 'base64').toString());
    const user = users.find(u => u.sessionToken === sessionToken);
    if (!user) return null;
    if (new Date(user.sessionExpiry) < new Date()) return null;
    return user;
  } catch (e) {
    return null;
  }
}
// ──────────────────────── end AUTH helper ────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET — load brief for a user, fall back up to 7 days ─────────────────
  if (req.method === 'GET') {
    // ───── AUTH GATE (added) ─────
    // Accept EITHER the machine API key (Make.com / admin tooling) via x-api-key
    // or Authorization, OR a valid user session token. A regular user is locked
    // to their OWN nickname; admins and the machine key may request any nickname.
    const bearer =
      req.headers['x-api-key'] ||
      (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    const isMachine = !!BRIEFING_API_KEY && bearer === BRIEFING_API_KEY;

    let nickname = req.query.nickname || '';
    const date = req.query.date || getTodayUAE();

    if (!isMachine) {
      const user = await verifySession(bearer);
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (user.isAdmin) {
        // admin: may read any nickname; if none specified, default to own
        nickname = req.query.nickname || user.nickname;
      } else {
        // regular user: force own nickname, ignore any nickname in the URL
        nickname = user.nickname;
      }
    }
    // ───── end AUTH GATE ─────

    try {
      // Try today first, then look back up to 7 days
      const daysToTry = [0, 1, 2, 3, 4, 5, 6, 7];
      for (const daysAgo of daysToTry) {
        const tryDate = daysAgo === 0 ? date : getDateDaysAgo(daysAgo);
        const filePath = getFilePath(nickname, tryDate);
        const data = await fetchFromGitHub(filePath);
        if (data && data.content) return res.status(200).json(data);
      }

      // Final fallback — legacy briefing.json. ONLY for admin/machine or rashed,
      // never for a regular user (would leak the admin's brief).
      if ((isMachine || nickname === 'rashed' || nickname === '')) {
        const legacy = await fetchFromGitHub('data/briefing.json');
        if (legacy) return res.status(200).json(legacy);
      }

      return res.status(200).json({ content: null });
    } catch (e) {
      return res.status(200).json({ content: null });
    }
  }

  // ── POST — save brief for a user ─────────────────────────────────────────
  if (req.method === 'POST') {
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

    try {
      const parsed = JSON.parse(content);
      if (parsed.text) content = parsed.text;
      if (parsed.content) content = parsed.content;
    } catch (e) {}

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
