// api/cron-distributions.js
// Weekly rebuild of data/distributions.json (percentile breakpoints per symbol).
// GET wrapper so Vercel Cron can trigger it — the key never leaves the server.
// Loops chunks until done, with a wall-clock guard so it can't hit the timeout.

const BASE    = 'https://theisilabs.vercel.app/api/portfolio-for-ai';
const API_KEY = process.env.BRIEFING_API_KEY;

module.exports = async (req, res) => {
  const started = Date.now();
  const BUDGET  = 50000;          // stop starting new chunks after 50s
  const SIZE    = 40;

  if (!API_KEY) return res.status(500).json({ error: 'BRIEFING_API_KEY not set' });

  // Allow manual runs from a browser with ?key=... ; cron calls need no key.
  const isCron = !!req.headers['x-vercel-cron'];
  if (!isCron && req.query.key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = [];
  let chunk = 0, guard = 0;

  try {
    while (guard++ < 20) {
      if (Date.now() - started > BUDGET) {
        log.push({ stopped: 'time budget', next_chunk: chunk });
        break;
      }
      const url = `${BASE}?mode=build-distributions&chunk=${chunk}&size=${SIZE}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
      const j = await r.json().catch(() => ({ error: 'bad json', status: r.status }));
      log.push(j);

      if (!r.ok || j.error) break;
      if (j.done || j.next_chunk == null) break;
      chunk = j.next_chunk;
    }

    const built  = log.reduce((a, x) => a + (x.built || 0), 0);
    const failed = log.flatMap(x => x.failed || []);
    return res.status(200).json({
      ok: true,
      built,
      failed,
      chunks: log.length,
      seconds: Math.round((Date.now() - started) / 1000),
      log
    });
  } catch (e) {
    return res.status(500).json({ error: 'cron-distributions failed', detail: String(e).slice(0, 300), log });
  }
};
