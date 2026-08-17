// api/_lib/risk-core.js
//
// THE single home for all THEISI risk math. Pure functions — no network, no fs.
// Imported by BOTH the server endpoint (api/risk.js) and the local CLI
// (risk/risk-engine.js) so the numbers can never drift between them. This is the
// same anti-drift discipline as the shared guard-rules.json.
//
// Deterministic. No LLM. On-principle: it EXPLAINS exposure, never recommends.
'use strict';

// ── letter-grade ladder (shared with the exit logic) ────────────────────────
const G = { 'A+':13,'A':12,'A-':11,'B+':10,'B':9,'B-':8,'C+':7,'C':6,'C-':5,'D+':4,'D':3,'D-':2,'F':1 };
const grd = x => (G[x] ?? null);
const num = x => (x === '' || x == null) ? null : (isFinite(+x) ? +x : null);

// ── basic stats ─────────────────────────────────────────────────────────────
const logrets = c => c.slice(1).map((x, i) => Math.log(x / c[i]));
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const std  = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

function corr(a, b) {
  const n = Math.min(a.length, b.length); if (n < 20) return null;
  const x = a.slice(-n), y = b.slice(-n), mx = mean(x), my = mean(y);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; cov += dx*dy; vx += dx*dx; vy += dy*dy; }
  return (vx && vy) ? cov / Math.sqrt(vx * vy) : null;
}

// ── Jacobi eigenvalues of a symmetric matrix ────────────────────────────────
// NOTE: sign(0) must be +1, not 0 — otherwise equal diagonal entries (every
// correlation matrix starts with 1s on the diagonal) produce a zero rotation
// and the solver silently returns the untouched diagonal. That bug made
// effective-independent-bets always equal N. Do not "simplify" this back.
function eigenvalues(M) {
  const n = M.length, a = M.map(r => r.slice());
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0; for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
    if (off < 1e-9) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-12) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const sgn = th >= 0 ? 1 : -1;
      const t = sgn / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let i = 0; i < n; i++) { const aip = a[i][p], aiq = a[i][q]; a[i][p] = c*aip - s*aiq; a[i][q] = s*aip + c*aiq; }
      for (let i = 0; i < n; i++) { const api = a[p][i], aqi = a[q][i]; a[p][i] = c*api - s*aqi; a[q][i] = s*api + c*aqi; }
    }
  }
  return a.map((r, i) => r[i]);
}

/** Effective independent bets = participation ratio of the eigenvalues (n²/Σλ²). */
function effectiveIndependentBets(C) {
  const n = C.length; if (!n) return null;
  const s2 = eigenvalues(C).reduce((a, l) => a + l * l, 0);
  return s2 ? n * n / s2 : null;
}

/** Union-find clustering on correlation ≥ threshold. */
function clusters(syms, C, thr) {
  const parent = syms.map((_, i) => i);
  const find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
  for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++)
    if (C[i][j] != null && C[i][j] >= thr) parent[find(i)] = find(j);
  const groups = {};
  syms.forEach((s, i) => { const r = find(i); (groups[r] = groups[r] || []).push(s); });
  return Object.values(groups).filter(g => g.length > 1).sort((a, b) => b.length - a.length);
}

// ── thesis-exit signals (the mirror of the entry logic) ─────────────────────
function exitSignals(r) {
  const sym = r.symbol || r.sym;
  const price = num(r['Price']), hi = num(r['52W High']);
  const vs200 = num(r['Last Price Vs. 200D SMA']);
  const rsi = num(r['RSI']);
  const gain = num(r['Total % Change']);
  const V = r['Valuation Grade'], R = r['EPS Revision Grade'], M = r['Momentum Grade'];
  const peg = num(r['PEG FWD']);
  const nearHigh = (price != null && hi) ? price >= 0.97 * hi : false;
  const posOffHigh = (price != null && hi) ? (price - hi) / hi : null;

  const flags = [];
  const add = (key, severity, ar, en) => flags.push({ key, severity, ar, en });

  if (vs200 != null && vs200 >= 0.25)
    add('extended_vs_trend', 'watch',
        `السعر أعلى من متوسط 200 يوم بـ ${(vs200*100).toFixed(0)}% — ممتد عن اتجاهه الطويل`,
        `+${(vs200*100).toFixed(0)}% above its 200-day trend — extended`);
  if (rsi != null && rsi >= 75)
    add('overbought', 'watch', `مؤشر القوة النسبية ${rsi.toFixed(0)} — تشبّع شرائي`, `RSI ${rsi.toFixed(0)} — overbought`);
  if (nearHigh)
    add('at_52w_high', 'watch', `قرب أعلى سعر خلال سنة`, `at its 52-week high`);
  if (grd(V) != null && grd(V) <= grd('D+') && (peg == null || peg > 2.5))
    add('valuation_stretched', 'watch', `التقييم ممتد (${V}${peg != null ? `، PEG ${peg.toFixed(1)}` : ''})`, `valuation stretched (${V})`);
  if (grd(R) != null && grd(R) <= grd('D+'))
    add('revisions_down', 'watch', `المحللون يخفّضون التقديرات (مراجعات ${R})`, `analysts cutting estimates (revisions ${R})`);
  if (gain != null && gain >= 0.5 && grd(M) != null && grd(M) <= grd('C'))
    add('momentum_fading', 'watch', `الزخم يضعف (${M}) بعد مكسب ${(gain*100).toFixed(0)}%`, `momentum fading (${M}) after +${(gain*100).toFixed(0)}%`);

  const bigWinner = gain != null && gain >= 0.5;
  const hot = (rsi != null && rsi >= 72) || nearHigh || (vs200 != null && vs200 >= 0.20);
  const noLongerCheap = (grd(V) != null && grd(V) <= grd('D+')) || (grd(R) != null && grd(R) <= grd('D'));
  const played_out = bigWinner && hot && noLongerCheap;
  if (played_out)
    add('thesis_played_out', 'review',
        `نضجت القصة: مكسب ${(gain*100).toFixed(0)}%، ممتد، وما عاد رخيص — السبب اللي خلاه شراء ما عاد ينطبق عليه. القرار عندك يا صديقي.`,
        `Thesis matured: +${(gain*100).toFixed(0)}%, extended, no longer cheap — the reason it was a buy no longer describes it. Your call.`);

  return { sym, gain: gain != null ? +(gain*100).toFixed(0) : null,
           off_high_pct: posOffHigh != null ? +(posOffHigh*100).toFixed(0) : null,
           flags, played_out, watch_count: flags.length };
}

function scanExits(saWorkbook) {
  const rows = [...(saWorkbook.stocks || []), ...(saWorkbook.etfs || [])]
    .filter(s => (+s['Shares'] || 0) > 0);
  return rows.map(exitSignals)
    .filter(x => x.flags.length)
    .sort((a, b) => (b.played_out - a.played_out) || (b.watch_count - a.watch_count));
}

// ── holdings from a raw SA workbook (weight, sector, 24M beta) ───────────────
// "-" / blank beta (some ETFs) coerce to null, never NaN — a NaN beta poisons
// the whole value-weighted read.
function holdingsFromWorkbook(sa) {
  const rows = [...(sa.stocks || []), ...(sa.etfs || [])]
    .filter(s => (+s['Shares'] || 0) > 0)
    .map(s => ({ sym: s.symbol || s.sym, value: +s['Value'] || 0,
                 sector: s['Sector'] || '?', beta: num(s['24M Beta']) }));
  const tot = rows.reduce((a, h) => a + h.value, 0);
  rows.forEach(h => h.w = tot ? h.value / tot : 0);
  return { rows, total: tot };
}

/**
 * Build the full risk report.
 * @param holdings  [{sym,value,sector,beta,w}]
 * @param closes    { sym: [dailyClose,...] }  (raw closes; may omit names)
 * @param saRaw     the raw workbook (for the exit scan)
 * @param meta      { asOf, saDate, bench }  bench defaults to 'SPY'
 */
function buildReport(holdings, closes, saRaw, meta = {}) {
  const bench = meta.bench || 'SPY';
  const tot = holdings.reduce((a, h) => a + h.value, 0);

  // concentration
  const hhi = holdings.reduce((a, h) => a + h.w * h.w, 0);
  const effPos = hhi ? 1 / hhi : null;
  const sec = {}; holdings.forEach(h => sec[h.sector] = (sec[h.sector] || 0) + h.w);
  const effSectors = 1 / Object.values(sec).reduce((a, w) => a + w * w, 0);
  const wb = holdings.filter(h => h.beta != null);
  const pBeta = wb.length ? wb.reduce((a, h) => a + h.w * h.beta, 0) / wb.reduce((a, h) => a + h.w, 0) : null;

  // returns for names we have history on
  const R = {};
  for (const [sym, c] of Object.entries(closes || {})) if (Array.isArray(c) && c.length > 20) R[sym] = logrets(c);
  const syms = holdings.map(h => h.sym);
  const have = syms.filter(s => R[s]);

  let effBets = null, divRatio = null, avgCorr = null, portVol = null, contrib = [], corrClusters = [], benchBeta = null;
  if (have.length >= 5) {
    const n = have.length;
    const C = Array.from({ length: n }, () => Array(n).fill(1));
    let cs = 0, cn = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const c = corr(R[have[i]], R[have[j]]);
      C[i][j] = C[j][i] = c ?? 0; if (c != null) { cs += c; cn++; }
    }
    avgCorr = cn ? cs / cn : null;
    effBets = effectiveIndependentBets(C);
    corrClusters = clusters(have, C, 0.6);

    const wv = have.map(s => holdings.find(h => h.sym === s).w);
    const wsum = wv.reduce((a, x) => a + x, 0); const w = wv.map(x => x / wsum);
    const sig = have.map(s => std(R[s]));
    const Cov = (i, j) => C[i][j] * sig[i] * sig[j];
    let pv = 0; const Sw = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const cij = Cov(i, j) * w[i] * w[j]; pv += cij; Sw[i] += Cov(i, j) * w[j]; }
    const sp = Math.sqrt(pv);
    portVol = sp * Math.sqrt(252);
    divRatio = w.reduce((a, wi, i) => a + wi * sig[i], 0) / sp;
    contrib = have.map((s, i) => ({ sym: s, rc: w[i] * Sw[i] / sp / sp })).sort((a, b) => b.rc - a.rc).slice(0, 8);
    if (R[bench]) {
      const bl = R[bench]; const m = Math.min(...have.map(s => R[s].length), bl.length);
      const pr = Array(m).fill(0);
      have.forEach((s, i) => { const r = R[s].slice(-m); for (let k = 0; k < m; k++) pr[k] += w[i] * r[k]; });
      const b = bl.slice(-m); const mb = mean(b), mp = mean(pr);
      let cov = 0, vb = 0; for (let k = 0; k < m; k++) { cov += (b[k]-mb)*(pr[k]-mp); vb += (b[k]-mb)**2; }
      benchBeta = vb ? cov / vb : null;
    }
  }

  const exits = saRaw ? scanExits(saRaw) : [];

  return {
    as_of: meta.asOf || null, sa_date: meta.saDate || null,
    holdings: holdings.length, total_value: Math.round(tot),
    concentration: {
      effective_positions: effPos != null ? +effPos.toFixed(1) : null,
      effective_sectors: +effSectors.toFixed(1),
      top_sector: Object.entries(sec).sort((a, b) => b[1] - a[1])[0][0],
      top_sector_pct: +(Object.values(sec).sort((a, b) => b - a)[0] * 100).toFixed(1),
      portfolio_beta_24m: pBeta != null ? +pBeta.toFixed(2) : null
    },
    correlation: have.length >= 5 ? {
      names_with_history: have.length,
      effective_independent_bets: effBets ? +effBets.toFixed(1) : null,
      diversification_ratio: divRatio ? +divRatio.toFixed(2) : null,
      avg_pairwise_correlation: avgCorr ? +avgCorr.toFixed(2) : null,
      annualized_portfolio_vol_pct: portVol ? +(portVol*100).toFixed(1) : null,
      measured_beta_vs_spy: benchBeta ? +benchBeta.toFixed(2) : null,
      top_risk_contributors: contrib.map(c => ({ sym: c.sym, pct_of_risk: +(c.rc*100).toFixed(1) })),
      correlation_clusters: corrClusters
    } : { note: 'no price history — set FMP_API_KEY and run on a non-datacenter IP' },
    scenarios: [-10, -20, -30].map(m => ({
      market_move_pct: m,
      beta_implied_book_pct: pBeta != null ? +(pBeta * m).toFixed(0) : null,
      beta_implied_book_usd: pBeta != null ? Math.round(tot * pBeta * m / 100) : null
    })),
    sector_weights: Object.fromEntries(Object.entries(sec).sort((a, b) => b[1]-a[1]).map(([s, w]) => [s, +(w*100).toFixed(1)])),
    exits,
    caveat_ar: 'أرقام تعرّض معلوماتية — البيتا مو تنبؤ، وفي الهبوط الحاد ترتفع الارتباطات وتهبط الأسهم عالية البيتا أكثر. القرار في النهاية عندك.'
  };
}

module.exports = {
  eigenvalues, effectiveIndependentBets, corr, clusters, logrets, mean, std,
  exitSignals, scanExits, holdingsFromWorkbook, buildReport
};
