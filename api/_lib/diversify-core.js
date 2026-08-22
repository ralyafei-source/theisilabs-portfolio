// api/_lib/diversify-core.js
//
// Diversification & candidate-screening maths for THEISI. Pure functions —
// no network, no fs, no LLM. Sibling of risk-core.js / macro-core.js.
//
// Built from the 22 Aug 2026 session with Rashed. Three jobs:
//
//   1. weightedENB()   — the CORRECT effective-number-of-bets. risk-core's
//                        effectiveIndependentBets(C) ignores weights entirely,
//                        so it answers "how independent are these NAMES as a
//                        set" (reported 10.3) instead of "how independent is
//                        this MONEY" (actual 1.68). Meucci's measure needs the
//                        weights. Keep both; label them differently.
//
//   2. factorShares()  — variance split across orthogonalised factor proxies
//                        plus stock-specific residual. Barra/Aladdin "risk
//                        layers", computed from prices only.
//
//   3. screenCandidates() — the menu. For every candidate: how independent it
//                        is from THIS book, what risks it actually reacts to
//                        (so "different sector" that behaves identically is
//                        exposed), what it does on the owner's WORST days, and
//                        what holding it cost over the window.
//
// THE LINE: this module measures. It ranks nothing as "recommended", emits no
// target weights, and every return figure is realised history over a stated
// window — never a forecast. Selection stays with the owner.
'use strict';

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const vari = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length; };
const covar = (a, b) => {
  const n = Math.min(a.length, b.length), ma = mean(a), mb = mean(b);
  let c = 0; for (let i = 0; i < n; i++) c += (a[i] - ma) * (b[i] - mb);
  return c / n;
};
const corr = (a, b) => { const d = Math.sqrt(vari(a) * vari(b)); return d ? covar(a, b) / d : 0; };
const logrets = c => c.slice(1).map((x, i) => Math.log(x / c[i]));

/** Annualised stats for a daily log-return series. */
function stats(r, ppy = 252) {
  const cum = Math.exp(r.reduce((a, b) => a + b, 0)) - 1;
  const yrs = r.length / ppy;
  let p = 0, peak = 0, dd = 0;
  for (const x of r) { p += x; peak = Math.max(peak, p); dd = Math.min(dd, p - peak); }
  return {
    ret_pct: +((Math.pow(1 + cum, 1 / yrs) - 1) * 100).toFixed(1),
    vol_pct: +(Math.sqrt(vari(r) * ppy) * 100).toFixed(1),
    maxdd_pct: +((Math.exp(dd) - 1) * 100).toFixed(1)
  };
}

/** Jacobi eigen-decomposition of a symmetric matrix → { ev, V } (V columns = vectors). */
function jacobi(M) {
  const n = M.length, a = M.map(r => r.slice());
  const V = M.map((_, i) => M.map((_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 200; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-12) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      // sign(0) must be +1 — same trap documented in risk-core's eigenvalues()
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const sgn = th >= 0 ? 1 : -1;
      const t = sgn / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let i = 0; i < n; i++) { const ip = a[i][p], iq = a[i][q]; a[i][p] = c * ip - s * iq; a[i][q] = s * ip + c * iq; }
      for (let i = 0; i < n; i++) { const pi = a[p][i], qi = a[q][i]; a[p][i] = c * pi - s * qi; a[q][i] = s * pi + c * qi; }
      for (let i = 0; i < n; i++) { const vp = V[i][p], vq = V[i][q]; V[i][p] = c * vp - s * vq; V[i][q] = s * vp + c * vq; }
    }
  }
  return { ev: a.map((r, i) => r[i]), V };
}

/**
 * Effective number of bets (Meucci), weight-aware.
 *
 * Decomposes the book into uncorrelated principal portfolios and measures how
 * evenly the OWNER'S MONEY spreads its variance across them.
 * Ranges 1 (everything is one bet) → n (perfectly spread).
 *
 * @param syms    [SYM]
 * @param weights [w] summing to 1, same order
 * @param rets    { SYM: [daily log returns] }
 * LIMITATION (know this before trusting an edge case): when eigenvalues are
 * near-degenerate — e.g. a basket of genuinely independent, equal-vol assets —
 * every basis is an eigenbasis and the distribution is not unique, so ENB is
 * basis-dependent there. Real books are far from degenerate (one dominant
 * component, the rest small), which is why repeated runs agree. Meucci's
 * minimum-torsion basis is the fix if that case ever matters here.
 *
 * @param opts    { topLoads } names to list per principal portfolio (default 5)
 * @returns { enb, distribution, loads, top_share_pct, n }
 */
function weightedENB(syms, weights, rets, opts = {}) {
  const n = syms.length;
  if (n < 2) return { enb: n ? 1 : 0, distribution: [1], loads: [syms], top_share_pct: 100, n };
  const sd = syms.map(s => Math.sqrt(vari(rets[s])));
  const C = [];
  for (let i = 0; i < n; i++) {
    C.push([]);
    for (let j = 0; j < n; j++) C[i].push(i === j ? 1 : (sd[i] && sd[j] ? covar(rets[syms[i]], rets[syms[j]]) / (sd[i] * sd[j]) : 0));
  }
  const { ev, V } = jacobi(C);
  const order = ev.map((_, i) => i).sort((x, y) => ev[y] - ev[x]);
  const ws = weights.map((w, i) => w * sd[i]);          // risk-scaled exposure
  const raw = order.map(k => {
    let p = 0; for (let i = 0; i < n; i++) p += ws[i] * V[i][k];
    return p * p * Math.max(ev[k], 0);
  });
  const tot = raw.reduce((a, b) => a + b, 0) || 1;
  const d = raw.map(x => x / tot);
  const H = -d.reduce((a, p) => a + (p > 1e-12 ? p * Math.log(p) : 0), 0);
  const topN = opts.topLoads || 5;
  const loads = order.slice(0, 10).map(k =>
    syms.map((s, i) => [s, Math.abs(V[i][k])]).sort((a, b) => b[1] - a[1]).slice(0, topN).map(x => x[0]));
  return {
    enb: +Math.exp(H).toFixed(2),
    distribution: d.map(x => +x.toFixed(5)),
    loads,
    top_share_pct: +(d[0] * 100).toFixed(1),
    n
  };
}

/**
 * Variance split across factor proxies + stock-specific residual.
 * Factors are orthogonalised IN ORDER (Gram-Schmidt) so shares sum to ~100%
 * without double-counting — the first factor keeps everything it explains.
 *
 * @param port   [daily log returns of the book]
 * @param facts  [{ sym, ar, rets }] ordered: broadest first
 * @returns { ann_vol_pct, factors:[{sym,ar,beta,share}], specific }
 */
function factorShares(port, facts, ppy = 252) {
  const O = [], out = [];
  for (const f of facts) {
    let v = f.rets.slice();
    for (const u of O) { const b = covar(v, u) / (vari(u) || 1); v = v.map((x, i) => x - b * u[i]); }
    O.push(v);
  }
  const vp = vari(port) || 1;
  O.forEach((u, k) => {
    const b = covar(port, u) / (vari(u) || 1);
    out.push({ sym: facts[k].sym, ar: facts[k].ar, beta: +b.toFixed(2), share: +(b * b * vari(u) / vp).toFixed(4) });
  });
  const explained = out.reduce((a, f) => a + f.share, 0);
  return {
    ann_vol_pct: +(Math.sqrt(vp * ppy) * 100).toFixed(1),
    factors: out,
    specific: +Math.max(0, 1 - explained).toFixed(4)
  };
}

/**
 * The menu. Screens candidates against THIS book on the two axes that matter:
 * does it move independently, and what does it cost to hold.
 *
 * Crucially reports behaviour on the owner's WORST days, not just full-period
 * correlation — an asset can look uncorrelated on average and still join every
 * selloff. Gold did exactly that in the Aug-2026 window (corr 0.43 overall,
 * −1.92% on the worst 20 days).
 *
 * @param port       [daily log returns of the book]
 * @param candidates [{ sym, ar, rets }]
 * @param factors    [{ sym, ar, rets }] — "what risks does it react to"
 * @param opts       { worstN=20, blend=0.10 }
 */
function screenCandidates(port, candidates, factors, opts = {}) {
  const worstN = opts.worstN || 20;
  const blend = opts.blend ?? 0.10;
  const T = port.length;
  const worst = port.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).slice(0, Math.min(worstN, T)).map(x => x[1]);
  const downs = port.map((v, i) => [v, i]).filter(x => x[0] < 0).map(x => x[1]);
  const ups = port.map((v, i) => [v, i]).filter(x => x[0] > 0).map(x => x[1]);
  const condBeta = (idx, r) => {
    if (idx.length < 10) return null;
    const y = idx.map(i => r[i]), x = idx.map(i => port[i]);
    const my = mean(y), mx = mean(x);
    let c = 0, v = 0;
    for (let k = 0; k < y.length; k++) { c += (y[k] - my) * (x[k] - mx); v += (x[k] - mx) * (x[k] - mx); }
    return v ? +(c / v).toFixed(2) : null;
  };
  const rows = candidates.map(c => {
    const r = c.rets;
    const onWorst = mean(worst.map(i => r[i])) * 100;
    const rose = worst.filter(i => r[i] > 0).length;
    const mixed = port.map((p, i) => (1 - blend) * p + blend * r[i]);
    const own = stats(r);
    const reacts = {};
    factors.forEach(f => { reacts[f.sym] = +(covar(r, f.rets) / (vari(f.rets) || 1)).toFixed(2); });
    return {
      sym: c.sym, ar: c.ar, group: c.group || null,
      corr: +corr(port, r).toFixed(2),
      beta_down: condBeta(downs, r),      // how it moves when YOU fall
      beta_up: condBeta(ups, r),          // …and when you rise
      on_worst_days_pct: +onWorst.toFixed(2),
      rose_on: rose, of_worst: worst.length,
      own: own,                            // what holding it cost/paid
      reacts,                              // which risks it actually responds to
      at_blend: Object.assign({ weight_pct: +(blend * 100).toFixed(0) }, stats(mixed))
    };
  });
  // ordered by independence — NOT by preference. No ranking is implied.
  rows.sort((a, b) => a.corr - b.corr);
  return {
    worst_days_used: worst.length,
    your_worst_avg_pct: +(mean(worst.map(i => port[i])) * 100).toFixed(2),
    your_worst_day_pct: +(Math.min(...port) * 100).toFixed(2),
    you: stats(port),
    candidates: rows,
    caveat_ar: 'قياس تاريخي على النافذة المذكورة — مو تنبؤ. الترتيب حسب الاستقلالية فقط، وما فيه أي ترشيح. القرار في النهاية عندك.'
  };
}

/** Portfolio daily returns from weights + per-name return series. */
function portfolioReturns(syms, weights, rets) {
  const T = Math.min(...syms.map(s => rets[s].length));
  const out = [];
  for (let t = 0; t < T; t++) {
    let x = 0;
    for (let i = 0; i < syms.length; i++) x += weights[i] * rets[syms[i]][t];
    out.push(x);
  }
  return out;
}

/** Align many {date:close} maps onto their common dates → { dates, rets }. */
function alignReturns(byDate, syms, maxDays) {
  if (!syms.length) return { dates: [], rets: {} };
  let dates = Object.keys(byDate[syms[0]] || {});
  for (const s of syms) { const k = new Set(Object.keys(byDate[s] || {})); dates = dates.filter(d => k.has(d)); }
  dates.sort();
  if (maxDays && dates.length > maxDays + 1) dates = dates.slice(-(maxDays + 1));
  const rets = {};
  for (const s of syms) rets[s] = logrets(dates.map(d => byDate[s][d]));
  return { dates, rets };
}

// Candidate universe — measuring instruments for distinct risk drivers, NOT
// picks. Grouped so the tab can say what each one is exposed to in plain words.
const CANDIDATE_UNIVERSE = [
  { sym: 'IEF',  ar: 'سندات حكومية ١٠ سنوات', group: 'سندات' },
  { sym: 'TLT',  ar: 'سندات حكومية ٢٠ سنة',   group: 'سندات' },
  { sym: 'SHY',  ar: 'سندات حكومية قصيرة',    group: 'سندات' },
  { sym: 'TIP',  ar: 'سندات مربوطة بالتضخم',  group: 'سندات' },
  { sym: 'LQD',  ar: 'سندات شركات ممتازة',    group: 'سندات' },
  { sym: 'HYG',  ar: 'سندات شركات عالية العائد', group: 'سندات' },
  { sym: 'GLD',  ar: 'ذهب',                   group: 'سلع' },
  { sym: 'SLV',  ar: 'فضة',                   group: 'سلع' },
  { sym: 'USO',  ar: 'نفط',                   group: 'سلع' },
  { sym: 'DBC',  ar: 'سلع واسعة',             group: 'سلع' },
  { sym: 'DBA',  ar: 'سلع زراعية',            group: 'سلع' },
  { sym: 'EFA',  ar: 'أسهم دول متقدمة',       group: 'أسهم خارج أمريكا' },
  { sym: 'VGK',  ar: 'أسهم أوروبا',           group: 'أسهم خارج أمريكا' },
  { sym: 'EWJ',  ar: 'أسهم اليابان',          group: 'أسهم خارج أمريكا' },
  { sym: 'EEM',  ar: 'أسهم ناشئة',            group: 'أسهم خارج أمريكا' },
  { sym: 'INDA', ar: 'أسهم الهند',            group: 'أسهم خارج أمريكا' },
  { sym: 'FXI',  ar: 'أسهم صينية كبرى',       group: 'أسهم خارج أمريكا' },
  { sym: 'XLP',  ar: 'سلع استهلاكية أساسية',  group: 'أسهم دفاعية' },
  { sym: 'XLU',  ar: 'مرافق',                 group: 'أسهم دفاعية' },
  { sym: 'XLV',  ar: 'رعاية صحية',            group: 'أسهم دفاعية' },
  { sym: 'USMV', ar: 'أسهم أقل تذبذباً',      group: 'أسهم دفاعية' },
  { sym: 'VNQ',  ar: 'عقار مدرّج',            group: 'أصول حقيقية' },
  { sym: 'IGF',  ar: 'بنية تحتية',            group: 'أصول حقيقية' },
  { sym: 'XLE',  ar: 'قطاع الطاقة',           group: 'أصول حقيقية' },
  { sym: 'DBMF', ar: 'عقود آجلة مُدارة',      group: 'استراتيجيات بديلة' },
  { sym: 'BTAL', ar: 'ضد بيتا السوق',         group: 'استراتيجيات بديلة' },
  { sym: 'UUP',  ar: 'الدولار',               group: 'عملات' },
  { sym: 'IWM',  ar: 'شركات أمريكية صغيرة',   group: 'أسهم أمريكية' },
  { sym: 'IBIT', ar: 'بتكوين',                group: 'أصول رقمية' }
];

// Ordered broadest-first — orthogonalisation gives earlier factors priority.
const FACTOR_SET = [
  { sym: 'SPY', ar: 'السوق الأمريكي' },
  { sym: 'GLD', ar: 'الذهب' },
  { sym: 'SMH', ar: 'أشباه الموصلات' },
  { sym: 'IWM', ar: 'الشركات الصغيرة' },
  { sym: 'TLT', ar: 'الفائدة' },
  { sym: 'UUP', ar: 'الدولار' },
  { sym: 'USO', ar: 'النفط' }
];

/**
 * One book → the whole diversification payload the dashboard tab renders.
 *
 * @param holdings [{ sym, value }]              — owned positions only
 * @param byDate   { SYM: { 'YYYY-MM-DD': close } } for holdings, factors, candidates
 * @param meta     { asOf, saDate, maxDays }
 *
 * Everything here is measurement over a stated window. No target weights, no
 * ranking by preference, no forecast. The tab must present it the same way.
 */
function buildDiversify(holdings, byDate, meta = {}) {
  const maxDays = meta.maxDays || 500;
  const owned = holdings.filter(h => h.value > 0 && byDate[h.sym] &&
    Object.keys(byDate[h.sym]).length > 30);
  const skipped = holdings.filter(h => h.value > 0 && !owned.includes(h)).map(h => h.sym);
  const total = holdings.reduce((a, h) => a + (h.value > 0 ? h.value : 0), 0);
  const covered = owned.reduce((a, h) => a + h.value, 0);

  const factors = FACTOR_SET.filter(f => byDate[f.sym]);
  const cands = CANDIDATE_UNIVERSE.filter(c => byDate[c.sym] &&
    Object.keys(byDate[c.sym]).length > 100);

  const syms = owned.map(h => h.sym);
  if (syms.length < 2 || !factors.length) {
    return { as_of: meta.asOf || null, ok: false,
             reason: 'not enough price history to measure diversification' };
  }
  const w = owned.map(h => h.value / covered);

  const universe = Array.from(new Set(
    syms.concat(factors.map(f => f.sym)).concat(cands.map(c => c.sym))));
  const { dates, rets } = alignReturns(byDate, universe, maxDays);
  if (dates.length < 60) {
    return { as_of: meta.asOf || null, ok: false,
             reason: 'common price window too short (' + dates.length + ' days)' };
  }

  const enb = weightedENB(syms, w, rets);
  const port = portfolioReturns(syms, w, rets);
  const layers = factorShares(port, factors.map(f => ({ sym: f.sym, ar: f.ar, rets: rets[f.sym] })));
  const screen = screenCandidates(
    port,
    cands.map(c => ({ sym: c.sym, ar: c.ar, group: c.group, rets: rets[c.sym] })),
    factors.map(f => ({ sym: f.sym, ar: f.ar, rets: rets[f.sym] })));

  // Equal-weight counterfactual: does spreading the SAME names help? On Rashed's
  // book it does not, because the largest position is the diversifier. Reporting
  // it stops the tab implying "spread it evenly" is automatically better.
  const eq = new Array(syms.length).fill(1 / syms.length);
  const enbEqual = weightedENB(syms, eq, rets);
  const portEqual = portfolioReturns(syms, eq, rets);

  return {
    as_of: meta.asOf || null,
    sa_date: meta.saDate || null,
    ok: true,
    window: { from: dates[0], to: dates[dates.length - 1], days: dates.length },
    coverage: {
      names: syms.length, total_names: holdings.filter(h => h.value > 0).length,
      covered_value: Math.round(covered), total_value: Math.round(total),
      coverage_pct: total ? +(covered / total * 100).toFixed(1) : 0,
      skipped
    },
    // "how many real bets is this money making" — weight-aware (Meucci).
    // NOT the same number as risk-core's unweighted effectiveIndependentBets.
    bets: {
      effective_bets_weighted: enb.enb,
      top_bet_share_pct: enb.top_share_pct,
      top_bet_names: enb.loads[0],
      second_bet_names: enb.loads[1],
      distribution: enb.distribution.slice(0, 10),
      if_equal_weighted: enbEqual.enb,
      equal_weight_note_ar: enbEqual.enb >= enb.enb
        ? 'لو وزّعت نفس الأسماء بالتساوي، عدد الرهانات يصير ' + enbEqual.enb + ' بدل ' + enb.enb + '.'
        : 'لو وزّعت نفس الأسماء بالتساوي، عدد الرهانات ينزل إلى ' + enbEqual.enb + ' بدل ' + enb.enb + ' — لأن أكبر مركز عندك هو نفسه اللي يفرّق حركتك عن السوق.'
    },
    // where the book's movement actually comes from
    layers: {
      ann_vol_pct: layers.ann_vol_pct,
      factors: layers.factors,
      specific_pct: +(layers.specific * 100).toFixed(1)
    },
    you: screen.you,
    if_equal_weighted: stats(portEqual),
    worst_days: {
      n: screen.worst_days_used,
      avg_pct: screen.your_worst_avg_pct,
      worst_pct: screen.your_worst_day_pct
    },
    menu: screen.candidates,
    factors_used: factors.map(f => ({ sym: f.sym, ar: f.ar })),
    candidates_missing: CANDIDATE_UNIVERSE.filter(c => !cands.includes(c)).map(c => c.sym),
    caveat_ar: screen.caveat_ar,
    disclaimer_ar: 'تحليل معلوماتي — ليست نصيحة مالية'
  };
}

module.exports = {
  mean, vari, covar, corr, logrets, stats, jacobi,
  weightedENB, factorShares, screenCandidates, portfolioReturns, alignReturns,
  buildDiversify, CANDIDATE_UNIVERSE, FACTOR_SET
};
