// api/cron-weekly.js — weekly AI-Advisor generator (Vercel Cron trigger)
// ---------------------------------------------------------------------------
// Vercel Cron hits this as a GET once a week. It reads data/users.json and,
// for each user (plus rashed), calls generate-analysis with type:'weekly' +
// the BRIEFING_API_KEY, which writes data/analysis-weekly-{nick}-{date}.json.
// That is the file the AI Advisor tab (adv2Fetch) has been 404-ing on.
//
// Env needed (all already in your project): BRIEFING_API_KEY.
// Optional: CRON_SECRET — if set in Vercel, only calls carrying
//           `Authorization: Bearer <CRON_SECRET>` run (Vercel Cron sends it
//           automatically). If unset, the endpoint runs for any GET.
// ---------------------------------------------------------------------------

const REPO      = 'ralyafei-source/theisilabs-portfolio';
const API_KEY   = process.env.BRIEFING_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || '';
const SELF      = 'https://theisilabs.vercel.app/api/generate-analysis';

async function ghRead(path) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  // Vercel Cron uses GET. Allow POST too for manual/curl runs.
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  // optional shared-secret gate
  if (CRON_SECRET) {
    const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (auth !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!API_KEY) return res.status(500).json({ error: 'BRIEFING_API_KEY missing' });

  // collect nicknames (users.json + always-include rashed), de-duped
  const usersData = await ghRead('data/users.json');
  const list = Array.isArray(usersData) ? usersData : ((usersData && usersData.users) || []);
  const nicks = Array.from(new Set(
    ['rashed', ...list.map(u => String(u.nickname || u.nick || '').toLowerCase()).filter(Boolean)]
  ));

  // run sequentially so we stay inside the 300s function budget and don't
  // fire N parallel Claude calls at once
  const results = [];
  for (const nickname of nicks) {
    try {
      const r = await fetch(SELF, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, type: 'weekly', api_key: API_KEY })
      });
      const body = await r.json().catch(() => ({}));
      results.push({ nickname, status: r.status, ok: r.ok, path: body.path || null, error: body.error || null });
    } catch (e) {
      results.push({ nickname, ok: false, error: String(e && e.message || e).slice(0, 160) });
    }
  }

  const ok = results.filter(x => x.ok).length;
  return res.status(200).json({ ran: nicks.length, ok, failed: nicks.length - ok, results });
};
