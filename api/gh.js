// api/gh.js — reliable read-through proxy for repo data files.
// ---------------------------------------------------------------------------
// The dashboard loads most of its card data as static JSON straight from
// raw.githubusercontent.com in the browser. That CDN has intermittent outages
// (503s) which silently blank the cards. This endpoint serves the same files
// via the GitHub *API* (authenticated, different infrastructure, 5000 req/hr)
// with a server-side raw fallback and retries — so the dashboard has a reliable
// second source. index.html's fetch interceptor calls this only when raw fails.
//
// Read-only. Restricted to data/ paths. No auth required to READ (the files are
// already public on the repo); GITHUB_TOKEN is used only to lift rate limits and
// reach the API reliably.
//
//   GET /api/gh?path=data/market/brief-rashed-2026-08-17.json
//
// Env: GITHUB_TOKEN (already in your project).
// ---------------------------------------------------------------------------
'use strict';

const REPO  = 'ralyafei-source/theisilabs-portfolio';
const TOKEN = process.env.GITHUB_TOKEN || '';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // path safety: only data/ files, no traversal, conservative charset
  let path = String((req.query && req.query.path) || '').replace(/^\/+/, '');
  try { path = decodeURIComponent(path); } catch (e) {}
  if (!/^data\/[A-Za-z0-9][A-Za-z0-9._\/-]*\.(json|txt|csv)$/.test(path) || path.includes('..')) {
    return res.status(400).json({ error: 'bad path' });
  }
  // never proxy auth/credential files (they are read server-side via /api/auth)
  const base = path.split('/').pop().toLowerCase();
  if (base === 'users.json' || base === 'invite-codes.json') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const sendBody = (body, contentType) => {
    res.setHeader('content-type', contentType || 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    return res.status(200).send(body);
  };

  const apiUrl = `https://api.github.com/repos/${REPO}/contents/${path}?ref=main`;
  const rawUrl = `https://raw.githubusercontent.com/${REPO}/main/${path}`;
  const ct = path.endsWith('.json') ? 'application/json; charset=utf-8'
           : path.endsWith('.csv')  ? 'text/csv; charset=utf-8'
           : 'text/plain; charset=utf-8';

  // 1) PRIMARY: GitHub Contents API, raw media type (works for any file size,
  //    one call, authenticated). Two attempts.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'theisi',
          'Accept': 'application/vnd.github.raw',
          ...(TOKEN ? { Authorization: `token ${TOKEN}` } : {})
        }
      });
      if (r.status === 404) return res.status(404).json({ error: 'not found' });
      if (r.ok) { const body = await r.text(); return sendBody(body, ct); }
      // 403 (rate/abuse) or 5xx → fall through to retry / raw
    } catch (e) { /* retry */ }
    await new Promise(x => setTimeout(x, 300));
  }

  // 2) FALLBACK: server-side raw fetch (different path than the browser's; the
  //    outage may be edge/region-specific). Two attempts.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${rawUrl}?t=${attempt}`, { headers: { 'User-Agent': 'theisi' } });
      if (r.status === 404) return res.status(404).json({ error: 'not found' });
      if (r.ok) { const body = await r.text(); return sendBody(body, ct); }
    } catch (e) { /* retry */ }
    await new Promise(x => setTimeout(x, 300));
  }

  return res.status(502).json({ error: 'upstream unavailable' });
};
