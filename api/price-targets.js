// api/price-targets.js — analyst price-target consensus for a set of symbols.
// Pure DATA (FMP price-target-consensus). No LLM, no invented numbers — used by
// the dashboard trim planner to show each holding's room-to-target for ALL
// holdings (the weekly analysis only covers the reviewed subset).
//
// Usage: GET /api/price-targets?symbols=NVDA,AAPL,...
//   → { targets: { NVDA:{target,high,low,median}, ... }, count, updated }
// Falls back to the union of all users' holdings when no ?symbols given.

const REPO        = 'ralyafei-source/theisilabs-portfolio';
const FMP_API_KEY = process.env.FMP_API_KEY || process.env.FMP_KEY || '';
const CONC        = 8;   // parallel FMP calls per batch

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const r = await fetch(url, { ...options, signal: controller.signal }); clearTimeout(timer); return r; }
  catch (e) { clearTimeout(timer); throw e; }
}

async function consensusFor(sym) {
  if (!FMP_API_KEY) return null;
  try {
    const r = await fetchWithTimeout(
      `https://financialmodelingprep.com/stable/price-target-consensus?symbol=${encodeURIComponent(sym)}&apikey=${FMP_API_KEY}`,
      { headers: { 'User-Agent': 'theisilabs/1.0' } }, 5000);
    if (!r.ok) return null;
    const d = await r.json();
    const row = Array.isArray(d) ? d[0] : d;
    if (!row) return null;
    const target = +(row.targetConsensus ?? row.targetMedian ?? row.targetMean);
    if (!isFinite(target) || target <= 0) return null;
    return {
      target,
      high:   (row.targetHigh   != null ? +row.targetHigh   : null),
      low:    (row.targetLow    != null ? +row.targetLow    : null),
      median: (row.targetMedian != null ? +row.targetMedian : null)
    };
  } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Targets move slowly — cache hard at the edge so we don't re-hit FMP per view.
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');

  if (!FMP_API_KEY) return res.status(200).json({ targets: {}, count: 0, error: 'FMP key missing' });

  // 1) symbols from query, else union of all users' holdings
  let symbols = [];
  if (req.query && req.query.symbols) {
    symbols = String(req.query.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  } else {
    try {
      const uRes = await fetchWithTimeout(`https://raw.githubusercontent.com/${REPO}/main/data/users.json?t=${Date.now()}`, {}, 3000);
      const users = uRes.ok ? await uRes.json() : [];
      const list = Array.isArray(users) ? users : (users.users || []);
      const files = ['data/portfolio.json'];
      list.forEach(u => { if (u.portfolioFile) files.push(u.portfolioFile); });
      const set = new Set();
      await Promise.all([...new Set(files)].map(async f => {
        try {
          const r = await fetchWithTimeout(`https://raw.githubusercontent.com/${REPO}/main/${f}?t=${Date.now()}`, {}, 3000);
          if (!r.ok) return;
          const d = await r.json();
          (d.holdings || d.stocks || (d.portfolio && d.portfolio.stocks) || []).forEach(h => { if (h && h.sym) set.add(String(h.sym).toUpperCase()); });
        } catch (e) {}
      }));
      symbols = [...set];
    } catch (e) {}
  }
  // de-dup + sane cap
  symbols = [...new Set(symbols)].slice(0, 120);
  if (!symbols.length) return res.status(200).json({ targets: {}, count: 0, updated: new Date().toISOString() });

  // 2) fetch consensus in bounded-concurrency batches
  const targets = {};
  for (let i = 0; i < symbols.length; i += CONC) {
    const batch = symbols.slice(i, i + CONC);
    const got = await Promise.all(batch.map(s => consensusFor(s).then(v => [s, v])));
    got.forEach(([s, v]) => { if (v) targets[s] = v; });
  }

  return res.status(200).json({
    targets,
    count: Object.keys(targets).length,
    requested: symbols.length,
    updated: new Date().toISOString()
  });
};
