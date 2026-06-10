// =============================================================
// THEISI LABS — /api/build-universe.js
// Vercel serverless function
// 
// Receives raw FMP screener arrays from Make.com (scenario 922)
// Applies: union → dedupe by symbol → dollar-volume filter
// Returns: clean universe JSON ready to save to GitHub
//
// v1.0 · 2026-06-10 · Session 28
// Implements Build Spec v1.1 §2.1-2.3
// =============================================================

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' });
  }

  try {
    const { large = [], mid = [], momentum = [], date } = req.body;

    // ── GATE CONFIG (all tunable — change here, not inline) ──────────
    const GATE = {
      MIN_DOLLAR_VOLUME:  5_000_000,   // $5M/day — must be tradeable
      MAX_UNIVERSE:       800,          // tripwire — fail loud if exceeded
    };
    // ─────────────────────────────────────────────────────────────────

    // ── STEP 1: UNION ─────────────────────────────────────────────────
    const all = [...large, ...mid, ...momentum];
    console.log(`build-universe: raw union = ${all.length} (large:${large.length} mid:${mid.length} momentum:${momentum.length})`);

    // ── STEP 2: DEDUPE BY SYMBOL ──────────────────────────────────────
    // Rules:
    //   - Drop any symbol containing '.' (foreign listings: NVDA.NE, CRH.L)
    //   - When same symbol appears in multiple screeners, keep the
    //     record with higher volume (more liquid representation)
    const bySymbol = {};
    for (const stock of all) {
      const sym = stock.symbol;
      if (!sym || sym.includes('.')) continue;             // drop foreign listings
      const existing = bySymbol[sym];
      if (!existing || (stock.volume || 0) > (existing.volume || 0)) {
        bySymbol[sym] = stock;
      }
    }
    const afterDedup = Object.values(bySymbol);
    console.log(`build-universe: after dedupe = ${afterDedup.length}`);

    // ── STEP 3: DOLLAR-VOLUME FLOOR ($5M/day) ────────────────────────
    // FMP screener has no ADV field — volume is single-day.
    // price × volume ≥ $5M is our liquidity proxy.
    const filtered = afterDedup.filter(s =>
      (s.price || 0) * (s.volume || 0) >= GATE.MIN_DOLLAR_VOLUME
    );
    console.log(`build-universe: after dollar-vol filter = ${filtered.length}`);

    // ── STEP 4: FAIL LOUD if oversized (gate broke) ───────────────────
    if (filtered.length > GATE.MAX_UNIVERSE) {
      console.error(
        `build-universe OVERSIZED: ${filtered.length} stocks — gate too loose? ` +
        `Proceeding with first ${GATE.MAX_UNIVERSE}.`
      );
      // Don't crash — log and proceed. Dashboard still gets data.
    }

    // ── STEP 5: SORT stable (marketCap desc, then symbol A-Z) ─────────
    // Same tie-break rule as scorer: alphabetical by symbol.
    filtered.sort((a, b) => {
      const capDiff = (b.marketCap || 0) - (a.marketCap || 0);
      return capDiff !== 0 ? capDiff : (a.symbol || '').localeCompare(b.symbol || '');
    });

    // ── STEP 6: BUILD CLEAN UNIVERSE OBJECTS ─────────────────────────
    // Keep only the fields the scorer needs — no junk fields
    const universe = filtered.slice(0, GATE.MAX_UNIVERSE).map(s => ({
      symbol:      s.symbol,
      companyName: s.companyName   || '',
      marketCap:   s.marketCap     || 0,
      price:       s.price         || 0,
      volume:      s.volume        || 0,
      sector:      s.sector        || '',
      industry:    s.industry      || '',
      beta:        s.beta          || 0,
      exchange:    s.exchange      || ''
    }));

    // ── OUTPUT ────────────────────────────────────────────────────────
    const today = date || new Date().toISOString().slice(0, 10);

    const output = {
      date:          today,
      count:         universe.length,
      source_counts: {
        large:           large.length,
        mid:             mid.length,
        momentum:        momentum.length,
        raw_union:       all.length,
        after_dedup:     afterDedup.length,
        after_dollar_vol: filtered.length
      },
      universe
    };

    console.log(`build-universe: done. date=${today}, count=${universe.length}`);
    return res.status(200).json(output);

  } catch (err) {
    console.error('build-universe FATAL:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
