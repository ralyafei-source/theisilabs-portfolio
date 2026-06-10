// api/portfolio-for-ai.js
// Returns portfolio as formatted plain text for Claude
// Supports ?nickname=ahmed for per-user portfolios
// Supports ?include=intelligence for smart FMP data (earnings, targets, grades, metrics, technicals)
// Supports ?symbols=AVGO,META,LLY for opportunity deep fetch (Stage B2)
// Default (no nickname, no symbols): reads Rashed's portfolio.json

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const FMP_KEY = process.env.FMP_API_KEY || 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
const FMP     = 'https://financialmodelingprep.com/stable';

// ─── FMP helper ──────────────────────────────────────────────────────────────
async function fmpGet(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? d : (d?.Error ? null : d);
  } catch { return null; }
}

function todayUAE() {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysAheadUAE(n) {
  return new Date(Date.now() + 4 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);
}

// ─── Extract latest value from FMP indicator response ────────────────────────
function latest(arr, field) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[0]?.[field] ?? null;
}

// ─── Fetch full FMP intelligence for a list of symbols ───────────────────────
// Used by both portfolio mode and ?symbols= mode
async function fetchIntelligence(symbols, limit = 10) {
  const ETF_LIST = new Set(['QQQ','SPY','VGT','SPUS','VOO','XLP','IVV','SMH','IBIT','QQQM']);
  const nonEtfs  = symbols.filter(s => !ETF_LIST.has(s));
  // Deep fundamentals/targets/grades cover the first `limit` non-ETF symbols.
  // (?symbols= passes symbols.length to cover ALL requested; portfolio/intelligence path defaults to 10.)
  // ETFs are intentionally excluded — they have no P/E, ROE, margins, etc.
  const deep     = nonEtfs.slice(0, limit);

  const [
    earningsRaw,
    targetResults,
    gradeResults,
    metricResults,
    ratioResults,
    rsiResults,
    macdResults,
    sma50Results,
    sma200Results,
    ema20Results,
    bbResults
  ] = await Promise.all([
    fmpGet(`/earnings-calendar?from=${todayUAE()}&to=${daysAheadUAE(60)}&symbol=${symbols.join(',')}`),
    Promise.all(deep.map(sym => fmpGet(`/price-target-consensus?symbol=${sym}`))),
    Promise.all(deep.map(sym => fmpGet(`/grades?symbol=${sym}&limit=3`))),
    // TODO(optimize): replace per-symbol fundamentals with /key-metrics-ttm-bulk + /ratios-ttm-bulk
    //                 (2 calls vs up to ~200) once bulk endpoints are verified on our FMP plan.
    Promise.all(deep.map(sym => fmpGet(`/key-metrics-ttm?symbol=${sym}`))),
    Promise.all(deep.map(sym => fmpGet(`/ratios-ttm?symbol=${sym}`))),
    Promise.all(symbols.map(sym =>
      fmpGet(`/technical-indicators/rsi?symbol=${sym}&periodLength=14&timeframe=1day&limit=1`)
        .then(d => ({ sym, rsi: latest(d, 'rsi') }))
    )),
    Promise.all(symbols.map(sym =>
      fmpGet(`/technical-indicators/macd?symbol=${sym}&fastPeriod=12&slowPeriod=26&signalPeriod=9&timeframe=1day&limit=1`)
        .then(d => ({ sym, macd: latest(d, 'macd'), signal: latest(d, 'signal'), histogram: latest(d, 'histogram') }))
    )),
    Promise.all(symbols.map(sym =>
      fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=50&timeframe=1day&limit=1`)
        .then(d => ({ sym, sma50: latest(d, 'sma') }))
    )),
    Promise.all(symbols.map(sym =>
      fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=200&timeframe=1day&limit=1`)
        .then(d => ({ sym, sma200: latest(d, 'sma') }))
    )),
    Promise.all(symbols.map(sym =>
      fmpGet(`/technical-indicators/ema?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`)
        .then(d => ({ sym, ema20: latest(d, 'ema') }))
    )),
    Promise.all(symbols.map(sym =>
      fmpGet(`/technical-indicators/standardDeviation?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`)
        .then(d => ({ sym, stddev: latest(d, 'standardDeviation') }))
    ))
  ]);

  // Build techMap
  const techMap = {};
  symbols.forEach(sym => { techMap[sym] = {}; });

  rsiResults.forEach(   ({ sym, rsi })                     => { if (techMap[sym]) techMap[sym].rsi = rsi !== null ? +rsi.toFixed(2) : null; });
  macdResults.forEach(  ({ sym, macd, signal, histogram }) => {
    if (techMap[sym]) {
      techMap[sym].macd      = macd      !== null ? +macd.toFixed(4)      : null;
      techMap[sym].signal    = signal    !== null ? +signal.toFixed(4)    : null;
      techMap[sym].histogram = histogram !== null ? +histogram.toFixed(4) : null;
    }
  });
  sma50Results.forEach( ({ sym, sma50 })  => { if (techMap[sym]) techMap[sym].sma50  = sma50  !== null ? +sma50.toFixed(2)  : null; });
  sma200Results.forEach(({ sym, sma200 }) => { if (techMap[sym]) techMap[sym].sma200 = sma200 !== null ? +sma200.toFixed(2) : null; });
  ema20Results.forEach( ({ sym, ema20 })  => { if (techMap[sym]) techMap[sym].ema20  = ema20  !== null ? +ema20.toFixed(2)  : null; });
  bbResults.forEach(    ({ sym, stddev }) => {
    if (techMap[sym] && stddev !== null) {
      techMap[sym].bb_stddev = +stddev.toFixed(4);
    }
  });

  const targets = targetResults.flat().filter(Boolean);
  const grades  = gradeResults.flat().filter(Boolean);
  const metrics = metricResults.flat().filter(Boolean);
  const ratios  = ratioResults.flat().filter(Boolean);
  const earnings = (earningsRaw || []).map(e => ({
    ...e,
    inPortfolio: symbols.includes(e.symbol)
  })).sort((a, b) => {
    if (a.inPortfolio && !b.inPortfolio) return -1;
    if (!a.inPortfolio && b.inPortfolio) return 1;
    return new Date(a.date) - new Date(b.date);
  });

  return { techMap, targets, grades, metrics, ratios, earnings };
}

// ── SCORING CONFIG (weights live here — change requires Scoring Standard amendment) ──
const SCORE_CONFIG = {
  DISPLAY_TOP:        50,    // top N displayed
  HIGHLIGHT_TOP:       5,    // top N highlighted (hero cards)
  DISPLAY_MIN_LAYERS:  3,    // Standard v1.1 §5.6: min layers for display_eligible
  LAYERS: {
    L1: { weight: 0.30, name: 'Technical'    },
    L2: { weight: 0.20, name: 'Momentum'     },
    L3: { weight: 0.20, name: 'External'     },
    L4: { weight: 0.15, name: 'Valuation'    },
    L5: { weight: 0.15, name: 'Fundamental'  },
  },
};

// ── Percentile rank [0,1]: (rank-1)/(n-1), ascending ─────────────────────────
// Higher raw value → higher percentile (monotonic-up orientation).
// Caller negates the raw value before passing for monotonic-down indicators.
function xsPercentileRanks(items) {
  // items: [{ symbol, value }] — already filtered for non-null, finite values
  const n = items.length;
  if (n === 0) return {};
  if (n === 1) return { [items[0].symbol]: 0.5 };
  const sorted = [...items].sort((a, b) => a.value - b.value);   // ascending
  const out = {};
  sorted.forEach((item, i) => { out[item.symbol] = i / (n - 1); });
  return out;
}

// ── Average of non-null, finite values; null if none ────────────────────────
function avgNonNull(vals) {
  const clean = vals.filter(v => v !== null && v !== undefined && isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

// ── Indicator raw-quality functions ─────────────────────────────────────────

// #1 RSI: sweet-spot, trend-conditional (Standard §3.3)
//    Uptrend (above both SMAs) → ideal 55; downtrend → ideal 38
//    Linear decay: quality = 0 at ±25 from ideal
function rsiQuality(rsi, above_sma50, above_sma200) {
  if (rsi === null || rsi === undefined) return null;
  const ideal = (above_sma50 && above_sma200) ? 55 : 38;
  return Math.max(0, 1 - Math.abs(rsi - ideal) / 25);
}

// #2 Price vs SMA50: sweet-spot, ideal +1.5% (midpoint of 0%..+3%)
//    Far above = extended; below = weak
function sma50DistQuality(price, sma50) {
  if (!price || !sma50 || sma50 === 0) return null;
  const pct = (price - sma50) / sma50 * 100;
  return Math.max(0, 1 - Math.abs(pct - 1.5) / 15);
}

// #5 5-day change: sweet-spot, ideal -2.5% (midpoint of -5%..0%)
//    Crashing = falling knife; spiking = chasing
function change5dQuality(change5d) {
  if (change5d === null || change5d === undefined) return null;
  return Math.max(0, 1 - Math.abs(change5d - (-2.5)) / 15);
}

// #11 PEG: sweet-spot, ideal ~1.0
//     Negative or zero PEG = unreliable, treated as null
function pegQuality(peg) {
  if (peg === null || peg === undefined || peg <= 0) return null;
  return Math.max(0, 1 - Math.abs(peg - 1.0) / 3);
}

// #6 Analyst upside: (target - price) / price × 100, capped at 60%
//    Cap removes junk targets (100%+ = unreliable micro-cap noise)
function analystUpsideRaw(analyst_target, price) {
  if (!analyst_target || !price || price === 0) return null;
  const pct = (analyst_target - price) / price * 100;
  return Math.min(Math.max(pct, 0), 60);
}

// #7 Recent upgrade within 30 days (binary: 1 = yes, 0 = no)
function recentUpgradeRaw(recent_grades) {
  if (!Array.isArray(recent_grades) || recent_grades.length === 0) return null;
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const found = recent_grades.some(g => {
    const action  = (g.action || g.ratingChange || g.change || '').toLowerCase();
    const dateStr = g.date || g.gradingDate || '';
    return dateStr >= cutoff &&
      (action.includes('upgrade') || action.includes('initiated') || action === 'reiterated');
  });
  return found ? 1 : 0;
}

// #8 Analyst consensus tilt: fraction of bullish grades [0..1]
function consensusTiltRaw(recent_grades) {
  if (!Array.isArray(recent_grades) || recent_grades.length === 0) return null;
  const bullish = recent_grades.filter(g => {
    const r = (g.rating || g.newGrade || g.grade || '').toLowerCase();
    return r.includes('buy') || r.includes('outperform') ||
           r.includes('overweight') || r.includes('strong buy');
  }).length;
  return bullish / recent_grades.length;
}

// #9 Streak: appearances in last 20 trading days — handles multiple history formats
function computeStreak(histEntry) {
  if (histEntry === null || histEntry === undefined) return null;
  if (typeof histEntry === 'number') return histEntry;
  if (Array.isArray(histEntry)) return histEntry.length;
  if (histEntry.appearances_in_window !== undefined) return histEntry.appearances_in_window;
  if (histEntry.appearances !== undefined) return histEntry.appearances;
  if (Array.isArray(histEntry.dates)) return histEntry.dates.length;
  return null;
}

// ── GitHub helpers (scoring-specific) ────────────────────────────────────────
async function ghReadScorer(repo, path) {
  try {
    const r = await fetch(
      `https://raw.githubusercontent.com/${repo}/main/${path}?t=${Date.now()}`,
      { headers: { 'Cache-Control': 'no-cache' } }
    );
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function ghWriteScorer(repo, path, jsonContent, message, token) {
  const encoded = Buffer.from(JSON.stringify(jsonContent, null, 2)).toString('base64');
  // Get existing SHA (needed to update; absent on new file)
  let sha = null;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'theisi-scorer' } }
    );
    if (r.ok) sha = (await r.json()).sha;
  } catch {}

  const putRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'theisi-scorer',
      },
      body: JSON.stringify({ message, content: encoded, ...(sha ? { sha } : {}) }),
    }
  );
  if (!putRes.ok) throw new Error(`GitHub write failed (${putRes.status}): ${await putRes.text()}`);
}

// ════════════════════════════════════════════════════════════════════════════════
//  handleScore — the main scoring function called by ?mode=score
// ════════════════════════════════════════════════════════════════════════════════
async function handleScore(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set in Vercel' });

  const date = todayUAE();   // reuses the existing helper already in the file

  // ── 1. Load all input files from GitHub ────────────────────────────────────
  const [deepFile, universeFile, historyRaw, portfolioFile] = await Promise.all([
    ghReadScorer(REPO, `data/market/deep-${date}.json`),
    ghReadScorer(REPO, `data/market/universe-${date}.json`),
    ghReadScorer(REPO, 'data/market/history.json'),    // may not exist yet → null
    ghReadScorer(REPO, 'data/portfolio.json'),
  ]);

  // Guard: deep data must exist
  if (!deepFile?.data) {
    return res.status(404).json({ error: `deep-${date}.json not found or missing .data field. Has Step 2 run today?` });
  }
  // Guard: universe must exist
  if (!universeFile?.data) {
    return res.status(404).json({ error: `universe-${date}.json not found or missing .data field. Has Step 1 run today?` });
  }
  // STALENESS GUARD — Standard v1.1: universe.date must equal today
  if (universeFile.date && universeFile.date !== date) {
    return res.status(400).json({
      error: `STALENESS: universe.date=${universeFile.date} !== today=${date}. Refusing to score. Re-run Step 1 and Step 2 first.`,
    });
  }

  const deepData   = deepFile.data;                         // { SYM: { rsi, sma50, ... } }
  const universeRaw = universeFile.data;                    // array OR object
  const histStocks  = historyRaw?.stocks || historyRaw || {}; // handles both old + new formats
  const holdings    = portfolioFile?.holdings || [];

  // ── 2. Normalise universe to an array ──────────────────────────────────────
  const universeArr = Array.isArray(universeRaw)
    ? universeRaw
    : Object.entries(universeRaw).map(([symbol, v]) =>
        ({ symbol, ...(typeof v === 'object' && v ? v : {}) })
      );

  const portfolioSyms = new Set(holdings.map(h => h.sym));

  // ── 3. Build working stock array ───────────────────────────────────────────
  const stocks = [];
  for (const u of universeArr) {
    const sym = u.symbol || u.sym;
    if (!sym) continue;
    const d = deepData[sym] || {};

    // Derive booleans if not already in deep data
    const above_sma50  = d.above_sma50  ?? (d.price && d.sma50  ? d.price > d.sma50  : null);
    const above_sma200 = d.above_sma200 ?? (d.price && d.sma200 ? d.price > d.sma200 : null);
    const golden_cross = d.golden_cross ?? (d.sma50  && d.sma200 ? d.sma50 > d.sma200 : null);

    stocks.push({
      symbol:            sym,
      sector:            u.sector || d.sector || null,
      price:             d.price ?? null,
      change5d:          d.change5d ?? null,
      rsi:               d.rsi ?? null,
      sma50:             d.sma50 ?? null,
      sma200:            d.sma200 ?? null,
      above_sma50,
      above_sma200,
      golden_cross,
      adx:               d.adx ?? null,
      williams:          d.williams ?? null,
      from_52w_high_pct: d.from_52w_high_pct ?? null,
      from_52w_low_pct:  d.from_52w_low_pct  ?? null,
      volume_ratio_20d:  d.volume_ratio_20d  ?? null,
      peg:               d.peg ?? null,
      fcf_yield:         d.fcf_yield ?? null,
      roic:              d.roic ?? null,
      roe:               d.roe  ?? null,
      debt_to_equity:    d.debt_to_equity ?? null,
      analyst_target:    d.analyst_target ?? null,      // null until Step 5 adds analyst deep-chunk
      recent_grades:     d.recent_grades  ?? null,      // null until Step 5
      upcoming_earnings: d.upcoming_earnings ?? null,
      _hist:             histStocks[sym] ?? null,
    });
  }

  // ── 4. Compute raw indicator values ────────────────────────────────────────
  stocks.forEach(s => {
    s._raw = {
      // ── L1 Technical ──────────────────────────────────────────────────────
      rsi_q:         rsiQuality(s.rsi, s.above_sma50, s.above_sma200),   // sweet-spot conditional
      sma50_dist_q:  sma50DistQuality(s.price, s.sma50),                  // sweet-spot
      golden_cross:  s.golden_cross  === true ? 1 : (s.golden_cross  === false ? 0 : null),  // binary→up
      above_sma200:  s.above_sma200  === true ? 1 : (s.above_sma200  === false ? 0 : null),  // binary→up
      // ── L2 Momentum / Persistence ─────────────────────────────────────────
      change5d_q:    change5dQuality(s.change5d),                          // sweet-spot
      streak:        computeStreak(s._hist),                                // monotonic-up
      // ── L3 External / Sentiment (NULL until analyst data added to deep-chunk) ──
      analyst_upside: analystUpsideRaw(s.analyst_target, s.price),          // monotonic-up
      recent_upgrade: recentUpgradeRaw(s.recent_grades),                     // binary→up
      consensus_tilt: consensusTiltRaw(s.recent_grades),                     // monotonic-up
      // ── L4 Valuation ──────────────────────────────────────────────────────
      peg_q:         pegQuality(s.peg),                                     // sweet-spot
      fcf_yield:     (s.fcf_yield !== null && s.fcf_yield !== undefined) ? s.fcf_yield : null,  // monotonic-up (decimal)
      // ── L5 Fundamental ────────────────────────────────────────────────────
      roic:          (s.roic !== null && s.roic !== undefined) ? s.roic : null,  // monotonic-up
      roe:           (s.roe  !== null && s.roe  !== undefined) ? s.roe  : null,  // monotonic-up
      de_neg:        (s.debt_to_equity !== null && s.debt_to_equity !== undefined)
                       ? -s.debt_to_equity   // NEGATED: lower D/E → higher raw → higher rank
                       : null,
    };
  });

  // ── 5. Cross-sectional percentile rank per indicator ───────────────────────
  // Build a {symbol → percentile} map for each indicator
  function pctMap(rawField) {
    const eligible = stocks
      .filter(s => s._raw[rawField] !== null && s._raw[rawField] !== undefined && isFinite(s._raw[rawField]))
      .map(s => ({ symbol: s.symbol, value: s._raw[rawField] }));
    return xsPercentileRanks(eligible);
  }

  const pct = {
    // L1 Technical
    rsi:           pctMap('rsi_q'),
    sma50_dist:    pctMap('sma50_dist_q'),
    golden_cross:  pctMap('golden_cross'),
    above_sma200:  pctMap('above_sma200'),
    // L2 Momentum
    change5d:      pctMap('change5d_q'),
    streak:        pctMap('streak'),
    // L3 External
    analyst_up:    pctMap('analyst_upside'),
    upgrade:       pctMap('recent_upgrade'),
    consensus:     pctMap('consensus_tilt'),
    // L4 Valuation
    peg:           pctMap('peg_q'),
    fcf_yield:     pctMap('fcf_yield'),
    // L5 Fundamental
    roic:          pctMap('roic'),
    roe:           pctMap('roe'),
    de:            pctMap('de_neg'),    // de_neg was already negated → higher = less debt = better
  };

  const IND_TOTAL = 14;   // indicators #1-15, excluding #10 (Fit — post-composite)

  // ── 6. Layer scores + renormalized composite per stock ─────────────────────
  stocks.forEach(s => {
    const sym = s.symbol;

    // Indicator percentiles for this stock (null if not ranked = data missing)
    const p = {
      rsi:          pct.rsi[sym]          ?? null,
      sma50_dist:   pct.sma50_dist[sym]   ?? null,
      golden_cross: pct.golden_cross[sym] ?? null,
      above_sma200: pct.above_sma200[sym] ?? null,
      change5d:     pct.change5d[sym]      ?? null,
      streak:       pct.streak[sym]        ?? null,
      analyst_up:   pct.analyst_up[sym]   ?? null,
      upgrade:      pct.upgrade[sym]       ?? null,
      consensus:    pct.consensus[sym]     ?? null,
      peg:          pct.peg[sym]           ?? null,
      fcf_yield:    pct.fcf_yield[sym]     ?? null,
      roic:         pct.roic[sym]          ?? null,
      roe:          pct.roe[sym]           ?? null,
      de:           pct.de[sym]            ?? null,
    };

    // Layer scores = average of available (non-null) indicators within each layer
    const L1 = avgNonNull([p.rsi, p.sma50_dist, p.golden_cross, p.above_sma200]);
    const L2 = avgNonNull([p.change5d, p.streak]);
    const L3 = avgNonNull([p.analyst_up, p.upgrade, p.consensus]);
    const L4 = avgNonNull([p.peg, p.fcf_yield]);
    const L5 = avgNonNull([p.roic, p.roe, p.de]);

    const layerScores = { L1, L2, L3, L4, L5 };
    const layers_used = Object.values(layerScores).filter(v => v !== null).length;

    // Renormalized composite: Σ(weight × layer) / Σ(weight of non-null layers)
    // This means a stock with only L1+L2 data gets scored honestly on those layers,
    // not penalised for missing L3-L5. (Standard §5.3)
    let wSum = 0, wTotal = 0;
    Object.entries(SCORE_CONFIG.LAYERS).forEach(([k, cfg]) => {
      if (layerScores[k] !== null) {
        wSum   += cfg.weight * layerScores[k];
        wTotal += cfg.weight;
      }
    });

    // Scale to 0-100, 2 decimal places
    const base_score = wTotal > 0
      ? Math.round((wSum / wTotal) * 10000) / 100
      : null;

    const ind_available = Object.values(p).filter(v => v !== null).length;

    s._score = {
      base_score,
      layers_used,
      display_eligible:  layers_used >= SCORE_CONFIG.DISPLAY_MIN_LAYERS,
      data_completeness: Math.round(ind_available / IND_TOTAL * 100),   // % of 14 indicators present
      score_breakdown: {
        indicators: p,
        layers:     { L1, L2, L3, L4, L5 },
        weights_applied: Object.fromEntries(
          Object.entries(SCORE_CONFIG.LAYERS).map(([k, cfg]) => [k, layerScores[k] !== null ? cfg.weight : 0])
        ),
        total_weight_used: +wTotal.toFixed(4),   // < 1.0 when layers are missing
      },
      in_portfolio:      portfolioSyms.has(sym),          // code set-membership, not LLM
      price_at_score:    s.price,                          // Standard v1.1 §5.7 — returns-log seed
      upcoming_earnings: s.upcoming_earnings,
    };
  });

  // ── 7. Sort: score desc, then symbol asc (deterministic tie-breaker, Standard v1.1) ──
  // IMPORTANT: no Date.now() or Math.random() here — must be 100% deterministic
  stocks.sort((a, b) => {
    const sa = a._score.base_score ?? -Infinity;
    const sb = b._score.base_score ?? -Infinity;
    if (sb !== sa) return sb - sa;
    return a.symbol < b.symbol ? -1 : 1;   // alphabetical on equal scores
  });

  // ── 8. Assign rank + display flags ────────────────────────────────────────
  let displayRank = 0;
  stocks.forEach((s, i) => {
    s._score.rank = i + 1;
    if (s._score.display_eligible && displayRank < SCORE_CONFIG.DISPLAY_TOP) {
      displayRank++;
      s._score.display_rank = displayRank;
      s._score.display      = true;
      s._score.highlight    = displayRank <= SCORE_CONFIG.HIGHLIGHT_TOP;
    } else {
      s._score.display_rank = null;
      s._score.display      = false;
      s._score.highlight    = false;
    }
  });

  // ── 9. Pattern classification (basic — Step 5 will refine with Fit modifier) ──
  stocks.forEach(s => {
    const tags = [];
    const h  = s.from_52w_high_pct;
    const vr = s.volume_ratio_20d;
    // Recovery: down 30-80% from 52w high, recovering
    if (h !== null && h <= -30 && h >= -80) tags.push('Recovery');
    // Breakout: near 52w high, volume surge, above SMAs
    if (h !== null && h >= -10 && s.above_sma50 && s.above_sma200 && vr !== null && vr > 1.5) tags.push('Breakout');
    // Momentum: confirmed trend + healthy RSI + strong ADX
    if (s.above_sma50 && s.above_sma200 && s.rsi !== null && s.rsi >= 50 && s.rsi <= 70 && s.adx !== null && s.adx > 25) tags.push('Momentum');
    s._score.pattern = tags;
  });

  // ── 10. Build output object ────────────────────────────────────────────────
  const scoredData = {};
  stocks.forEach(s => {
    scoredData[s.symbol] = {
      symbol:            s.symbol,
      sector:            s.sector,
      price_at_score:    s._score.price_at_score,
      final_score:       s._score.base_score,
      rank:              s._score.rank,
      display:           s._score.display,
      display_rank:      s._score.display_rank,
      highlight:         s._score.highlight,
      display_eligible:  s._score.display_eligible,
      layers_used:       s._score.layers_used,
      data_completeness: s._score.data_completeness,
      in_portfolio:      s._score.in_portfolio,
      pattern:           s._score.pattern,
      upcoming_earnings: s._score.upcoming_earnings,
      score_breakdown:   s._score.score_breakdown,
    };
  });

  const output = {
    date,
    scored_at:      new Date().toISOString(),    // metadata only — not part of determinism test
    engine_version: 'step4-v1',                  // bump when algo changes
    count:          stocks.length,
    display_eligible_count: stocks.filter(s => s._score.display_eligible).length,
    data:           scoredData,
  };

  // ── 11. Write scored-{date}.json to GitHub ─────────────────────────────────
  const outPath = `data/market/scored-${date}.json`;
  await ghWriteScorer(
    REPO,
    outPath,
    output,
    `score: ${date} — ${stocks.length} stocks, ${stocks.filter(s => s._score.display_eligible).length} display-eligible`,
    GITHUB_TOKEN
  );

  // ── 12. Return summary (not the full file — that's in GitHub) ──────────────
  const top5 = stocks
    .filter(s => s._score.highlight)
    .map(s => ({
      symbol:       s.symbol,
      sector:       s.sector,
      score:        s._score.base_score,
      rank:         s._score.rank,
      layers_used:  s._score.layers_used,
      pattern:      s._score.pattern,
      in_portfolio: s._score.in_portfolio,
      completeness: s._score.data_completeness,
    }));

  return res.status(200).json({
    status:           'ok',
    date,
    engine_version:   'step4-v1',
    scored:           stocks.length,
    display_eligible: stocks.filter(s => s._score.display_eligible).length,
    file_written:     outPath,
    top5,
    layer_coverage: {
      // Shows how many stocks had data for each indicator — L3 will be ~0 until analyst data added
      L1_rsi:            Object.keys(pct.rsi).length,
      L1_sma50_dist:     Object.keys(pct.sma50_dist).length,
      L1_golden_cross:   Object.keys(pct.golden_cross).length,
      L1_above_sma200:   Object.keys(pct.above_sma200).length,
      L2_change5d:       Object.keys(pct.change5d).length,
      L2_streak:         Object.keys(pct.streak).length,
      L3_analyst_upside: Object.keys(pct.analyst_up).length,   // expect ~0 at Step 4
      L3_upgrade:        Object.keys(pct.upgrade).length,       // expect ~0 at Step 4
      L3_consensus:      Object.keys(pct.consensus).length,     // expect ~0 at Step 4
      L4_peg:            Object.keys(pct.peg).length,
      L4_fcf_yield:      Object.keys(pct.fcf_yield).length,
      L5_roic:           Object.keys(pct.roic).length,
      L5_roe:            Object.keys(pct.roe).length,
      L5_de:             Object.keys(pct.de).length,
    },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// ▲▲▲  END STEP 4 SCORING ENGINE — everything above goes BEFORE module.exports  ▲▲▲
// ════════════════════════════════════════════════════════════════════════════

// ─── main ────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  // Auth check
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ', '').trim();
  if (key && key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.query.mode === 'score') return handleScore(req, res);

  const { nickname, include, symbols: symbolsParam } = req.query;
  const wantIntelligence = include === 'intelligence';

  // Hard cap on how many symbols get the deep per-symbol fundamental/target/grade fetches.
  // 100 is aligned with B1's ~100-candidate opportunity-scan count.
  const INTEL_MAX = 100;
  // Optional ?limit= for the intelligence path (default 10). Reject loudly — never silently clamp.
  let intelLimit = 10;
  if (req.query.limit != null && req.query.limit !== '') {
    intelLimit = parseInt(req.query.limit, 10);
    if (isNaN(intelLimit) || intelLimit < 1 || intelLimit > INTEL_MAX) {
      console.error(`[portfolio-for-ai] invalid ?limit=${req.query.limit} — must be an integer 1..${INTEL_MAX}`);
      return res.status(400).json({ error: `Invalid limit: must be an integer 1..${INTEL_MAX}` });
    }
  }

  // ── NEW: ?symbols= mode — deep fetch for opportunity stocks ─────────────────
  if (symbolsParam) {
    const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length === 0) {
      return res.status(400).json({ error: 'No symbols provided' });
    }
    if (symbols.length > INTEL_MAX) {
      console.error(`[portfolio-for-ai] ?symbols= request rejected: ${symbols.length} symbols exceeds hard max ${INTEL_MAX}`);
      return res.status(400).json({ error: `Too many symbols: ${symbols.length} (hard max ${INTEL_MAX})` });
    }

    try {
      // Fetch Yahoo prices for all symbols
      const priceMap = {};
      const priceResults = await Promise.all(
        symbols.map(async sym => {
          try {
            const r = await fetch(
              `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`,
              { headers: { 'User-Agent': UA } }
            );
            if (!r.ok) return { sym, price: null, change5d: null };
            const d = await r.json();
            const result = d?.chart?.result?.[0];
            const price  = result?.meta?.regularMarketPrice || null;
            // 5-day change
            const closes = result?.indicators?.quote?.[0]?.close || [];
            const validCloses = closes.filter(Boolean);
            const change5d = validCloses.length >= 2
              ? +((validCloses[validCloses.length - 1] - validCloses[0]) / validCloses[0] * 100).toFixed(2)
              : null;
            return { sym, price, change5d };
          } catch { return { sym, price: null, change5d: null }; }
        })
      );
      priceResults.forEach(({ sym, price, change5d }) => {
        priceMap[sym] = { price, change5d };
      });

      // Fetch FMP intelligence for all symbols
      // Cover ALL requested symbols (symbols.length ≤ INTEL_MAX, enforced above) — not just the first 10.
      const { techMap, targets, grades, metrics, ratios, earnings } = await fetchIntelligence(symbols, symbols.length);

      // Build structured JSON output keyed by symbol
      const result = {};
      symbols.forEach(sym => {
        const t = techMap[sym] || {};
        const p = priceMap[sym] || {};
        const m = metrics.find(x => x.symbol === sym) || {};
        const r = ratios.find(x => x.symbol === sym) || {};
        const tgt = targets.find(x => x.symbol === sym) || {};
        const gr = grades.filter(x => x.symbol === sym);
        const earn = earnings.filter(e => e.symbol === sym);

        result[sym] = {
          symbol: sym,
          price: p.price || null,
          change5d: p.change5d || null,
          // Technical
          rsi:       t.rsi    || null,
          macd:      t.macd   || null,
          macd_signal: t.signal || null,
          macd_histogram: t.histogram || null,
          sma50:     t.sma50  || null,
          sma200:    t.sma200 || null,
          ema20:     t.ema20  || null,
          bb_stddev: t.bb_stddev || null,
          // Derived signals
          above_sma50:  t.sma50  && p.price ? p.price > t.sma50  : null,
          above_sma200: t.sma200 && p.price ? p.price > t.sma200 : null,
          golden_cross: t.sma50 && t.sma200 ? t.sma50 > t.sma200 : null,
          macd_bullish: t.macd && t.signal ? t.macd > t.signal : null,
          // ── Fundamentals — verified FMP /stable TTM field names (confirmed live, AAPL 2026-06-09) ──
          // DECIMALS (e.g. 0.2715 = 27.15%): margins, roe, roic, roa, fcf_yield, earnings_yield — stored raw, do NOT multiply.
          // RAW numbers: pe, peg, pb, ps, ev_ebitda, debt_to_equity, current_ratio.
          // Uses ?? (not ||) so a legitimate 0 is preserved, not coerced to null.
          // From /ratios-ttm:
          pe_ratio:         r.priceToEarningsRatioTTM        ?? null,
          forward_pe:       null, // not provided by TTM ratios/key-metrics endpoints
          peg:              r.priceToEarningsGrowthRatioTTM  ?? null,
          pb_ratio:         r.priceToBookRatioTTM            ?? null,
          ps_ratio:         r.priceToSalesRatioTTM           ?? null,
          net_margin:       r.netProfitMarginTTM             ?? null, // decimal
          gross_margin:     r.grossProfitMarginTTM           ?? null, // decimal
          operating_margin: r.operatingProfitMarginTTM       ?? null, // decimal
          debt_to_equity:   r.debtToEquityRatioTTM           ?? null,
          current_ratio:    r.currentRatioTTM                ?? null,
          // From /key-metrics-ttm:
          // Prefer ROIC as the quality signal — ROE is buyback-distorted (AAPL ROE ≈ 1.467 = 146%); ROE kept for context only.
          roic:             m.returnOnInvestedCapitalTTM     ?? null, // decimal — primary quality signal
          roe:              m.returnOnEquityTTM              ?? null, // decimal — context only (buyback-distorted)
          roa:              m.returnOnAssetsTTM              ?? null, // decimal
          fcf_yield:        m.freeCashFlowYieldTTM           ?? null, // decimal
          earnings_yield:   m.earningsYieldTTM               ?? null, // decimal
          ev_ebitda:        m.evToEBITDATTM                  ?? null, // key-metrics version (preferred)
          net_debt_to_ebitda: m.netDebtToEBITDATTM           ?? null,
          // TODO(follow-up): wire real revenue_growth via /financial-growth or /income-statement-growth
          //                  — matters for the growth-investor profile.
          revenue_growth:   null, // not on TTM endpoints
          // Analyst
          analyst_target:  tgt.targetConsensus  || null,
          analyst_high:    tgt.targetHigh       || null,
          analyst_low:     tgt.targetLow        || null,
          analyst_consensus: tgt.targetConsensus || null,
          recent_grades:   gr.slice(0, 3),
          // Earnings
          upcoming_earnings: earn.slice(0, 2),
          // Sharia / leverage indicators (from /ratios-ttm)
          debt_to_equity_ratio: r.debtToEquityRatioTTM ?? null,
          // interestCoverageRatioTTM returns 0 for cash-rich names (no debt) → treat 0 as null
          interest_coverage:    (r.interestCoverageRatioTTM && r.interestCoverageRatioTTM !== 0) ? r.interestCoverageRatioTTM : null,
        };
      });

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).json({
        mode: 'symbols',
        date: todayUAE(),
        symbols_requested: symbols.length,
        symbols_with_data: Object.values(result).filter(s => s.price !== null).length,
        data: result
      });

    } catch (e) {
      return res.status(500).json({ error: `Symbols fetch failed: ${e.message}` });
    }
  }

  // ── Original portfolio mode ──────────────────────────────────────────────
  try {
    let holdings = [];
    let cash = {};
    let investorName = 'Rashed';
    let isGenericUser = false;

    if (nickname && nickname !== 'rashed') {
      investorName = nickname.charAt(0).toUpperCase() + nickname.slice(1);
      isGenericUser = true;
      const FILE = `data/portfolio-${nickname}.json`;
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/${FILE}?t=${Date.now()}`
      );
      if (!raw.ok) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(`Portfolio for ${investorName} is empty or not found.\nNo stocks to analyze.`);
      }
      const portfolio = await raw.json();
      const userStocks = portfolio.stocks || [];
      if (userStocks.length === 0) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(`Portfolio for ${investorName} is empty.\nNo stocks to analyze.`);
      }
      holdings = userStocks.map(s => ({
        sym: s.sym, shares: s.shares || (s.mv / s.cost),
        cost: s.cost, sector: s.sec || 'tech', name: s.en || s.sym
      }));

    } else {
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/data/portfolio.json?t=${Date.now()}`
      );
      if (!raw.ok) throw new Error('Cannot read portfolio.json');
      const portfolio = await raw.json();
      holdings = portfolio.holdings || [];
      cash = portfolio.cash_summary || {};
    }

    const symbols  = holdings.map(h => h.sym);
    const ownedSet = new Set(symbols);

    // Live prices (Yahoo Finance)
    const priceMap = {};
    const priceResults = await Promise.all(
      symbols.map(async sym => {
        try {
          const r = await fetch(
            `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
            { headers: { 'User-Agent': UA } }
          );
          if (!r.ok) return { sym, price: null };
          const d = await r.json();
          return { sym, price: d?.chart?.result?.[0]?.meta?.regularMarketPrice || null };
        } catch { return { sym, price: null }; }
      })
    );
    priceResults.forEach(({ sym, price }) => { priceMap[sym] = price; });

    // Calculate totals
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price = priceMap[h.sym] || h.cost;
      const value = Math.round(h.shares * price);
      const glPct = ((price - h.cost) / h.cost * 100);
      totalValue += value;
      return { ...h, livePrice: price, value, glPct };
    });
    enriched.sort((a, b) => b.value - a.value);

    // Group by sector
    const sectors = {
      tech:   { label: 'TECHNOLOGY',  items: [] },
      spec:   { label: 'SPECULATIVE', items: [] },
      bio:    { label: 'BIOTECH',     items: [] },
      mining: { label: 'MINING',      items: [] },
      etf:    { label: 'ETFs',        items: [] },
      other:  { label: 'OTHER',       items: [] },
    };
    enriched.forEach(h => { (sectors[h.sector] || sectors.other).items.push(h); });

    // Format portfolio text
    const pricesAvailable = Object.values(priceMap).filter(Boolean).length;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    let text = '';
    text += `═══════════════════════════════════════════════════════\n`;
    text += `${investorName.toUpperCase()}'S PORTFOLIO — Live as of ${timestamp}\n`;
    text += `Total Value: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
    text += `Live prices: ${pricesAvailable}/${symbols.length} stocks updated\n`;
    text += `═══════════════════════════════════════════════════════\n`;

    if (!isGenericUser) {
      text += `INVESTOR RULES (apply to all recommendations):\n`;
      text += `- UAE investor — ZERO capital gains tax on profits\n`;
      text += `- Cannot short sell or trade options (Wio Invest)\n`;
      text += `- SPUS = Sharia-compliant ETF — never recommend selling\n`;
      text += `- US market opens 5:30pm UAE time\n`;
      text += `- Long-term growth investor, high risk tolerance\n`;
    } else {
      text += `INVESTOR: ${investorName}, UAE investor\n`;
      text += `- Long-term growth focus\n`;
    }
    text += `═══════════════════════════════════════════════════════\n\n`;

    Object.values(sectors).forEach(sec => {
      if (sec.items.length === 0) return;
      text += `${sec.label}:\n`;
      sec.items.forEach(h => {
        const glSign = h.glPct >= 0 ? '+' : '';
        text += `${h.sym.padEnd(6)} ${String(h.shares).padEnd(10)} sh  `;
        text += `cost $${String(h.cost.toFixed(2)).padEnd(8)}  `;
        text += `now $${String(h.livePrice.toFixed(2)).padEnd(8)}  `;
        text += `value $${h.value.toLocaleString().padEnd(8)}  `;
        text += `${glSign}${h.glPct.toFixed(1)}%\n`;
      });
      text += '\n';
    });

    text += `═══════════════════════════════════════════════════════\n`;
    text += `TOTAL PORTFOLIO VALUE: $${totalValue.toLocaleString()}\n`;
    if (!isGenericUser && cash.fresh_cash_deposited) {
      const roi = (((totalValue - cash.fresh_cash_deposited) / cash.fresh_cash_deposited) * 100).toFixed(1);
      text += `Return on cash invested: +${roi}%\n`;
    }
    text += `═══════════════════════════════════════════════════════\n`;

    // Intelligence block
    if (wantIntelligence) {
      let moverSyms = [];
      try {
        const mdr = await fetch(
          `https://raw.githubusercontent.com/${REPO}/main/data/market-data-${todayUAE()}.json?t=${Date.now()}`
        );
        if (mdr.ok) {
          const md  = await mdr.json();
          const str = typeof md === 'string' ? md : JSON.stringify(md);
          const matches = str.match(/"ticker"\s*:\s*"([A-Z]{1,6})"/g) || [];
          moverSyms = [...new Set(
            matches.map(m => m.match(/"([A-Z]{1,6})"/)?.[1]).filter(Boolean)
          )].slice(0, 20);
        }
      } catch { /* market data not yet available — skip */ }

      const allSyms = [...new Set([...symbols, ...moverSyms])];
      const { techMap, targets, grades, metrics, earnings } = await fetchIntelligence(allSyms, intelLimit);

      // Add BB bands using price
      Object.entries(techMap).forEach(([sym, t]) => {
        if (t.bb_stddev !== null && priceMap[sym]) {
          t.bb_upper = +(priceMap[sym] + 2 * t.bb_stddev).toFixed(2);
          t.bb_lower = +(priceMap[sym] - 2 * t.bb_stddev).toFixed(2);
        }
      });

      // Signal interpretation
      Object.entries(techMap).forEach(([sym, t]) => {
        const price = priceMap[sym];
        const signals = [];
        if (t.rsi !== null) {
          if (t.rsi > 70)      signals.push(`RSI ${t.rsi} — OVERBOUGHT`);
          else if (t.rsi < 30) signals.push(`RSI ${t.rsi} — OVERSOLD`);
          else                 signals.push(`RSI ${t.rsi} — neutral`);
        }
        if (t.macd !== null && t.signal !== null) {
          if (t.macd > t.signal && t.histogram > 0) signals.push('MACD bullish crossover ↑');
          else if (t.macd < t.signal && t.histogram < 0) signals.push('MACD bearish crossover ↓');
          else signals.push('MACD neutral');
        }
        if (t.sma50 !== null && t.sma200 !== null) {
          if (t.sma50 > t.sma200) signals.push('Golden Cross ✅ (SMA50 > SMA200)');
          else signals.push('Death Cross ⚠️ (SMA50 < SMA200)');
        }
        if (price && t.ema20 !== null) {
          if (price > t.ema20) signals.push(`Price above EMA20 (${t.ema20}) — short-term bullish`);
          else signals.push(`Price below EMA20 (${t.ema20}) — short-term bearish`);
        }
        if (t.bb_upper && t.bb_lower && price) {
          const bbWidth = t.bb_upper - t.bb_lower;
          if (price >= t.bb_upper)      signals.push(`At BB upper band (${t.bb_upper}) — extended`);
          else if (price <= t.bb_lower) signals.push(`At BB lower band (${t.bb_lower}) — compressed`);
          else {
            const bbPct = ((price - t.bb_lower) / bbWidth * 100).toFixed(0);
            signals.push(`BB position: ${bbPct}% (lower=${t.bb_lower}, upper=${t.bb_upper})`);
          }
        }
        t.signals = signals;
      });

      text += `\n═══════════════════════════════════════════════════════\n`;
      text += `MARKET INTELLIGENCE — ${todayUAE()}\n`;
      text += `Portfolio symbols: ${symbols.join(', ')}\n`;
      text += `Market movers tracked: ${moverSyms.join(', ') || 'none yet'}\n`;
      text += `═══════════════════════════════════════════════════════\n\n`;

      text += `TECHNICAL INDICATORS (all ${symbols.length} portfolio stocks):\n`;
      text += `${'SYM'.padEnd(7)} ${'RSI'.padEnd(8)} ${'MACD'.padEnd(10)} ${'SMA50'.padEnd(9)} ${'SMA200'.padEnd(9)} ${'EMA20'.padEnd(9)} BB_UPPER / BB_LOWER\n`;
      text += `─────────────────────────────────────────────────────────────────────────────\n`;
      symbols.forEach(sym => {
        const t = techMap[sym] || {};
        text += `${sym.padEnd(7)} `;
        text += `${(t.rsi    !== null ? String(t.rsi)    : 'N/A').padEnd(8)} `;
        text += `${(t.macd   !== null ? String(t.macd)   : 'N/A').padEnd(10)} `;
        text += `${(t.sma50  !== null ? String(t.sma50)  : 'N/A').padEnd(9)} `;
        text += `${(t.sma200 !== null ? String(t.sma200) : 'N/A').padEnd(9)} `;
        text += `${(t.ema20  !== null ? String(t.ema20)  : 'N/A').padEnd(9)} `;
        text += `${t.bb_upper || 'N/A'} / ${t.bb_lower || 'N/A'}\n`;
      });
      text += `\n`;

      text += `SIGNAL INTERPRETATION:\n`;
      symbols.forEach(sym => {
        const t = techMap[sym] || {};
        if (t.signals && t.signals.length > 0) {
          text += `${sym}: ${t.signals.join(' | ')}\n`;
        }
      });
      text += `\n`;

      text += `EARNINGS CALENDAR (next 60 days — portfolio stocks first):\n`;
      text += JSON.stringify({
        portfolio: earnings.filter(e => ownedSet.has(e.symbol)),
        movers:    earnings.filter(e => !ownedSet.has(e.symbol)).slice(0, 10)
      }, null, 2) + '\n\n';

      text += `ANALYST PRICE TARGETS:\n`;
      text += JSON.stringify(targets, null, 2) + '\n\n';

      text += `ANALYST GRADES (recent):\n`;
      text += JSON.stringify(grades, null, 2) + '\n\n';

      text += `KEY METRICS TTM (P/E, ROE, margins etc):\n`;
      text += JSON.stringify(metrics, null, 2) + '\n';

      text += `\n═══════════════════════════════════════════════════════\n`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch (e) {
    res.status(500).send(`Portfolio data unavailable: ${e.message}`);
  }
};
