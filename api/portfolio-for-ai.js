// api/portfolio-for-ai.js 
// Returns portfolio as formatted plain text for Claude
// Supports ?nickname=ahmed for per-user portfolios
// Supports ?include=intelligence for smart FMP data (earnings, targets, grades, metrics, technicals)
// Supports ?mode=build-universe (GET ?date=YYYY-MM-DD) — universe dedup/filter for scenario 922
// Default (no nickname): reads Rashed's portfolio.json

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const FMP_KEY = process.env.FMP_API_KEY || process.env.FMP_KEY || 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
const FMP     = 'https://financialmodelingprep.com/stable';

// ─── FMP helper ──────────────────────────────────────────────────────────────
async function fmpGet(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000); // 8s timeout per FMP call
    const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`, { signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) {
      if (r.status === 429) console.error(`fmpGet 429 RATE LIMIT: ${path.split('?')[0]}`);
      else if (r.status === 401) console.error(`fmpGet 401 INVALID KEY: ${path.split('?')[0]}`);
      else console.error(`fmpGet ${r.status}: ${path.split('?')[0]}`);
      return null;
    }
    const d = await r.json();
    return Array.isArray(d) ? d : (d?.Error ? null : d);
  } catch (e) {
    console.error(`fmpGet TIMEOUT/ERR: ${e.message} — ${path.split('?')[0]}`);
    return null;
  }
}

function todayUAE() {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

// ════════════════════════════════════════════════════════════════════════════
// DATA QUALITY GATE (Session 29) — deterministic validation BEFORE any
// scoring, ranking, or LLM analysis. Rules never delete a stock; they null
// the corrupt metric (the scorer renormalizes around nulls) and record a flag.
// ════════════════════════════════════════════════════════════════════════════
function yesterdayUAE() {
  return new Date(Date.now() + 4 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
}

// Validate one universe stock IN PLACE before scoring. Returns {flags, confidence}.
function validateScoringStock(s, prevPrice) {
  const flags = [];
  const bad = (field, rule, value) => { flags.push({ field, rule, value }); s[field] = null; };
  const n = v => (v == null || isNaN(Number(v))) ? null : Number(v);

  const pe = n(s.pe_ratio);
  if (pe != null && (pe <= 0 || pe > 500)) bad('pe_ratio', 'bounds_0_500', pe);
  const peg = n(s.peg);
  if (peg != null && (peg <= 0 || peg > 50)) bad('peg', 'bounds_0_50', peg);
  const roe = n(s.roe);
  if (roe != null && Math.abs(roe) > 1000) bad('roe', 'bounds_abs_1000', roe);
  const roic = n(s.roic);
  if (roic != null && Math.abs(roic) > 1000) bad('roic', 'bounds_abs_1000', roic);
  const fcf = n(s.fcf_yield);
  if (fcf != null && Math.abs(fcf) > 100) bad('fcf_yield', 'bounds_abs_100', fcf);
  const de = n(s.debt_to_equity);
  if (de != null && Math.abs(de) > 100) bad('debt_to_equity', 'bounds_abs_100', de);
  const c5 = n(s.change5d);
  if (c5 != null && Math.abs(c5) > 60) bad('change5d', 'bounds_abs_60', c5);

  // Anchor: analyst target must be within 0.2×–5× of price, else it is corrupt
  const price = n(s.price), tgt = n(s.analyst_target);
  if (price != null && price > 0 && tgt != null) {
    if (tgt <= 0 || tgt < price * 0.2 || tgt > price * 5) bad('analyst_target', 'anchor_vs_price', tgt);
  }
  // Day-over-day: >50% price jump vs yesterday's scored price = glitch or split.
  // Flag only (do NOT null price — splits are real); confidence drops.
  if (price != null && prevPrice != null && prevPrice > 0) {
    const jump = Math.abs(price / prevPrice - 1);
    if (jump > 0.5) flags.push({ field: 'price', rule: 'day_jump_gt_50pct', value: +(jump * 100).toFixed(1) });
  }
  const confidence = flags.length === 0 ? 'high' : (flags.length <= 2 ? 'medium' : 'low');
  return { flags, confidence };
}

// Validate the lookup data object IN PLACE. Returns {flags, confidence, notesAr}.
function validateLookupData(d) {
  const flags = [];
  const notes = [];
  const bad = (field, rule, value, noteAr) => { flags.push({ field, rule, value }); d[field] = null; if (noteAr) notes.push(noteAr); };
  const n = v => (v == null || isNaN(Number(v))) ? null : Number(v);

  if (n(d.pe) != null && (d.pe <= 0 || d.pe > 500)) bad('pe', 'bounds_0_500', d.pe, 'مكرر الربحية خارج النطاق المنطقي — تم إخفاؤه');
  if (n(d.peg) != null && (d.peg <= 0 || d.peg > 50)) bad('peg', 'bounds_0_50', d.peg, 'مؤشر PEG غير منطقي — تم إخفاؤه');
  if (n(d.roe) != null && Math.abs(d.roe) > 150) bad('roe', 'bounds_abs_150', d.roe, 'العائد على حقوق الملكية خارج النطاق — تم إخفاؤه');
  if (n(d.beta) != null && (d.beta < 0 || d.beta > 4)) bad('beta', 'bounds_0_4', d.beta);
  if (n(d.revenueGrowth) != null && (d.revenueGrowth < -60 || d.revenueGrowth > 300))
    bad('revenueGrowth', 'bounds_-60_300', d.revenueGrowth, 'نمو الإيرادات المحسوب غير موثوق — تم إخفاؤه');

  const price = n(d.price), tgt = n(d.targetMean), dcf = n(d.dcfValue);
  // Analyst target vs price anchor
  if (price && tgt != null && (tgt <= 0 || tgt < price * 0.2 || tgt > price * 5))
    bad('targetMean', 'anchor_vs_price', tgt, 'هدف المحللين المستلم غير منطقي مقابل السعر — تم إخفاؤه');
  // Range fields: high may run hotter (up to 8×), low may run colder (down to 0.1×)
  ['targetMedian', 'targetHigh', 'targetLow'].forEach(k => {
    const v = n(d[k]);
    if (price && v != null && (v <= 0 || v < price * 0.1 || v > price * 8)) bad(k, 'range_vs_price', v);
  });
  if (n(d.targetLow) != null && n(d.targetHigh) != null && d.targetLow > d.targetHigh) {
    bad('targetLow', 'low_gt_high', d.targetLow); bad('targetHigh', 'low_gt_high', d.targetHigh);
  }

  // One-time-charge distortion: one fiscal year's net income wildly off vs the others
  let onetime = false;
  if (Array.isArray(d.financials) && d.financials.length >= 3) {
    const nis = d.financials.map(f => n(f.netIncome)).filter(v => v != null);
    if (nis.length >= 3) {
      const sorted = [...nis].map(Math.abs).sort((a, b) => a - b);
      const maxAbs = sorted[sorted.length - 1], secondAbs = sorted[sorted.length - 2] || 0;
      const signs = new Set(nis.map(v => Math.sign(v)));
      if (secondAbs > 0 && maxAbs > 3 * secondAbs && signs.size > 1) onetime = true;
    }
  }
  // DCF: positive, sane vs price, sane vs analyst anchor, and never trusted under one-time distortion
  if (dcf != null) {
    if (dcf <= 0) bad('dcfValue', 'negative_dcf', dcf, 'نموذج القيمة العادلة أعطى رقماً مستحيلاً (سالباً) — تم إخفاؤه');
    else if (price && (dcf < price * 0.2 || dcf > price * 5)) bad('dcfValue', 'bounds_vs_price', dcf, 'تقدير القيمة العادلة بعيد جداً عن السعر — غير موثوق وتم إخفاؤه');
    else if (n(d.targetMean) && (dcf < d.targetMean * 0.33 || dcf > d.targetMean * 3)) bad('dcfValue', 'anchor_vs_analysts', dcf, 'تقدير النموذج يتباعد كثيراً عن إجماع المحللين — اعتمدنا هدف المحللين بدلاً منه');
    else if (onetime) bad('dcfValue', 'onetime_distortion', dcf, 'الشركة لديها خسارة/ربح استثنائي لمرة واحدة يشوّه نموذج القيمة العادلة — تم إخفاؤه');
  }
  if (onetime) flags.push({ field: 'financials', rule: 'onetime_distortion', value: null });

  const confidence = flags.length === 0 ? 'high' : (flags.length <= 2 ? 'medium' : 'low');
  return { flags, confidence, notesAr: notes };
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

  const date = todayUAE();

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
  if (!universeFile?.data && !universeFile?.universe) {
    return res.status(404).json({ error: `universe-${date}.json not found or missing data. Has Step 1 run today?` });
  }
  // STALENESS GUARD — Standard v1.1: universe.date must equal today
  if (universeFile.date && universeFile.date !== date) {
    return res.status(400).json({
      error: `STALENESS: universe.date=${universeFile.date} !== today=${date}. Refusing to score. Re-run Step 1 and Step 2 first.`,
    });
  }

  const deepData   = deepFile.data;                         // { SYM: { rsi, sma50, ... } }
  const universeRaw = universeFile.data || universeFile.universe;                    // array OR object
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
      pe_ratio:          d.pe_ratio ?? null,
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

  // ── 3.5 DATA QUALITY GATE (Session 29) ─────────────────────────────────────
  // Validate every stock BEFORE any indicator/scoring math. Corrupt metrics are
  // nulled (scorer renormalizes); flags are logged; low-confidence stocks are
  // later excluded from the displayed top list.
  const _dqLog = [];
  let _prevPriceMap = {};
  try {
    const prevScored = await ghReadScorer(REPO, `data/market/scored-${yesterdayUAE()}.json`);
    (prevScored?.data || []).forEach(p => { if (p.symbol && p.price_at_score != null) _prevPriceMap[p.symbol] = p.price_at_score; });
  } catch {}
  stocks.forEach(s => {
    const r = validateScoringStock(s, _prevPriceMap[s.symbol]);
    if (r.flags.length) {
      s._dq = r;
      r.flags.forEach(f => _dqLog.push({ date, symbol: s.symbol, ...f }));
    }
  });
  if (_dqLog.length) console.log(`quality-gate: ${_dqLog.length} flags across ${new Set(_dqLog.map(f=>f.symbol)).size} stocks`);

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

  // ── 6b. Fit modifier (Standard §5.4 — post-composite, personal) ────────────
  // Compute portfolio sector weights.
  // NOTE: `portfolioSectors` is built here (was not previously defined). Holdings
  //       use `sec` (dashboard sector code) or `sector`; both handled, lowercased.
  const portfolioSectors = {};
  holdings.forEach(h => {
    const hs = (h.sec || h.sector || '').toLowerCase();
    if (hs) portfolioSectors[hs] = (portfolioSectors[hs] || 0) + 1;
  });
  const totalHoldings = holdings.length || 1;

  // Apply Fit modifier per stock (Standard §5.4 — post-composite, personal)
  // Maps FMP full sector names → portfolio dashboard codes
  const SECTOR_MAP = {
    'technology':               'tech',
    'communication services':   'tech',
    'consumer cyclical':        'spec',
    'consumer defensive':       'spec',
    'financial services':       'spec',
    'real estate':              'spec',
    'utilities':                'spec',
    'industrials':              'spec',
    'energy':                   'mining',
    'basic materials':          'mining',
    'healthcare':               'bio',
  };

  function fitAdjustment(stockSector) {
    if (!stockSector) return 0;
    const mapped = SECTOR_MAP[stockSector.toLowerCase()] || 'other';
    const count = portfolioSectors[mapped] || 0;
    const overlapPct = count / totalHoldings * 100;
    if (overlapPct < 10)  return  5;
    if (overlapPct < 20)  return  2;
    if (overlapPct < 35)  return  0;
    if (overlapPct < 50)  return -2;
    return -5;
  }

  stocks.forEach(s => {
    const adj = fitAdjustment(s.sector);
    s._score.fit_adjustment = adj;
    s._score.final_score = s._score.base_score !== null
      ? Math.round(Math.min(100, Math.max(0, s._score.base_score + adj)) * 100) / 100
      : null;
  });

  // ── 7. Sort: score desc, then symbol asc (deterministic tie-breaker, Standard v1.1) ──
  // IMPORTANT: no Date.now() or Math.random() here — must be 100% deterministic
  stocks.sort((a, b) => {
    const sa = a._score.final_score ?? -Infinity;
    const sb = b._score.final_score ?? -Infinity;
    if (sb !== sa) return sb - sa;
    return a.symbol < b.symbol ? -1 : 1;   // alphabetical on equal scores
  });

  // ── 8. Assign rank + display flags ────────────────────────────────────────
  let displayRank = 0;
  stocks.forEach((s, i) => {
    s._score.rank = i + 1;
    if (s._score.display_eligible && (!s._dq || s._dq.confidence !== 'low') && displayRank < SCORE_CONFIG.DISPLAY_TOP) {
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

  // ── 9. Pattern classification ──────────────────────────────────────────────
  // Medians for Value pattern
  const fcfArr = stocks.filter(s => s.fcf_yield !== null).map(s => s.fcf_yield).sort((a,b)=>a-b);
  const medianFcf = fcfArr.length ? fcfArr[Math.floor(fcfArr.length / 2)] : null;

  const sectorPeMap = {};
  stocks.forEach(s => {
    if (s.sector && s.pe_ratio !== null && s.pe_ratio > 0) {
      if (!sectorPeMap[s.sector]) sectorPeMap[s.sector] = [];
      sectorPeMap[s.sector].push(s.pe_ratio);
    }
  });
  const sectorMedianPe = {};
  Object.entries(sectorPeMap).forEach(([sec, arr]) => {
    arr.sort((a,b)=>a-b);
    sectorMedianPe[sec] = arr[Math.floor(arr.length / 2)];
  });

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
    // Value: cheap on PEG + FCF yield above median + PE below sector median
    if (s.peg !== null && s.peg < 1.2 &&
        medianFcf !== null && s.fcf_yield !== null && s.fcf_yield > medianFcf &&
        s.pe_ratio !== null && s.pe_ratio > 0 &&
        sectorMedianPe[s.sector] && s.pe_ratio < sectorMedianPe[s.sector]) {
      tags.push('Value');
    }
    // Growth: strong return on invested capital
    if (s.roic !== null && s.roic > 0.15) tags.push('Growth');
    s._score.pattern = tags;
  });

  // ── 10. Build output object ────────────────────────────────────────────────
  const scoredData = {};
  stocks.forEach(s => {
    scoredData[s.symbol] = {
      symbol:            s.symbol,
      sector:            s.sector,
      price_at_score:    s._score.price_at_score,
      base_score:        s._score.base_score,
      fit_adjustment:    s._score.fit_adjustment,
      final_score:       s._score.final_score,
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
      data_quality:      s._dq ? { confidence: s._dq.confidence, flags: s._dq.flags } : null,
    };
  });

  const output = {
    date,
    scored_at:      new Date().toISOString(),    // metadata only — not part of determinism test
    engine_version: 'step5-v1', // Step 5 live
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

  // ── 11.5 Append quality flags to the monthly audit log (best-effort) ───────
  if (_dqLog.length) {
    try {
      const month = date.slice(0, 7);
      const logPath = `data/quality/quality-log-${month}.json`;
      const existing = (await ghReadScorer(REPO, logPath)) || { month, entries: [] };
      existing.entries = (existing.entries || []).concat(_dqLog);
      await ghWriteScorer(REPO, logPath, existing, `quality-log: ${date} +${_dqLog.length} flags`, GITHUB_TOKEN);
    } catch (e) { console.error('quality-log write skipped:', e.message); }
  }

  // Update history.json — rolling 28-day log of display stocks (enables streak)
  try {
    const cutoff = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    const existingHistory = await ghReadScorer(REPO, 'data/market/history.json');
    const historyStocks = existingHistory?.stocks || {};

    // Add today's date to every display:true stock
    stocks.filter(s => s._score.display).forEach(s => {
      const sym = s.symbol;
      if (!historyStocks[sym]) historyStocks[sym] = { dates: [], first_seen: date };
      const entry = historyStocks[sym];
      if (!entry.dates.includes(date)) entry.dates.push(date);
      // Prune dates older than 28 calendar days
      entry.dates = entry.dates.filter(d => d >= cutoff).sort();
      entry.appearances_in_window = entry.dates.length;
      entry.last_seen = date;
    });

    const newHistory = {
      _meta: { last_updated: date, window_days: 28 },
      stocks: historyStocks,
    };
    await ghWriteScorer(REPO, 'data/market/history.json', newHistory,
      `history: ${date} — ${stocks.filter(s=>s._score.display).length} display stocks`, GITHUB_TOKEN);
  } catch(e) {
    console.error('history.json update failed (non-fatal):', e.message);
  }

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
    engine_version:   'step5-v1',
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
// Build the full lookup data object for a symbol (shared by both lookup modes)
async function buildLookupData(sym) {
  const to = todayUAE();
  const from = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

  const [profArr, quoteArr, ratiosArr, ptc, gradesArr, consArr, dcfArr, income, cashflow, hist] =
    await Promise.all([
      fmpGet(`/profile?symbol=${sym}`),
      fmpGet(`/quote?symbol=${sym}`),
      fmpGet(`/ratios-ttm?symbol=${sym}`),
      fmpGet(`/price-target-consensus?symbol=${sym}`),
      fmpGet(`/grades?symbol=${sym}&limit=5`),
      fmpGet(`/grades-consensus?symbol=${sym}`),
      fmpGet(`/discounted-cash-flow?symbol=${sym}`),
      fmpGet(`/income-statement?symbol=${sym}&period=annual&limit=3`),
      fmpGet(`/cash-flow-statement?symbol=${sym}&period=annual&limit=3`),
      fmpGet(`/historical-price-eod/light?symbol=${sym}&from=${from}&to=${to}`),
    ]);

  const prof  = Array.isArray(profArr)  ? profArr[0]  : profArr;
  const quote = Array.isArray(quoteArr) ? quoteArr[0] : quoteArr;
  if (!prof && !quote) { const e = new Error(`لم يتم العثور على الرمز ${sym}`); e.code = 404; throw e; }
  const ratios = Array.isArray(ratiosArr) ? ratiosArr[0] : ratiosArr;
  const target = Array.isArray(ptc) ? ptc[0] : ptc;
  const cons   = Array.isArray(consArr) ? consArr[0] : consArr;
  const dcfRow = Array.isArray(dcfArr) ? dcfArr[0] : dcfArr;

  // 3-year financial history table (oldest → newest)
  let financials = null;
  if (Array.isArray(income) && income.length) {
    const inc = [...income].reverse();
    const cf  = Array.isArray(cashflow) ? [...cashflow].reverse() : [];
    financials = inc.map((y, i) => {
      const revenue   = y.revenue ?? null;
      const netIncome = y.netIncome ?? null;
      const yr        = y.fiscalYear ?? y.calendarYear ?? (y.date ? String(y.date).slice(0, 4) : null);
      const fcfRow    = cf.find(c => (c.fiscalYear ?? c.calendarYear ?? (c.date ? String(c.date).slice(0,4) : null)) === yr) || cf[i] || {};
      return {
        label: yr ? `FY${yr}` : (y.date || ''),
        year: yr,
        revenue,
        netIncome,
        netMargin: (revenue && netIncome != null) ? (netIncome / revenue * 100) : null,
        freeCashFlow: fcfRow.freeCashFlow ?? null,
      };
    });
  }
  // revenue growth (latest FY vs previous) from the same data — no extra call
  let revenueGrowth = null;
  if (financials && financials.length >= 2) {
    const a = financials[financials.length - 1].revenue, b = financials[financials.length - 2].revenue;
    if (a && b) revenueGrowth = (a / b - 1) * 100;
  }

  // 1-year weekly-sampled price history for the chart (oldest → newest)
  let priceHistory = null;
  if (Array.isArray(hist) && hist.length) {
    const asc = [...hist].reverse();
    const step = Math.max(1, Math.floor(asc.length / 52));
    priceHistory = asc.filter((_, i) => i % step === 0)
      .map(p => ({ date: p.date, price: p.price ?? p.close ?? null }))
      .filter(p => p.price != null);
  }

  const num = v => (v == null || isNaN(Number(v))) ? null : Number(v);
  const rnd = (v, d=2) => v == null ? null : Number(v.toFixed(d));
  const data = {
    symbol: sym,
    name: prof?.companyName || quote?.name || sym,
    companyName: prof?.companyName || quote?.name || sym,
    sector: prof?.sector || null,
    description: prof?.description || null,
    website: prof?.website || null,
    beta: rnd(num(prof?.beta)),
    price: num(quote?.price ?? prof?.price),
    changePct: rnd(num(quote?.changePercentage ?? quote?.changesPercentage)),
    marketCap: num(quote?.marketCap ?? prof?.marketCap),
    pe: rnd(num(ratios?.priceToEarningsRatioTTM ?? ratios?.peRatioTTM ?? quote?.pe)),
    peg: rnd(num(ratios?.priceToEarningsGrowthRatioTTM ?? ratios?.pegRatioTTM)),
    roe: rnd(num(ratios?.returnOnEquityTTM) != null ? num(ratios?.returnOnEquityTTM) * 100 : null, 1),
    revenueGrowth: rnd(revenueGrowth, 1),
    targetMean: rnd(num(target?.targetConsensus ?? target?.targetMedian)),
    targetMedian: rnd(num(target?.targetMedian)),
    targetHigh: rnd(num(target?.targetHigh)),
    targetLow: rnd(num(target?.targetLow)),
    dcfValue: (() => {
      // FMP's DCF is unreliable on stocks with recent one-time losses (IPO SBC, write-offs etc.)
      // A negative fair value is always a model artifact — suppress it rather than mislead.
      const v = num(dcfRow?.dcf);
      return (v != null && v > 0) ? rnd(v) : null;
    })(),
    analystConsensus: cons?.consensus || null,
    grades: Array.isArray(gradesArr) ? gradesArr.slice(0, 5) : [],
    financials,
    priceHistory,
  };
  const dq = validateLookupData(data);
  return { data, dq };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  // ── MODE: build-universe ──────────────────────────────────────────────────
  if (req.query.mode === 'build-universe') {
    try {
      const date = req.query.date || todayUAE();

      // Read raw screener file that Make.com saved to GitHub
      const rawUrl = `https://raw.githubusercontent.com/${REPO}/main/data/market/screener-raw-${date}.json?t=${Date.now()}`;
      const rawRes = await fetch(rawUrl);
      if (!rawRes.ok) {
        console.error(`build-universe: screener-raw-${date}.json not found (${rawRes.status})`);
        return res.status(404).json({ error: `screener-raw-${date}.json not found — run screener step first` });
      }
      const rawData = await rawRes.json();
      let large    = Array.isArray(rawData.large)    ? rawData.large    : [];
      let mid      = Array.isArray(rawData.mid)      ? rawData.mid      : [];
      let momentum = Array.isArray(rawData.momentum) ? rawData.momentum : [];
      console.log(`build-universe: read from GitHub — large:${large.length} mid:${mid.length} momentum:${momentum.length}`);

      const MIN_DOLLAR_VOLUME = 5_000_000;
      const MAX_UNIVERSE      = 800;

      // Step 1: Union
      const all = [...large, ...mid, ...momentum];
      console.log(`build-universe: raw union=${all.length} (large:${large.length} mid:${mid.length} momentum:${momentum.length})`);

      // Debug: log first stock to verify field names
      if (all.length > 0) {
        console.log(`build-universe: sample stock fields = ${Object.keys(all[0]).join(', ')}`);
        console.log(`build-universe: sample price=${all[0].price} volume=${all[0].volume}`);
      }

      // Step 2: Dedupe by symbol (drop foreign listings with '.')
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

      // Step 3: Dollar-volume floor ($5M/day)
      const filtered = afterDedup.filter(s =>
        (s.price || 0) * (s.volume || 0) >= MIN_DOLLAR_VOLUME
      );
      console.log(`build-universe: after dollar-vol=${filtered.length}`);

      // Step 4: Fail loud if oversized
      if (filtered.length > MAX_UNIVERSE) {
        console.error(`build-universe OVERSIZED: ${filtered.length} — gate too loose?`);
      }

      // Step 5: Sort stable — marketCap desc, ties broken alphabetically
      filtered.sort((a, b) => {
        const d = (b.marketCap || 0) - (a.marketCap || 0);
        return d !== 0 ? d : (a.symbol || '').localeCompare(b.symbol || '');
      });

      // Step 6: Clean output
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

      const today = date || todayUAE();

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
  }
  // ─────────────────────────────────────────────────────────────────────────


  // ── MODE: get-chunks ─────────────────────────────────────────────────────
  // GET ?mode=get-chunks&date=YYYY-MM-DD
  // Reads universe-{date}.json, returns array of 100-symbol batch strings
  // Step 2 of Build Spec v1.1 — called once by Make.com before Iterator
  if (req.query.mode === 'get-chunks') {
    try {
      const date = req.query.date || todayUAE();
      const url = `https://raw.githubusercontent.com/${REPO}/main/data/market/universe-${date}.json?t=${Date.now()}`;
      const r = await fetch(url);
      if (!r.ok) return res.status(404).json({ error: `universe-${date}.json not found` });
      const universe = await r.json();
      const symbols = (universe.universe || []).map(s => s.symbol).filter(Boolean);
      if (symbols.length === 0) return res.status(400).json({ error: 'universe is empty' });

      const CHUNK_SIZE = parseInt(req.query.chunk_size || '25', 10);
      const chunks = [];
      for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
        chunks.push(symbols.slice(i, i + CHUNK_SIZE).join(','));
      }
      console.log(`get-chunks: ${symbols.length} symbols → ${chunks.length} chunks of ${CHUNK_SIZE}`);
      return res.status(200).json({ date, total_symbols: symbols.length, chunk_count: chunks.length, chunks });
    } catch (err) {
      console.error('get-chunks FATAL:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── MODE: deep-chunk ─────────────────────────────────────────────────────
  // GET ?mode=deep-chunk&symbols=SYM1,...,SYM50&date=YYYY-MM-DD
  // Lean fetch: only what the scorer needs. Fast enough for 50 symbols in <10s.
  // Merges into deep-{date}.json on GitHub directly.
  if (req.query.mode === 'deep-chunk') {
    try {
      const date         = req.query.date    || todayUAE();
      const symbolsParam = req.query.symbols || '';
      if (!symbolsParam) return res.status(400).json({ error: 'symbols parameter required' });

      const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
      if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

      const syms = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);
      console.log(`deep-chunk: fetching ${syms.length} symbols for ${date}`);

      // ── Fetch scorer-critical fields only — 5 FMP calls per symbol ────────
      // Keeping calls minimal to stay within Vercel 60s timeout
      // Yahoo price fetched separately (non-FMP, fast)
      const results = await Promise.all(syms.map(async s => {

        // Price + 5d change from Yahoo — with 5s timeout to prevent hangs
        let price = null, change5d = null;
        try {
          const controller = new AbortController();
          const yahooTimeout = setTimeout(() => controller.abort(), 5000);
          const yr = await fetch(
            `https://query2.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=5d`,
            { headers: { 'User-Agent': UA }, signal: controller.signal }
          );
          clearTimeout(yahooTimeout);
          if (yr.ok) {
            const yd = await yr.json();
            const result = yd?.chart?.result?.[0];
            price = result?.meta?.regularMarketPrice || null;
            const closes = result?.indicators?.quote?.[0]?.close || [];
            const validCloses = closes.filter(c => c != null);
            if (validCloses.length >= 2)
              change5d = +((validCloses[validCloses.length-1] - validCloses[0]) / validCloses[0] * 100).toFixed(2);
          }
        } catch { /* silent — timeout or error, price stays null */ }

        // 8 FMP calls per symbol — all parallel
        // Includes Step 3 additions: ADX, Williams, 52w high/low, volume ratio
        const [rsiD, sma50D, sma200D, adxD, williamsD, histD, ratiosD, metricsD] = await Promise.all([
          fmpGet(`/technical-indicators/rsi?symbol=${s}&periodLength=14&timeframe=1day&limit=3`),
          fmpGet(`/technical-indicators/sma?symbol=${s}&periodLength=50&timeframe=1day&limit=1`),
          fmpGet(`/technical-indicators/sma?symbol=${s}&periodLength=200&timeframe=1day&limit=1`),
          fmpGet(`/technical-indicators/adx?symbol=${s}&periodLength=14&timeframe=1day&limit=1`),
          fmpGet(`/technical-indicators/williams?symbol=${s}&periodLength=14&timeframe=1day&limit=3`),
          (() => {
            // Use explicit date range to get exactly 1 year of DAILY prices
            // 'limit' on this endpoint counts weeks not days
            const toDate = new Date(Date.now() + 4*3600*1000).toISOString().slice(0,10);
            const fromDate = new Date(Date.now() + 4*3600*1000 - 365*86400*1000).toISOString().slice(0,10);
            return fmpGet(`/historical-price-eod/light?symbol=${s}&from=${fromDate}&to=${toDate}`);
          })(),  // ~1 year of trading days
          fmpGet(`/ratios-ttm?symbol=${s}`),
          fmpGet(`/key-metrics-ttm?symbol=${s}`)
        ]);

        const sma50  = latest(sma50D,  'sma');
        const sma200 = latest(sma200D, 'sma');
        const r = Array.isArray(ratiosD)  ? ratiosD[0]  : ratiosD;
        const m = Array.isArray(metricsD) ? metricsD[0] : metricsD;

        // ── Compute 52w high/low pct from historical prices ─────────────────
        let from_52w_high_pct = null, from_52w_low_pct = null, volume_ratio_20d = null;
        // FMP historical endpoint returns {symbol, historical:[...]} not plain array
        const histArr = Array.isArray(histD) ? histD : (histD?.historical || []);
        if (histArr.length > 0 && price) {
          // FMP /historical-price-eod/light returns {symbol, date, price, volume}
          const allPrices = histArr.map(d => d.price).filter(p => p && p > 0);
          const volumes = histArr.map(d => d.volume).filter(v => v != null && v > 0);
          if (allPrices.length > 0) {
            // Use 2nd-98th percentile to exclude bad data points at both ends
            const sorted = [...allPrices].sort((a, b) => a - b);
            const p2  = sorted[Math.max(0, Math.floor(sorted.length * 0.02))];
            const p98 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))];
            const prices = sorted.filter(p => p >= p2 && p <= p98);
            if (prices.length > 0) {
              const high52 = Math.max(...prices);
              const low52  = Math.min(...prices);
              from_52w_high_pct = +((price - high52) / high52 * 100).toFixed(2);
              from_52w_low_pct  = +((price - low52)  / low52  * 100).toFixed(2);
            }
          }
          // Volume ratio: today vs 20-day average
          if (volumes.length >= 20) {
            const avg20 = volumes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
            const todayVol = volumes[0];
            if (avg20 > 0) volume_ratio_20d = +(todayVol / avg20).toFixed(3);
          }
        }

        return [s, {
          symbol:    s,
          price,
          change5d,
          rsi:       latest(rsiD, 'rsi'),
          sma50,
          sma200,
          above_sma50:  price && sma50  ? price > sma50  : null,
          above_sma200: price && sma200 ? price > sma200 : null,
          golden_cross: sma50 && sma200 ? sma50 > sma200 : null,
          // Step 3 additions
          adx:              latest(adxD,      'adx')     ?? null,
          williams:         latest(williamsD, 'williams') ?? null,
          from_52w_high_pct,
          from_52w_low_pct,
          volume_ratio_20d,
          // Ratios TTM
          pe_ratio:       r?.priceToEarningsRatioTTM        ?? null,
          peg:            r?.priceToEarningsGrowthRatioTTM  ?? null,
          pb:             r?.priceToBookRatioTTM            ?? null,
          net_margin:     r?.netProfitMarginTTM             ?? null,
          gross_margin:   r?.grossProfitMarginTTM           ?? null,
          debt_to_equity: r?.debtToEquityRatioTTM          ?? null,
          current_ratio:  r?.currentRatioTTM               ?? null,
          interest_coverage: r?.interestCoverageRatioTTM   ?? null,
          // Key metrics TTM
          roic:      m?.returnOnInvestedCapitalTTM ?? null,
          roe:       m?.returnOnEquityTTM          ?? null,
          fcf_yield: m?.freeCashFlowYieldTTM       ?? null,
          ev_ebitda: m?.evToEBITDATTM              ?? null
        }];
      }));

      const batchData = Object.fromEntries(results);

      const nullPrices = results.filter(([,d]) => d.price === null).length;
      if (nullPrices > 0) console.error(`deep-chunk: ${nullPrices}/${syms.length} symbols missing price`);
      console.log(`deep-chunk: batch done — ${syms.length} symbols, ${nullPrices} missing price`);

      // ── Read existing deep file ───────────────────────────────────────────
      const deepPath = `data/market/deep-${date}.json`;
      const ghUrl    = `https://api.github.com/repos/${REPO}/contents/${deepPath}`;
      const ghRes    = await fetch(ghUrl, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}` } });

      let existingData = {}, sha = null;
      if (ghRes.ok) {
        const ghJson = await ghRes.json();
        sha = ghJson.sha;
        try {
          const decoded = Buffer.from(ghJson.content.replace(/\n/g, ''), 'base64').toString('utf-8');
          existingData = JSON.parse(decoded).data || {};
        } catch (e) { console.error('deep-chunk: parse error on existing file:', e.message); }
      }

      // ── Merge and save ────────────────────────────────────────────────────
      const merged  = { ...existingData, ...batchData };
      const outJson = JSON.stringify({ date, count: Object.keys(merged).length, data: merged });

      const saveRes = await fetch(ghUrl, {
        method:  'PUT',
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message: `Deep data ${date} (${Object.keys(merged).length} symbols)`,
          content: Buffer.from(outJson).toString('base64'),
          ...(sha ? { sha } : {})
        })
      });

      if (!saveRes.ok) {
        const errText = await saveRes.text();
        console.error('deep-chunk: GitHub save failed:', errText.slice(0, 300));
        return res.status(500).json({ error: 'GitHub save failed', detail: errText.slice(0, 300) });
      }

      return res.status(200).json({ ok: true, date, batch_size: syms.length, total_so_far: Object.keys(merged).length });

    } catch (err) {
      console.error('deep-chunk FATAL:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }


  // ── MODE: build-sharia — rebuild the Sharia-compliant list (monthly) ──────
  // Source: holdings of professionally screened Islamic ETFs (S&P Shariah via
  // SPUS, FTSE USA Shariah via HLAL). Their committees apply AAOIFI screening;
  // we consume the result. Replaces the broken isSharia screener (the param
  // never existed in FMP — the old list was an unfiltered market dump).
  if (req.query.mode === 'build-sharia') {
    const bearer = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const k = req.query.key || bearer;
    if (k !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const GH_TOKEN = process.env.GITHUB_TOKEN;
    if (!GH_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
    try {
      const ETFS = ['SPUS', 'HLAL'];
      const results = await Promise.all(ETFS.map(e => fmpGet(`/etf/holdings?symbol=${e}`)));
      const set = new Set();
      const perEtf = {};
      results.forEach((rows, i) => {
        const got = [];
        (Array.isArray(rows) ? rows : []).forEach(r => {
          const a = String(r.asset || r.symbol || '').toUpperCase().trim();
          // keep plausible US tickers; drop cash lines, the ETF itself, and non-equity rows
          if (a && /^[A-Z]{1,6}(\.[A-Z])?$/.test(a) && !ETFS.includes(a) && !/^CASH/.test(a)) {
            set.add(a); got.push(a);
          }
        });
        perEtf[ETFS[i]] = got.length;
      });
      // SELF-VERIFICATION (the canary, server-side): a compliant list can never
      // contain conventional banks/insurers. Refuse to write a broken list.
      const canaries = ['JPM', 'GS', 'C', 'BAC', 'WFC', 'AIG', 'MET', 'PRU', 'AFL'];
      const hit = canaries.filter(c => set.has(c));
      if (hit.length) return res.status(500).json({ error: `canary check failed: ${hit.join(',')} present — refusing to write` });
      if (set.size < 50) return res.status(500).json({ error: `only ${set.size} symbols — ETF holdings fetch likely failed, refusing to write` });

      const out = {
        updated: todayUAE(),
        method: 'Holdings of AAOIFI-screened Islamic ETFs (S&P Shariah via SPUS + FTSE USA Shariah via HLAL)',
        method_ar: 'قائمة مبنية على مكونات صناديق مؤشرات شرعية مُدقّقة وفق معايير AAOIFI (مؤشر S&P الشرعي ومؤشر FTSE الأمريكي الشرعي)',
        source_etfs: perEtf,
        count: set.size,
        symbols: [...set].sort(),
      };
      await ghWriteScorer(REPO, 'data/market/sharia-list.json', out, `sharia-list: ${out.updated} — ${out.count} symbols (SPUS+HLAL)`, GH_TOKEN);
      return res.status(200).json({ ok: true, updated: out.updated, count: out.count, per_etf: perEtf });
    } catch (err) {
      console.error('build-sharia FATAL:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── MODE: lookup-analysis — phase 2: the written analysis only ────────────
  // Separated from mode=lookup so the data renders in seconds and Claude gets
  // the full function time budget (~50s) to write a substantive analysis.
  if (req.query.mode === 'lookup-analysis') {
    try {
      const sym = String(req.query.sym || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
      if (!sym) return res.status(400).json({ error: 'sym required' });
      const { data, dq: _lkDQ } = await buildLookupData(sym);

      // ── Claude analysis (THEISI voice) — optional, never blocks the data ──
      let analysis = null;
      let analysisErr = null;   // surfaced in the response so failures are diagnosable
      try {
        const AK = process.env.ANTHROPIC_API_KEY;
        if (!AK) analysisErr = 'ANTHROPIC_API_KEY not set in Vercel env';
        if (AK) {
          const facts = {
            symbol: data.symbol, name: data.companyName, sector: data.sector,
            price: data.price, changePct: data.changePct, marketCapB: data.marketCap ? +(data.marketCap/1e9).toFixed(1) : null,
            pe: data.pe, peg: data.peg, roePct: data.roe, beta: data.beta,
            revenueGrowthPct: data.revenueGrowth,
            dcfFairValue: data.dcfValue, analystTarget: data.targetMean,
            analystRange: (data.targetLow != null && data.targetHigh != null) ? `$${data.targetLow}–$${data.targetHigh}` : null,
            analystConsensus: data.analystConsensus,
            recentGrades: (data.grades||[]).map(g=>`${g.gradingCompany||''}: ${g.previousGrade||''}→${g.newGrade||''}`).slice(0,3),
            financials: (data.financials||[]).map(f=>({y:f.label, revB:f.revenue?+(f.revenue/1e9).toFixed(1):null, niB:f.netIncome?+(f.netIncome/1e9).toFixed(1):null, marginPct:f.netMargin?+f.netMargin.toFixed(1):null, fcfB:f.freeCashFlow?+(f.freeCashFlow/1e9).toFixed(1):null}))
          };
          const prompt = `أنت محلل مالي في THEISI تشرح سهماً لمستثمر خليجي طويل الأجل، غير متخصص، بلغة عربية هادئة وواضحة (لهجة بيضاء قريبة من الخليجية، بدون مبالغة).

قواعد صارمة:
- اشرح ولا توصِ أبداً: ممنوع "اشترِ/بِع/الآن فرصة"، وممنوع التنبؤ بسعر أو إطار زمني.
- كل رقم تذكره اربطه بمعناه بكلمات بسيطة (مثال: "P/E أعلى من المعتاد يعني أن السوق يدفع علاوة على النمو").
- كن صادقاً في نقاط الضعف كما في القوة. إن كانت بيانات ناقصة فقل ذلك ببساطة.
- لا تستخدم مصطلحات تقنية (RSI/MACD). الأساسيات فقط.

اكتب بهذا الهيكل بالضبط (Markdown — العناوين بـ ## حرفياً ودون تغيير):
## الأطروحة الاستثمارية
هذه الفقرة هي قلب الصفحة — خذ المساحة التي تحتاجها (فقرة أو فقرتان، بلا حد معين للجمل) لتجيب فعلياً: ماذا تعمل الشركة وكيف تكسب المال؟ ما قصة نموها وموقعها التنافسي ومن ينافسها؟ وماذا تقول أرقامها الحالية (التقييم، النمو، الربحية) عن وضعها اليوم؟ اربط الأرقام بالقصة، واكتب بقدر ما تستحق القصة: شركة بسيطة تكفيها فقرة قصيرة، وشركة معقدة أو حديثة الإدراج تستحق التفصيل. لا حشو ولا تكرار — كل جملة تضيف معلومة.

## نقاط القوة
- (٣ إلى ٤ نقاط، كل نقطة سطر إلى سطرين: الرقم + لماذا يهم هذا المستثمر تحديداً)

## نقاط الضعف والمخاطر
- (٣ إلى ٤ نقاط بنفس العمق وبصدق كامل — ضمّن مخاطر القطاع والمنافسة لا الأرقام فقط)

## ماذا يعني هذا لمستثمر طويل الأجل؟
٣ جمل: لمن قد يناسب هذا السهم كنوع (نمو/قيمة/توزيعات)، وما الذي يجب مراقبته في النتائج القادمة، وتنتهي بأن القرار يعود للمستثمر.${_lkDQ.notesAr.length ? `

ملاحظات جودة البيانات (مهمة — يجب أن تنعكس بصدق في تحليلك دون تهويل):
- ${_lkDQ.notesAr.join('\n- ')}` : ''}

بيانات السهم (JSON):
${JSON.stringify(facts)}`;
          const controller = new AbortController();
          const tmo = setTimeout(() => controller.abort(), 50000);
          const aRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2200, messages: [{ role: 'user', content: prompt }] }),
            signal: controller.signal
          });
          clearTimeout(tmo);
          if (aRes.ok) {
            const aData = await aRes.json();
            analysis = (aData.content || []).map(c => c.type === 'text' ? c.text : '').join('').trim() || null;
            if (!analysis) analysisErr = 'anthropic returned empty content';
          } else {
            const errBody = await aRes.text().catch(() => '');
            analysisErr = `anthropic ${aRes.status}: ${errBody.slice(0, 300)}`;
            console.error('lookup analysis:', analysisErr);
          }
        }
      } catch (e) {
        analysisErr = e.name === 'AbortError' ? 'timeout: Claude did not finish within 45s' : e.message;
        console.error('lookup analysis skipped:', analysisErr);
      }

      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
      return res.status(200).json(analysis ? { analysis } : { analysis: null, analysis_error: analysisErr });
    } catch (err) {
      const code = err.code === 404 ? 404 : 500;
      return res.status(code).json({ analysis: null, analysis_error: err.message });
    }
  }

  // ── MODE: lookup — single-stock snapshot for the dashboard Lookup tab ─────
  // Public market data only (no portfolio info), so it sits with the other
  // dashboard modes, before the server-key auth gate.
  if (req.query.mode === 'lookup') {
    try {
      const sym = String(req.query.sym || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
      if (!sym) return res.status(400).json({ error: 'sym required' });

      const { data, dq: _lkDQ } = await buildLookupData(sym);

      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
      const quality = { confidence: _lkDQ.confidence, flags: _lkDQ.flags, notes_ar: _lkDQ.notesAr };
      return res.status(200).json({ data, quality });
    } catch (err) {
      console.error('lookup FATAL:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Auth check
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ', '').trim();
  if (key && key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.query.mode === 'score') return handleScore(req, res);

  const { nickname, include, symbols: symbolsParam } = req.query;
  const wantIntelligence = include === 'intelligence';

  try {
    let holdings = [];
    let cash = {};
    let investorName = 'Rashed';
    let isGenericUser = false;

    if (nickname && nickname !== 'rashed') {
      // ── Per-user portfolio ──
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
      // ── Rashed's portfolio (default) ──
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

    // ── Live prices (Yahoo Finance) ──────────────────────────────────────────
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

    // ── Calculate totals ─────────────────────────────────────────────────────
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price = priceMap[h.sym] || h.cost;
      const value = Math.round(h.shares * price);
      const glPct = ((price - h.cost) / h.cost * 100);
      totalValue += value;
      return { ...h, livePrice: price, value, glPct };
    });
    enriched.sort((a, b) => b.value - a.value);

    // ── Group by sector ──────────────────────────────────────────────────────
    const sectors = {
      tech:   { label: 'TECHNOLOGY',  items: [] },
      spec:   { label: 'SPECULATIVE', items: [] },
      bio:    { label: 'BIOTECH',     items: [] },
      mining: { label: 'MINING',      items: [] },
      etf:    { label: 'ETFs',        items: [] },
      other:  { label: 'OTHER',       items: [] },
    };
    enriched.forEach(h => { (sectors[h.sector] || sectors.other).items.push(h); });

    // ── Format portfolio text ────────────────────────────────────────────────
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
      text += `Fresh cash available: $${cash.fresh_cash_deposited?.toLocaleString() || 0}\n`;
      text += `Investable cash: $${cash.investable_cash?.toLocaleString() || 0}\n`;
    }
    text += `═══════════════════════════════════════════════════════\n`;

    // ── Intelligence block ───────────────────────────────────────────────────
    if (wantIntelligence) {
      const allSyms  = symbols;
      const moverSyms = [];
      const top10    = symbols.slice(0, 10);

      const [
        earningsRaw,
        targetResults,
        gradeResults,
        metricResults,
        rsiResults,
        macdResults,
        sma50Results,
        sma200Results,
        ema20Results,
        bbResults
      ] = await Promise.all([

        // Analyst & fundamental data
        fmpGet(`/earnings-calendar?from=${todayUAE()}&to=${daysAheadUAE(60)}&symbol=${allSyms.join(',')}`),
        Promise.all(top10.map(sym => fmpGet(`/price-target-consensus?symbol=${sym}`))),
        Promise.all(top10.map(sym => fmpGet(`/grades?symbol=${sym}&limit=3`))),
        Promise.all(top10.map(sym => fmpGet(`/key-metrics-ttm?symbol=${sym}`))),

        // Technical indicators — ALL portfolio stocks
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

      // ── Build technical signals summary per stock ─────────────────────────
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
        if (techMap[sym] && stddev !== null && priceMap[sym]) {
          const mid = techMap[sym].sma20 || priceMap[sym];
          techMap[sym].bb_upper = +(priceMap[sym] + 2 * stddev).toFixed(2);
          techMap[sym].bb_lower = +(priceMap[sym] - 2 * stddev).toFixed(2);
          techMap[sym].bb_stddev = +stddev.toFixed(4);
        }
      });

      // ── Add plain-language signal interpretation ──────────────────────────
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

      // ── Flatten analyst results ───────────────────────────────────────────
      const earnings = earningsRaw || [];
      const targets  = targetResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));
      const grades   = gradeResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));
      const metrics  = metricResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));

      const earningsSorted = (earnings || []).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}))
        .sort((a, b) => {
          if (a.inPortfolio && !b.inPortfolio) return -1;
          if (!a.inPortfolio && b.inPortfolio) return 1;
          return new Date(a.date) - new Date(b.date);
        });

      // ── Append intelligence block ─────────────────────────────────────────
      text += `\n═══════════════════════════════════════════════════════\n`;
      text += `MARKET INTELLIGENCE — ${todayUAE()}\n`;
      text += `Portfolio symbols: ${symbols.join(', ')}\n`;
      text += `Market movers tracked: ${moverSyms.join(', ') || 'none yet'}\n`;
      text += `═══════════════════════════════════════════════════════\n\n`;

      // Technical indicators — formatted as a readable table for Claude
      text += `TECHNICAL INDICATORS (all ${symbols.length} portfolio stocks):\n`;
      text += `${'SYM'.padEnd(7)} ${'RSI'.padEnd(8)} ${'MACD'.padEnd(10)} ${'SMA50'.padEnd(9)} ${'SMA200'.padEnd(9)} ${'EMA20'.padEnd(9)} BB_UPPER / BB_LOWER\n`;
      text += `─────────────────────────────────────────────────────────────────────────────\n`;
      symbols.forEach(sym => {
        const t = techMap[sym];
        text += `${sym.padEnd(7)} `;
        text += `${(t.rsi    !== null ? String(t.rsi)    : 'N/A').padEnd(8)} `;
        text += `${(t.macd   !== null ? String(t.macd)   : 'N/A').padEnd(10)} `;
        text += `${(t.sma50  !== null ? String(t.sma50)  : 'N/A').padEnd(9)} `;
        text += `${(t.sma200 !== null ? String(t.sma200) : 'N/A').padEnd(9)} `;
        text += `${(t.ema20  !== null ? String(t.ema20)  : 'N/A').padEnd(9)} `;
        text += `${t.bb_upper || 'N/A'} / ${t.bb_lower || 'N/A'}\n`;
      });
      text += `\n`;

      // Signal interpretation — plain English for Claude
      text += `SIGNAL INTERPRETATION:\n`;
      symbols.forEach(sym => {
        const t = techMap[sym];
        if (t.signals && t.signals.length > 0) {
          text += `${sym}: ${t.signals.join(' | ')}\n`;
        }
      });
      text += `\n`;

      text += `EARNINGS CALENDAR (next 60 days — portfolio stocks first):\n`;
      text += JSON.stringify({
        portfolio: earningsSorted.filter(e => e.inPortfolio),
        movers:    earningsSorted.filter(e => !e.inPortfolio).slice(0, 10)
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
