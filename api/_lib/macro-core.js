// api/_lib/macro-core.js
//
// Macro scenario maths for THEISI. Pure functions — no network, no fs, no LLM.
// Sibling of risk-core.js and held to the same discipline: every number the
// simulator shows is produced here, deterministically, from price history or
// from reported revenue segmentation. Nothing is estimated by a model that
// writes prose.
//
// Three layers, kept separate on purpose:
//   1. factorBetas()  — OLS of holding returns on a factor proxy. Ships R².
//   2. findShocks() + replay() — arithmetic on real historical windows.
//   3. structuralExposure() — share of reported revenue by region/product.
//
// THE LINE (do not cross): revenue-at-risk is not price impact. Layer 3 emits
// exposure only. Turning exposure into a price move requires either a
// comparable historical shock (layers 1/2) or an elasticity the USER sets and
// can see. Never a constant invented here and presented as a measurement.
'use strict';

// ── stats ───────────────────────────────────────────────────────────────────
const logrets = c => c.slice(1).map((x, i) => Math.log(x / c[i]));
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

/** OLS slope of y on x, with R². Returns null when the sample is too thin. */
function ols(y, x, minN = 120) {
  const n = Math.min(y.length, x.length);
  if (n < minN) return null;
  const a = y.slice(-n), b = x.slice(-n);
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  if (vb <= 0) return null;
  return {
    beta: cov / vb,
    r2: va > 0 ? (cov * cov) / (va * vb) : 0,
    n
  };
}

/** Residual of y after removing its linear dependence on x. */
function residualise(y, x) {
  const f = ols(y, x, 2);
  if (!f) return y.slice();
  const n = Math.min(y.length, x.length);
  const a = y.slice(-n), b = x.slice(-n);
  const ma = mean(a), mb = mean(b);
  return a.map((v, i) => (v - ma) - f.beta * (b[i] - mb));
}

/**
 * Sensitivity of every holding to one factor proxy.
 *
 * `beta` is univariate on purpose: the user's question is "if the AI basket
 * falls 30%", and that move carries its usual market co-movement with it.
 * `betaSpecific` strips the market out, so the payload can also answer
 * "how much of this is the name itself rather than beta to everything".
 *
 * @param closes  { SYM: [dailyClose,…] } — holdings plus factor plus bench
 * @param syms    holdings to score
 * @param factor  proxy symbol (e.g. 'SMH')
 * @param bench   market symbol used to strip common movement
 * @returns { SYM: {beta, r2, n, betaSpecific} }
 */
function factorBetas(closes, syms, factor, bench = 'SPY') {
  const F = closes[factor];
  if (!Array.isArray(F) || F.length < 60) return {};
  const fr = logrets(F);
  const br = Array.isArray(closes[bench]) ? logrets(closes[bench]) : null;
  const frSpec = br ? residualise(fr, br) : null;

  const out = {};
  for (const s of syms) {
    const c = closes[s];
    if (!Array.isArray(c) || c.length < 60) continue;
    const sr = logrets(c);
    const fit = ols(sr, fr);
    if (!fit) continue;
    out[s] = {
      beta: +fit.beta.toFixed(3),
      r2: +fit.r2.toFixed(3),
      n: fit.n
    };
    if (frSpec) {
      const spec = ols(sr, frSpec);
      if (spec) out[s].betaSpecific = +spec.beta.toFixed(3);
    }
  }
  return out;
}

// ── impact bands ────────────────────────────────────────────────────────────
const BANDS = [
  { key: 'severe',   ar: 'شديد',  en: 'Severe',   lo: -Infinity, hi: -25, color: '#F87171' },
  { key: 'high',     ar: 'عالي',  en: 'High',     lo: -25, hi: -15,       color: '#FB923C' },
  { key: 'medium',   ar: 'متوسط', en: 'Medium',   lo: -15, hi: -8,        color: '#FBBF24' },
  { key: 'light',    ar: 'خفيف',  en: 'Light',    lo: -8,  hi: -3,        color: '#38BDF8' },
  { key: 'limited',  ar: 'محدود', en: 'Limited',  lo: -3,  hi: Infinity,  color: '#34D399' }
];
const bandOf = pct => (BANDS.find(b => pct >= b.lo && pct < b.hi) || BANDS[BANDS.length - 1]).key;

/**
 * Apply a factor shock to the book and group the result into impact bands.
 *
 * @param holdings [{sym, value}]
 * @param betas    output of factorBetas
 * @param shockPct factor move in percent (e.g. -30)
 * @param opts     { minR2 } — names below it are carried but flagged weak,
 *                 never silently dropped and never silently trusted
 */
function simulate(holdings, betas, shockPct, opts = {}) {
  const minR2 = opts.minR2 ?? 0.15;
  const names = [], skipped = [];
  let coveredValue = 0, totalValue = 0, impactUsd = 0;

  for (const h of holdings) {
    totalValue += h.value;
    const b = betas[h.sym];
    if (!b) { skipped.push(h.sym); continue; }
    // R2 (validation 22 Aug 2026): for the broad-MARKET channel, R²-weighted
    // shrinkage toward 1 cuts severe-window MAE 5.67→4.81pp. For factor
    // channels the dispersion IS the signal — shrinkage hurts (4.87→6.02) —
    // so it applies only when the caller marks the channel as market-wide.
    const bUsed = opts.marketChannel ? (b.r2 * b.beta + (1 - b.r2)) : b.beta;
    const est = bUsed * shockPct;
    const usd = h.value * est / 100;
    coveredValue += h.value;
    impactUsd += usd;
    names.push({
      sym: h.sym,
      value: Math.round(h.value),
      beta: b.beta,
      r2: b.r2,
      weak: b.r2 < minR2,            // the factor barely explains this name
      est_pct: +est.toFixed(1),
      impact_usd: Math.round(usd),
      band: bandOf(est)
    });
  }
  names.sort((a, b) => a.impact_usd - b.impact_usd);

  const bands = BANDS.map(B => {
    const g = names.filter(n => n.band === B.key);
    const v = g.reduce((a, n) => a + n.value, 0);
    const u = g.reduce((a, n) => a + n.impact_usd, 0);
    return {
      key: B.key, ar: B.ar, en: B.en, color: B.color,
      count: g.length,
      value: v,
      pct: v ? +(u / v * 100).toFixed(1) : 0,
      impact_usd: Math.round(u),
      syms: g.map(n => n.sym)
    };
  }).filter(b => b.count > 0);

  return {
    shock_pct: shockPct,
    covered_value: Math.round(coveredValue),
    total_value: Math.round(totalValue),
    coverage_pct: totalValue ? +(coveredValue / totalValue * 100).toFixed(1) : 0,
    impact_usd: Math.round(impactUsd),
    impact_pct: coveredValue ? +(impactUsd / coveredValue * 100).toFixed(1) : 0,
    weak_names: names.filter(n => n.weak).map(n => n.sym),
    no_history: skipped,
    bands,
    names
  };
}

// ── layer 2: historical replay ──────────────────────────────────────────────
/**
 * Find the sharpest historical stress windows straight from the data. No event
 * names are asserted anywhere — the caller may label a window it recognises,
 * but the detector only ever reports dates and magnitudes.
 *
 * @param dates    ascending date strings
 * @param factor   { date: close } for the stressed series
 * @param bench    { date: close } — pass to rank by factor-vs-bench spread
 *                 (isolates factor-specific stress), omit for outright drops
 */
function findShocks(dates, factor, bench = null, opts = {}) {
  const win = opts.window || 5;
  const want = opts.count || 5;
  const cand = [];
  for (let i = win; i < dates.length; i++) {
    const d0 = dates[i - win], d1 = dates[i];
    if (factor[d0] == null || factor[d1] == null) continue;
    const f = factor[d1] / factor[d0] - 1;
    let rank = f, b = null;
    if (bench && bench[d0] != null && bench[d1] != null) {
      b = bench[d1] / bench[d0] - 1;
      rank = f - b;                      // factor-specific stress
    }
    cand.push({ from: d0, to: d1, factor_pct: +(f * 100).toFixed(1), bench_pct: b == null ? null : +(b * 100).toFixed(1), rank });
  }
  cand.sort((a, b) => a.rank - b.rank);
  const out = [];
  for (const c of cand) {
    if (out.every(o => !(c.from <= o.to && c.to >= o.from))) out.push(c);
    if (out.length >= want) break;
  }
  return out.map(({ rank, ...rest }) => rest);
}

/** What the CURRENT book would have done across a past window. Pure arithmetic. */
function replay(holdings, closesByDate, window) {
  const per = [];
  let cov = 0, weighted = 0;
  for (const h of holdings) {
    const s = closesByDate[h.sym];
    if (!s || s[window.from] == null || s[window.to] == null) continue;
    const move = (s[window.to] / s[window.from] - 1) * 100;
    cov += h.value;
    weighted += h.value * move;
    per.push({
      sym: h.sym, value: Math.round(h.value),
      move_pct: +move.toFixed(1),
      impact_usd: Math.round(h.value * move / 100),
      band: bandOf(move)
    });
  }
  per.sort((a, b) => a.move_pct - b.move_pct);
  return {
    from: window.from, to: window.to,
    factor_pct: window.factor_pct, bench_pct: window.bench_pct,
    covered_value: Math.round(cov),
    book_pct: cov ? +(weighted / cov).toFixed(1) : null,
    impact_usd: Math.round(cov ? weighted / 100 : 0),
    names: per
  };
}

// ── layer 3: structural exposure ────────────────────────────────────────────
// Reported segment labels are inconsistent between filers. This mapping is a
// deterministic, inspectable RULE — not a judgement. Anything it does not
// recognise lands in `unclassified` and is reported as such. Never guess a
// region: an unmapped label is data we do not have, not a region we assume.
const REGION_RULES = [
  { key: 'greater_china', ar: 'الصين الكبرى',   test: /\b(china|prc|hong kong|hongkong|taiwan|greater china)\b/i },
  { key: 'united_states', ar: 'أمريكا',          test: /\b(united states|u\.?s\.?a?|america[ns]?|north america|domestic)\b/i },
  { key: 'europe',        ar: 'أوروبا',          test: /\b(europe|emea|eurozone|united kingdom|u\.?k\.?|germany|france|italy|spain|netherlands|switzerland|nordic)\b/i },
  { key: 'asia_ex_china', ar: 'آسيا عدا الصين',  test: /\b(japan|korea|singapore|india|australia|asia[- ]pacific|apac|southeast asia|vietnam|thailand|malaysia|indonesia|philippines)\b/i },
  { key: 'middle_east',   ar: 'الشرق الأوسط',    test: /\b(middle east|gcc|saudi|uae|emirates|qatar|israel|turkey)\b/i },
  { key: 'latam',         ar: 'أمريكا اللاتينية', test: /\b(latin america|latam|brazil|mexico|argentina|chile|colombia)\b/i }
];

/**
 * Share of reported revenue by canonical region.
 *
 * @param segments FMP revenue-geographic-segmentation row: { data: {label: revenue} }
 * @returns { total, by_region: {key: {ar, revenue, pct}}, unclassified_pct, labels_seen }
 */
function structuralExposure(segments) {
  const data = segments && segments.data;
  if (!data || typeof data !== 'object') return null;
  const rows = Object.entries(data)
    .map(([label, rev]) => [label, Number(rev)])
    .filter(([, rev]) => isFinite(rev) && rev > 0);
  const total = rows.reduce((a, [, r]) => a + r, 0);
  if (!total) return null;

  const by = {}; let unclassified = 0; const unknownLabels = [];
  for (const [label, rev] of rows) {
    const rule = REGION_RULES.find(r => r.test.test(label));
    if (!rule) { unclassified += rev; unknownLabels.push(label); continue; }
    by[rule.key] = by[rule.key] || { ar: rule.ar, revenue: 0, pct: 0 };
    by[rule.key].revenue += rev;
  }
  for (const k of Object.keys(by)) by[k].pct = +(by[k].revenue / total * 100).toFixed(1);

  return {
    fiscal_year: segments.fiscalYear ?? null,
    total_revenue: Math.round(total),
    by_region: by,
    unclassified_pct: +(unclassified / total * 100).toFixed(1),
    unknown_labels: unknownLabels,
    labels_seen: rows.length
  };
}

/**
 * Revenue exposed to a region-based scenario, and the price impact that follows
 * ONLY from an elasticity the caller supplies.
 *
 * `elasticity` MUST come from the user or from a comparable measured shock.
 * There is deliberately no default here — a default would become an invented
 * number the moment it reached the screen.
 */
function structuralImpact(holdings, exposures, regionKeys, elasticity) {
  if (!isFinite(elasticity)) throw new Error('structuralImpact: elasticity must be supplied by the user or derived from a measured shock');
  const names = [], missing = [];
  for (const h of holdings) {
    const ex = exposures[h.sym];
    if (!ex) { missing.push(h.sym); continue; }
    const pct = regionKeys.reduce((a, k) => a + (ex.by_region[k]?.pct || 0), 0);
    const est = -pct * elasticity;
    names.push({
      sym: h.sym, value: Math.round(h.value),
      revenue_exposed_pct: +pct.toFixed(1),
      est_pct: +est.toFixed(1),
      impact_usd: Math.round(h.value * est / 100),
      band: bandOf(est),
      unclassified_pct: ex.unclassified_pct,
      basis: 'reported revenue segmentation × user elasticity'
    });
  }
  names.sort((a, b) => a.impact_usd - b.impact_usd);
  return { elasticity, region_keys: regionKeys, no_segmentation: missing, names };
}

// ── the catalogue ───────────────────────────────────────────────────────────
// Fixed set. Ranking is by damage to THIS book, computed — never by a judgement
// about what is topical.
const CATALOGUE = [
  { id: 'market',    ar: 'تصحيح سوق واسع',        proxy: 'SPY', shocks: [-10, -20, -30], layers: [1, 2] },
  { id: 'ai',        ar: 'فقاعة الذكاء الاصطناعي', proxy: 'SMH', shocks: [-30, -45],      layers: [1, 2] },
  { id: 'rates',     ar: 'رفع الفائدة',            proxy: 'TLT', shocks: [-10, -18],      layers: [1, 2], note_ar: 'TLT −10% ≈ +100 نقطة على عائد 10 سنوات' },
  { id: 'dollar',    ar: 'قوة الدولار',            proxy: 'UUP', shocks: [5, 9],          layers: [1] },
  { id: 'oil',       ar: 'صدمة نفط',              proxy: 'USO', shocks: [30, 60],        layers: [1] },
  { id: 'credit',    ar: 'ضغوط ائتمانية',          proxy: 'HYG', shocks: [-8, -14],       layers: [1, 2] },
  { id: 'recession', ar: 'ركود وتباطؤ',            proxy: 'IWM', shocks: [-20, -32],      layers: [1, 2] },
  { id: 'china',     ar: 'مخاطر الصين وتايوان',    proxy: 'FXI', shocks: [-20, -35],      layers: [1, 3], regions: ['greater_china'] },
  { id: 'inflation', ar: 'تضخم عائد',              proxy: 'TIP', shocks: [-5, -9],        layers: [1] },
  { id: 'safehaven', ar: 'هروب للأمان',            proxy: 'GLD', shocks: [15, 28],        layers: [1] },
  { id: 'energy',    ar: 'صدمة طاقة',             proxy: 'XLE', shocks: [-20, -32],      layers: [1] },
  { id: 'tariffs',   ar: 'رسوم جمركية',           proxy: null,  shocks: [],              layers: [3], regions: ['greater_china', 'europe', 'asia_ex_china'] }
];

module.exports = {
  logrets, mean, ols, residualise,
  factorBetas, simulate, findShocks, replay,
  structuralExposure, structuralImpact,
  BANDS, bandOf, CATALOGUE, REGION_RULES
};

// ── risk surfacing (step 1: pick the risk up from news) ─────────────────────
// Deterministic keyword/entity match of ingested news against the catalogue.
// Code decides salience by counting matches; it never interprets. Claude may
// later narrate the result but plays no part in producing it.
const RISK_SIGNALS = {
  ai:        [/\bAI bubble|semiconductor|chip (glut|crash|correction)|رقائق|فقاعة الذكاء|أشباه الموصلات/i],
  rates:     [/\b(fed|interest rate|rate hike|yields? (surge|spike|jump))|الفائدة|الفيدرالي|رفع أسعار/i],
  china:     [/\b(taiwan|china.{0,30}(war|invasion|blockade|conflict)|tsmc.{0,20}(risk|threat)|export controls?)|تايوان|حصار|غزو|الصين.{0,20}(حرب|تصعيد)/i],
  oil:       [/\b(hormuz|strait|oil (spike|surge|shock)|iran.{0,30}(strike|war|attack)|opec.{0,20}cut)|هرمز|مضيق|إيران.{0,20}(ضربة|حرب)|النفط.{0,20}(ارتفاع|صدمة)/i],
  credit:    [/\b(credit (crunch|stress|spread)|default wave|bank (failure|collapse))|أزمة ائتمان|انهيار بنك/i],
  recession: [/\b(recession|hard landing|jobless (surge|spike)|layoffs? wave)|ركود|هبوط حاد|موجة تسريح/i],
  dollar:    [/\b(dollar (strength|surge|rally)|dxy)|قوة الدولار/i],
  tariffs:   [/\b(tariff|trade war|customs dut)|رسوم جمركية|حرب تجارية/i],
  market:    [/\b(selloff|correction|crash|bear market)|تصحيح|انهيار|موجة بيع/i]
};

/**
 * Scan ingested news themes (e.g. themed-news.json) for surfaced risks.
 * @param themes [{summary, detail}] — text already ingested by the pipeline
 * @returns ranked [{id, hits, evidence:[snippet]}] — only risks that surfaced
 */
function surfaceRisks(themes) {
  const out = [];
  for (const [id, pats] of Object.entries(RISK_SIGNALS)) {
    let hits = 0; const evidence = [];
    for (const t of themes || []) {
      const text = `${t.summary || ''} ${t.detail || ''}`;
      for (const p of pats) {
        const m = text.match(p);
        if (m) {
          hits++;
          const i = Math.max(0, m.index - 40);
          evidence.push(text.slice(i, m.index + m[0].length + 40).trim());
        }
      }
    }
    if (hits) out.push({ id, hits, evidence: evidence.slice(0, 3) });
  }
  return out.sort((a, b) => b.hits - a.hits);
}

// ── composite scenarios (step 2: risk → channels) ───────────────────────────
// A named event = one market-wide shock + factor-specific SPREADS on top.
// Spreads use betaSpecific (market-stripped) so nothing is double-counted:
//   est = β_mkt·mktShock + Σ βspecific_f·spread_f
// Channel magnitudes are authored, visible, and adjustable — never silent.
const COMPOSITES = [
  {
    id: 'taiwan_war', ar: 'حرب الصين وتايوان', riskId: 'china',
    market: { proxy: 'SPY', shock_pct: -12 },
    channels: [
      { proxy: 'SMH', spread_pct: -18, why_ar: 'أشباه الموصلات فوق هبوط السوق — تركّز التصنيع في تايوان' },
      { proxy: 'FXI', spread_pct: -20, why_ar: 'الأصول الصينية' },
      { proxy: 'GLD', spread_pct: +12, why_ar: 'هروب للأمان' }
    ],
    structural: { regions: ['greater_china'], note_ar: 'حصة الإيراد من الصين الكبرى — تُعرض كحقيقة، وتحويلها لسعر يتطلب مرونة يحددها المستخدم' }
  },
  {
    id: 'hormuz', ar: 'إغلاق مضيق هرمز', riskId: 'oil',
    market: { proxy: 'SPY', shock_pct: -8 },
    channels: [
      { proxy: 'USO', spread_pct: +55, why_ar: 'صدمة نفط' },
      { proxy: 'XLE', spread_pct: +18, why_ar: 'قطاع الطاقة يستفيد' },
      { proxy: 'GLD', spread_pct: +10, why_ar: 'هروب للأمان' }
    ],
    structural: { regions: ['middle_east'], note_ar: 'حصة الإيراد من الشرق الأوسط' }
  }
];

/**
 * Steps 3+4: stress every stock through a composite scenario, then band & sum.
 * @param closes needs holdings + every channel proxy + market proxy
 */
function compositeSimulate(holdings, closes, scenario, opts = {}) {
  const syms = holdings.map(h => h.sym);
  const mkt = factorBetas(closes, syms, scenario.market.proxy, scenario.market.proxy); // β vs market (bench=self → no residual step)
  const chan = scenario.channels.map(c => ({
    ...c, betas: factorBetas(closes, syms, c.proxy, scenario.market.proxy)            // betaSpecific = market-stripped
  }));
  const names = [], skipped = [];
  let coveredValue = 0, totalValue = 0, impactUsd = 0;
  for (const h of holdings) {
    totalValue += h.value;
    const bm = mkt[h.sym];
    if (!bm) { skipped.push(h.sym); continue; }
    // market leg uses R²-shrunk beta (see simulate); factor spreads stay raw
    const bmUsed = bm.r2 * bm.beta + (1 - bm.r2);
    const parts = [{ channel: scenario.market.proxy, pct: +(bmUsed * scenario.market.shock_pct).toFixed(1) }];
    let est = bmUsed * scenario.market.shock_pct, bestR2 = bm.r2;
    for (const c of chan) {
      const b = c.betas[h.sym];
      if (b && b.betaSpecific != null) {
        const add = b.betaSpecific * c.spread_pct;
        est += add;
        parts.push({ channel: c.proxy, pct: +add.toFixed(1) });
        bestR2 = Math.max(bestR2, b.r2);
      }
    }
    const usd = h.value * est / 100;
    coveredValue += h.value; impactUsd += usd;
    names.push({
      sym: h.sym, value: Math.round(h.value),
      est_pct: +est.toFixed(1), impact_usd: Math.round(usd),
      parts,                                  // per-channel breakdown, inspectable
      macro_explained: +bestR2.toFixed(2),    // best R² across channels
      weak: bestR2 < (opts.minR2 ?? 0.15),
      band: bandOf(est)
    });
  }
  names.sort((a, b) => a.impact_usd - b.impact_usd);
  const bands = BANDS.map(B => {
    const g = names.filter(n => n.band === B.key);
    const v = g.reduce((a, n) => a + n.value, 0), u = g.reduce((a, n) => a + n.impact_usd, 0);
    return { key: B.key, ar: B.ar, color: B.color, count: g.length, value: v,
             pct: v ? +(u / v * 100).toFixed(1) : 0, impact_usd: Math.round(u), syms: g.map(n => n.sym) };
  }).filter(b => b.count > 0);
  return {
    scenario: scenario.id, ar: scenario.ar,
    assumptions: { market: scenario.market, channels: scenario.channels.map(({betas, ...c}) => c) }, // printed, adjustable
    covered_value: Math.round(coveredValue), total_value: Math.round(totalValue),
    coverage_pct: totalValue ? +(coveredValue / totalValue * 100).toFixed(1) : 0,
    impact_usd: Math.round(impactUsd),
    impact_pct: coveredValue ? +(impactUsd / coveredValue * 100).toFixed(1) : 0,
    weak_names: names.filter(n => n.weak).map(n => n.sym),
    no_history: skipped, bands, names
  };
}

module.exports.surfaceRisks = surfaceRisks;
module.exports.compositeSimulate = compositeSimulate;
module.exports.COMPOSITES = COMPOSITES;
module.exports.RISK_SIGNALS = RISK_SIGNALS;

// ── R1: prospective self-grading (SR 11-7 ongoing monitoring, automated) ────
// Each run RECORDS a prediction snapshot; the next run GRADES every snapshot
// whose 5-trading-day window has completed, using the price history it already
// fetched. The model accumulates a live track record no backtest can fake —
// and it fixes survivorship bias permanently (predictions are frozen before
// the outcome exists).

/** Snapshot to grade later: portfolio beta per factor + weights, nothing else. */
function makePrediction(holdings, closes, factors, bench, date) {
  const tot = holdings.reduce((a, h) => a + h.value, 0);
  const factorsOut = {};
  for (const f of factors) {
    const B = factorBetas(closes, holdings.map(h => h.sym), f, bench);
    let bw = 0, wsum = 0;
    for (const h of holdings) {
      const b = B[h.sym];
      if (!b) continue;
      const w = h.value / tot;
      // market channel shrunk, factor channels raw — same rule as simulate()
      bw += w * (f === bench ? (b.r2 * b.beta + (1 - b.r2)) : b.beta);
      wsum += w;
    }
    if (wsum > 0.5) factorsOut[f] = +(bw / wsum).toFixed(3);
  }
  return { made_on: date, horizon_td: 5,
           weights: holdings.map(h => ({ sym: h.sym, w: +(h.value / tot).toFixed(4) })),
           port_beta: factorsOut };
}

/** Grade every pending snapshot whose window has closed. Pure arithmetic. */
function gradePredictions(pending, byDate, proxyByDate, benchDates) {
  const graded = [], still = [];
  for (const p of pending || []) {
    const i0 = benchDates.indexOf(p.made_on);
    const i1 = i0 >= 0 ? i0 + (p.horizon_td || 5) : -1;
    if (i0 < 0 || i1 >= benchDates.length) { still.push(p); continue; }
    const d1 = benchDates[i1];
    // realized book move over the window, current-at-prediction weights
    let wsum = 0, mv = 0;
    for (const { sym, w } of p.weights) {
      const s = byDate[sym];
      if (!s || s[p.made_on] == null || s[d1] == null) continue;
      mv += w * ((s[d1] / s[p.made_on] - 1) * 100); wsum += w;
    }
    if (wsum < 0.5) { still.push(p); continue; }
    const realized_book = +(mv / wsum).toFixed(2);
    for (const [f, beta] of Object.entries(p.port_beta)) {
      const fp = proxyByDate[f];
      if (!fp || fp[p.made_on] == null || fp[d1] == null) continue;
      const fmove = +((fp[d1] / fp[p.made_on] - 1) * 100).toFixed(2);
      if (Math.abs(fmove) < 0.5) continue;           // nothing to grade against
      const predicted = +(beta * fmove).toFixed(2);
      graded.push({ made_on: p.made_on, window_end: d1, factor: f,
                    factor_move_pct: fmove, predicted_book_pct: predicted,
                    realized_book_pct: realized_book,
                    err_pp: +(predicted - realized_book).toFixed(2) });
    }
  }
  return { graded, still_pending: still };
}

/** Rolling scorecard over the graded history. */
function scorecard(graded) {
  if (!graded.length) return { n: 0 };
  const abs = graded.map(g => Math.abs(g.err_pp));
  const bias = graded.reduce((a, g) => a + g.err_pp, 0) / graded.length;
  return { n: graded.length,
           mae_pp: +(abs.reduce((a, x) => a + x, 0) / abs.length).toFixed(2),
           bias_pp: +bias.toFixed(2),
           worst_pp: +Math.max(...abs).toFixed(2) };
}

module.exports.makePrediction = makePrediction;
module.exports.gradePredictions = gradePredictions;
module.exports.scorecard = scorecard;
