// =============================================================
// THEISI LABS — api/build-universe.js
// Vercel serverless function — CommonJS (matches project style)
//
// Receives raw FMP screener arrays from Make.com (scenario 922)
// Applies: union → dedupe by symbol → dollar-volume filter
// Returns: clean universe JSON ready to save to GitHub
//
// v1.1 · 2026-06-10 · Session 28
// =============================================================

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' });
  }

  try {
    const { large = [], mid = [], momentum = [], date } = req.body;

    // ── GATE CONFIG ───────────────────────────────────────────
    const MIN_DOLLAR_VOLUME = 5_000_000;  // $5M/day liquidity floor
    const MAX_UNIVERSE      = 800;        // fail loud if exceeded

    // ── STEP 1: UNION ─────────────────────────────────────────
    const all = [...large, ...mid, ...momentum];
    console.log(`build-universe: raw union=${all.length} (large:${large.length} mid:${mid.length} momentum:${momentum.length})`);

    // ── STEP 2: DEDUPE BY SYMBOL ──────────────────────────────
    // Drop symbols with '.' (foreign listings: NVDA.NE, CRH.L)
    // Keep higher-volume record when same symbol appears twice
    const bySymbol = {};
    for (const stock of all) {
      const sym = stock.symbol;
      if (!sym || sym.includes('.')) continue;
      const existing = bySymbol[sym];
      if (!existing || (stock.volume || 0) > (existing.volume || 0)) {
        bySymbol[sym] = stock;
      }
    }
    const afterDedup = Object.values(bySymbol);
    console.log(`build-universe: after dedupe=${afterDedup.length}`);

    // ── STEP 3: DOLLAR-VOLUME FLOOR ───────────────────────────
    const filtered = afterDedup.filter(s =>
      (s.price || 0) * (s.volume || 0) >= MIN_DOLLAR_VOLUME
    );
    console.log(`build-universe: after dollar-vol filter=${filtered.length}`);

    // ── STEP 4: FAIL LOUD if oversized ────────────────────────
    if (filtered.length > MAX_UNIVERSE) {
      console.error(`build-universe OVERSIZED: ${filtered.length} — gate too loose?`);
    }

    // ── STEP 5: SORT stable (marketCap desc, then symbol A→Z) ─
    filtered.sort((a, b) => {
      const capDiff = (b.marketCap || 0) - (a.marketCap || 0);
      return capDiff !== 0 ? capDiff : (a.symbol || '').localeCompare(b.symbol || '');
    });

    // ── STEP 6: BUILD CLEAN OUTPUT ────────────────────────────
    const universe = filtered.slice(0, MAX_UNIVERSE).map(s => ({
      symbol:      s.symbol,
      companyName: s.companyName || '',
      marketCap:   s.marketCap   || 0,
      price:       s.price       || 0,
      volume:      s.volume      || 0,
      sector:      s.sector      || '',
      industry:    s.industry    || '',
      beta:        s.beta        || 0,
      exchange:    s.exchange    || ''
    }));

    const today = date || new Date().toISOString().slice(0, 10);

    return res.status(200).json({
      date:  today,
      count: universe.length,
      source_counts: {
        large:            large.length,
        mid:              mid.length,
        momentum:         momentum.length,
        raw_union:        all.length,
        after_dedup:      afterDedup.length,
        after_dollar_vol: filtered.length
      },
      universe
    });

  } catch (err) {
    console.error('build-universe FATAL:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
