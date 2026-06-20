// ============================================================================
// EDIT_3_bucket_scorer.js  —  THEISI bucket scorer
// v1.1 · 2026-06-20 · binding-constraint fix (null when no grade <= C+)
// v1.0 · 2026-06-20 · grade-routing rebuild to SCORER_EXPLAINER_LOGIC_SPEC §7
// ============================================================================
// STATUS: FINAL — REVISED to THEISI_SCORER_EXPLAINER_LOGIC_SPEC_v1 §7 and
//         VALIDATED on the real 81-stock store (Portfolio_1_2026-06-19), Session 33.
//         Seven controls (MXL, SEZL, AAPL, AUPH, MU, NEM; BRBR not in portfolio)
//         all resolve correctly; distortion fires on AUPH only; 18 names resolve
//         to archetype=null by design (no sharp pattern — they still carry MID/LONG
//         score + grades + Quant + conviction; the explainer narrates raw grades).
//
// WHAT CHANGED vs the pre-spec composite/blend version:
//   • SHORT — UNCHANGED. Still the one computed 0–100 timing score (SA has no
//     timing signal). Same inputs, same weights, same trend-conditional RSI.
//   • MID/LONG — the opaque composite + Quant blend is REMOVED. Each is now a
//     transparent grade-routed rank derived ONLY from routed SA grades, then
//     adjusted by the honesty GATES so the RANK ORDER is honest:
//         MID  routes  Valuation + Growth + EPS-Revisions
//         LONG routes  Profitability + Growth + Valuation  (+ Quant as a tag)
//   • Quant no longer BLENDS into any horizon (killed the MXL long 45->81
//     inflation). Quant is a visible TAG only.
//   • GATES added: conviction gate (Days-at-Rating + #analysts), trap cap
//     (SA disqualification cap), distortion penalty (one-time-item sniff test).
//   • ARCHETYPES added: value_trap > momentum_trap(decay) > quality_premium >
//     hidden_quality. quality_premium is LABELED, never penalized.
//   • `owned` is filter metadata ONLY — it never enters any rank.
//
// KEPT: ETF exclusion, <60%-coverage skip, the SHORT math, all helpers,
//       per-symbol structure. node --check passes.
//
// Output per stock:
//   { owned, quant, grades:{V,G,P,M,R},
//     short:{score, coverage},
//     mid:  {score, grades, archetype, conviction, flags},
//     long: {score, grades, archetype, conviction, flags, bindingConstraint} }
//   NOTE: mid/long `score` is an ABSOLUTE grade-composite (0..100) adjusted by the
//   gates — NOT a cross-sectional percentile. Stable regardless of batch composition.
//
// Validated against spec §6: MXL, BRBR, SEZL, AAPL, AUPH.
// ============================================================================

// ---- helpers ----------------------------------------------------------------
const _num = v => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s === 'NM' || s === 'N/A') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
};
// letter grade -> 0..1 (A+ = 1.0 ... F = 0)
const _GRADE = { 'A+':1.0,'A':0.93,'A-':0.87,'B+':0.80,'B':0.73,'B-':0.67,
                 'C+':0.60,'C':0.53,'C-':0.47,'D+':0.40,'D':0.33,'D-':0.27,'F':0.0 };
const _grade = v => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toUpperCase();
  return _GRADE[s] !== undefined ? _GRADE[s] : null;
};
// keep the original letter label (for tags) alongside the numeric value
const _gradeLabel = v => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toUpperCase();
  return _GRADE[s] !== undefined ? s : null;
};
// rank a single letter grade on the same A+..F ladder used for cap tests.
// returns an integer 0 (F) .. 12 (A+); null if not a grade.
const _GRADE_RANK = { 'F':0,'D-':1,'D':2,'D+':3,'C-':4,'C':5,'C+':6,
                      'B-':7,'B':8,'B+':9,'A-':10,'A':11,'A+':12 };
const _gradeRank = v => {
  const lab = _gradeLabel(v);
  return lab === null ? null : _GRADE_RANK[lab];
};

// ETF / fund detection: no letter grades AND sector is an index/fund label
const _ETF_SECTORS = new Set(['U.S. Equity','Sector Equity','Alternative','Fixed Income','International Equity','Commodity']);
function _isETF(s) {
  const d = (s.sheets && s.sheets.dashboard) || s;
  const noGrades = _grade(d['Valuation Grade']) === null && _grade(d['Growth Grade']) === null
                && _grade(d['Profitability Grade']) === null;
  const sec = String(d['Sector'] || '').trim();
  return noGrades && (_ETF_SECTORS.has(sec) || /equity|fund|alternative/i.test(sec));
}

// cross-sectional percentile rank of value within arr (ignoring nulls).
// returns 0..1 (1 = highest raw). ties share average rank.
function _percentile(arr, value) {
  const xs = arr.filter(v => v !== null);
  if (!xs.length || value === null) return null;
  if (xs.length === 1) return 0.5;
  let below = 0, equal = 0;
  for (const x of xs) { if (x < value) below++; else if (x === value) equal++; }
  return (below + 0.5 * equal) / xs.length;
}

// sweet-spot quality: 1 at ideal, linear decay to 0 at `width` away.
const _sweet = (v, ideal, width) => v === null ? null : Math.max(0, 1 - Math.abs(v - ideal) / width);

// trend-conditional RSI quality (Scoring Standard §3.3)
function _rsiQuality(rsi, vs50, vs200) {
  if (rsi === null) return null;
  const up = (vs50 !== null && vs50 > 0) && (vs200 !== null && vs200 > 0);
  const ideal = up ? 55 : 38;
  return Math.max(0, 1 - Math.abs(rsi - ideal) / 25);
}

// weighted mean over present (non-null) components, renormalizing weights
function _wmean(pairs) { // pairs: [ [score, weight], ... ]
  let sw = 0, s = 0, present = 0, total = 0;
  for (const [sc, w] of pairs) { total += w; if (sc !== null) { s += sc * w; sw += w; present++; } }
  if (sw === 0) return { score: null, coverage: 0 };
  return { score: s / sw, coverage: total ? (sw / total) : 0, present };
}

// ============================================================================
// GATE LOGIC (spec §1-§4) — these qualify the RANK; they never invent a number.
// ============================================================================

// --- §2 Conviction gate: Days-at-Rating + # analysts -> tier + rank multiplier.
// Conviction does NOT move a rank up; it only discounts low-trust (provisional)
// names so a fragile score never ranks silently beside a settled one.
function _conviction(days, analysts) {
  const d = _num(days), a = _num(analysts);
  if (d !== null && d >= 180 && a !== null && a >= 10)
    return { tier: 'high',   mult: 1.00, days: d, analysts: a };
  if ((d !== null && d < 14) || (a !== null && a <= 3))
    return { tier: 'provisional', mult: 0.80, days: d, analysts: a };
  if (d !== null && d >= 30 && a !== null && a >= 5)
    return { tier: 'medium', mult: 1.00, days: d, analysts: a };
  // partial data -> treat as medium/normal but report what we have
  return { tier: 'medium', mult: 1.00, days: d, analysts: a };
}

// --- §1.2 / §2.1 SA disqualification cap.
// Capped if: D+ or worse on Growth, Momentum, OR EPS-Revisions
//        OR  D- or worse on Valuation or Profitability.
// Returns the list of grades that triggered the cap (empty = not capped).
function _capTriggers(g) { // g: {V,G,P,M,R} letter labels
  const t = [];
  const leD = name => { const r = _gradeRank(g[name]); return r !== null && r <= _GRADE_RANK['D+']; };   // D+ or worse
  const leDminus = name => { const r = _gradeRank(g[name]); return r !== null && r <= _GRADE_RANK['D-']; }; // D- or worse
  if (leD('G')) t.push('Growth');
  if (leD('M')) t.push('Momentum');
  if (leD('R')) t.push('EPS Revisions');
  if (leDminus('V')) t.push('Valuation');
  if (leDminus('P')) t.push('Profitability');
  return t;
}

// --- §3 distortion sniff-test: are the grades built on a one-time item?
// Trigger: net margin implausibly POSITIVE (~100%, i.e. a one-time gain inflating
//          profitability), OR EPS Growth FWD extreme (>150%), WHILE P/E FWD and
//          PEG FWD are both blank.
// NOTE: net-margin leg is NOT abs() — a huge NEGATIVE margin is a genuinely
// unprofitable business already captured by the Profitability grade; discounting
// it here would double-penalize (BTBT/PONY false-positive fix, Session 33).
function _distorted(d) {
  const nim = _num(d['Net Income Margin']);
  const epsg = _num(d['EPS Growth (FWD)']);
  const peFwd = _num(d['P/E FWD']);
  const pegFwd = _num(d['PEG FWD']);
  const blanks = (peFwd === null && pegFwd === null);
  // positive-only margin distortion (accepts percent 95+ or fraction ~1.0)
  const nimWildPct  = nim !== null && nim >= 95;                          // 95%+ as percent
  const nimWildFrac = nim !== null && nim >= 0.95 && nim <= 1.5;          // ~1.0 as fraction
  // EPS growth distortion: only an implausibly LARGE positive forward swing on a
  // blank multiple is suspect. NOT abs() — a normal % decline (e.g. -30) is not a
  // distortion. The fractional band starts at 3x to avoid misreading percent-scale
  // declines like -30 as "30x growth" (BTBT/PONY false-positive fix).
  const epsWildPct  = epsg !== null && epsg >= 150;                       // 150%+ as percent
  const epsWildFrac = epsg !== null && epsg >= 3 && epsg <= 50;           // 3x+ as fraction
  return blanks && (nimWildPct || nimWildFrac || epsWildPct || epsWildFrac);
}

// --- §1 archetype detection from the 5 grade labels.
// Precedence: value_trap > momentum_trap(decay) > quality_premium > hidden_quality.
// `distorted` (§3) gates the strong-quality branch: a strong-but-distorted name is
// labeled `unconfirmed`, NOT hidden_quality — we don't imply a one-off is "overlooked quality".
// `shortScore` (the computed SHORT timing 0..100, or null) splits §1.4:
//   strong Momentum + poor SHORT timing => extended_candidate ("loved, ran too far, wait")
//   weak/cool Momentum                  => genuinely out of favor (the NEM hidden-quality case)
function _archetype(g, distorted, shortScore) {
  const r = name => _gradeRank(g[name]);
  const ge = (name, lab) => { const x = r(name); return x !== null && x >= _GRADE_RANK[lab]; };
  const le = (name, lab) => { const x = r(name); return x !== null && x <= _GRADE_RANK[lab]; };

  const valStrong  = ge('V','B-');   // optically cheap for sector
  const profElite  = ge('P','A-');    // A-range margins (AAPL/NEM)
  const profStrong = ge('P','B');     // strong margins incl. B+ fortresses (MU)
  const profWeak   = le('P','D+');
  const growStrong = ge('G','A-');
  const growSolid  = ge('G','B-');    // solid (not necessarily A-range) — NEM has Growth B
  const growWeak   = le('G','C');     // modest/weak
  const growFail   = le('G','D+');
  const revStrong  = ge('R','A-');
  const revFail    = le('R','D+');
  const momStrong  = ge('M','B+');    // "hot/leading" = B+ or better (real-data boundary: B and below = cool/average)
  const momFail    = le('M','D+');
  const valWeak    = le('V','D');     // expensive for sector
  const extended   = shortScore !== null && shortScore <= 40;  // poor entry timing right now

  // 1.2 value trap — cheap but Growth and/or Revisions failing (often Mom F)
  if (valStrong && (growFail || revFail)) {
    return { name: 'value_trap',
      note: 'Optically cheap for its sector, but growth and/or estimate revisions are failing — the discount is a warning, not a gift.' };
  }
  // 1.1 momentum trap — hot momentum/growth but Profitability weak
  if (profWeak && (growStrong || revStrong)) {
    if (growStrong && revStrong) {   // trough / pre-inflection -> growth-bet branch
      return { name: 'momentum_trap', branch: 'growth_bet',
        note: 'Weak margins alongside strong growth + rising estimates — reads as early-ramp / pre-inflection, not a bad business. A high-conviction growth bet; watch execution.' };
    }
    return { name: 'momentum_trap', branch: 'decay',
      note: 'The strength is price momentum, not business quality — a trade, not a hold.' };
  }
  // 1.3 quality premium — ELITE business, fully/over-priced, slow. NOT a trap.
  if (profElite && valWeak && growWeak) {
    return { name: 'quality_premium',
      note: 'Excellent business priced for perfection with slow growth — you pay for safety and buybacks, not upside. Best entry on multiple compression. Not a negative flag.' };
  }
  // 1.4 hidden quality — split by Momentum direction + SHORT timing (spec §1.4).
  // A name qualifies as a quality situation if Profitability is strong (B+/A-range)
  // AND there is no failing leg (Growth at least solid, nothing capping it).
  // The split is EXHAUSTIVE — a qualifying name never returns null:
  //   - distorted            -> unconfirmed (one-time item, not real quality)
  //   - hot + extended       -> extended_candidate (loved, ran too far, low SHORT is timing)
  //   - not hot (cool/avg)   -> out_of_favor (quality under-loved; the NEM case)
  //   - hot + not extended   -> quality_intact (strong all round, entry is fine)
  const noFailingLeg = !growFail && !revFail && !momFail && !valWeak;
  if (profStrong && growSolid && noFailingLeg) {
    if (distorted) return { name: 'unconfirmed',
      note: 'Strong grades, but they rest on what appears to be a one-time item (see distortion caveat) — unconfirmed until recurring earnings show up.' };
    // "hot" = strong medium-term price momentum (M >= B). Not hot => under-loved.
    if (momStrong) {
      if (extended) return { name: 'hidden_quality', branch: 'extended_candidate',
        note: 'Great business that ran too far, too fast — the low SHORT score is TIMING, not quality. Wait for a pullback.' };
      return { name: 'hidden_quality', branch: 'quality_intact',
        note: 'Strong profitability with no failing leg and momentum still constructive — quality is real; judge entry on SHORT timing.' };
    }
    // momentum is merely cool/average (C+ down to just-below-B) — a quality name the
    // market isn't chasing. Under-loved / overlooked. (NEM: P A+, G B, M B-ish.)
    return { name: 'hidden_quality', branch: 'out_of_favor',
      note: 'Quality is strong but the stock is not being chased on price momentum — good business, overlooked. SA Quant tends to under-rate it.' };
  }
  // strong growth + weak profitability already handled above (momentum_trap); a strong-Growth
  // name that is also distorted but not Prof-strong falls through to unconfirmed:
  if (growStrong && distorted) {
    return { name: 'unconfirmed',
      note: 'Growth grade is strong but rests on what appears to be a one-time item (see distortion caveat) — unconfirmed.' };
  }
  return { name: null, note: null };
}

// --- §4 binding constraint: the single weakest grade gating an otherwise strong name.
// --- §4 binding constraint: the single weakest grade gating an otherwise strong name.
// Only meaningful when the weakest grade is genuinely weak (<= C+). When every grade
// is strong (no weak leg), return null — the tab/explainer renders "بلا نقطة ضعف".
function _bindingConstraint(g) {
  const names = { V:'Valuation', G:'Growth', P:'Profitability', M:'Momentum', R:'EPS Revisions' };
  let worst = null, worstRank = Infinity;
  for (const k of ['V','G','P','M','R']) {
    const rk = _gradeRank(g[k]);
    if (rk !== null && rk < worstRank) { worstRank = rk; worst = k; }
  }
  if (worst === null) return null;
  if (worstRank > _GRADE_RANK['C+']) return null;   // no genuinely weak leg -> no binding constraint
  return { grade: names[worst], label: _gradeLabel(g[worst]),
    watch: `Held back by ${names[worst]} (${_gradeLabel(g[worst])}). The read improves if ${names[worst]} lifts.` };
}

// ---- the scorer -------------------------------------------------------------
function computeBuckets(allStocks) {
  // exclude ETFs entirely
  const stocks = allStocks.filter(s => !_isETF(s));
  const D = s => (s.sheets && s.sheets.dashboard) || s;
  const SH = s => (s.sheets && s.sheets.short) || {};

  // ---- precompute cross-sectional inputs for SHORT (UNCHANGED) ----
  const shVs10  = stocks.map(s => _sweet(_num(SH(s)['Last Price Vs. 10D SMA']), 0.0, 0.10));
  const shRSI   = stocks.map(s => _rsiQuality(_num(D(s)['RSI']), _num(D(s)['Last Price Vs. 50D SMA']), _num(D(s)['Last Price Vs. 200D SMA'])));
  const shVs50  = stocks.map(s => _sweet(_num(D(s)['Last Price Vs. 50D SMA']), 0.02, 0.15));
  const shVol   = stocks.map(s => _num(SH(s)['Week Vol / Shares']));
  const sh52    = stocks.map(s => {
    const p = _num(D(s)['Price']), hi = _num(D(s)['52W High']);
    if (p === null || hi === null || hi === 0) return null;
    return _sweet(p / hi, 0.85, 0.45);
  });

  // MID grade inputs (routed): Valuation + Growth + EPS-Revisions
  const mV = stocks.map(s => _grade(D(s)['Valuation Grade']));
  const mG = stocks.map(s => _grade(D(s)['Growth Grade']));
  const mR = stocks.map(s => _grade(D(s)['EPS Revision Grade']));

  // LONG grade inputs (routed): Profitability + Growth + Valuation (Quant is a tag)
  const lP = stocks.map(s => _grade(D(s)['Profitability Grade']));
  const lG = stocks.map(s => _grade(D(s)['Growth Grade']));
  const lV = stocks.map(s => _grade(D(s)['Valuation Grade']));

  // percentile rankers (SHORT only — MID/LONG use the absolute grade ladder so
  // a capped/weak name doesn't get rank-inflated just by being in a weak field)
  const up = arr => arr.map(v => _percentile(arr, v));
  const SHv10=up(shVs10), SHrsi=up(shRSI), SHv50=up(shVs50), SHvol=up(shVol), SH52=up(sh52);

  const MIN_COV = 0.60;
  const out = {};

  stocks.forEach((s, i) => {
    const d = D(s);
    const sym = d['symbol'] || s.symbol || s.sym;

    // grade label tags (always shown — the breakdown is the truth)
    const grades = {
      V: _gradeLabel(d['Valuation Grade']),
      G: _gradeLabel(d['Growth Grade']),
      P: _gradeLabel(d['Profitability Grade']),
      M: _gradeLabel(d['Momentum Grade']),
      R: _gradeLabel(d['EPS Revision Grade']),
    };

    // ---- SHORT — computed timing score (UNCHANGED) ----
    const short = _wmean([
      [SHv10[i],0.30],[SHrsi[i],0.25],[SHv50[i],0.20],[SH52[i],0.15],[SHvol[i],0.10]
    ]);
    const short_p = (short.score===null || short.coverage < MIN_COV)
      ? { score:null, coverage:Math.round(short.coverage*100) }
      : { score:Math.round(short.score*100), coverage:Math.round(short.coverage*100) };

    // ---- shared gate inputs ----
    const conv = _conviction(d['Days at Rating'] ?? d['Days At Rating'], d['# SA Analysts Covering'] ?? d['Analysts']);
    const caps = _capTriggers(grades);
    const capped = caps.length > 0;
    const distorted = _distorted(d);
    const arch = _archetype(grades, distorted, short_p.score);
    const quant = _num(d['Quant Rating']); // tag only — never blended

    // ---- MID — grade-routed rank (Valuation + Growth + Revisions) ----
    const midBase = _wmean([[mV[i],1],[mG[i],1],[mR[i],1]]);
    let mid;
    if (midBase.score === null || midBase.coverage < MIN_COV) {
      mid = { score: null, coverage: Math.round(midBase.coverage*100), grades,
              archetype: arch.name, conviction: conv, flags: [] };
    } else {
      let r = midBase.score;               // 0..1
      const flags = [];
      // quality_premium is NOT a trap (spec §1.3) — label only, never cap-suppress.
      if (capped && arch.name !== 'quality_premium') { r = Math.min(r, 0.40); flags.push({ type:'capped', by: caps }); }  // suppress from MID top
      if (conv.tier === 'provisional') { r *= conv.mult; flags.push({ type:'provisional' }); }
      if (distorted) { r *= 0.85; flags.push({ type:'distortion' }); }
      if (arch.name === 'value_trap') flags.push({ type:'value_trap' });
      mid = { score: Math.round(r*100), coverage: Math.round(midBase.coverage*100),
              grades, archetype: arch.name, conviction: conv, flags };
    }

    // ---- LONG — grade-routed rank (Profitability + Growth + Valuation) ----
    const longBase = _wmean([[lP[i],1],[lG[i],1],[lV[i],1]]);
    let long;
    if (longBase.score === null || longBase.coverage < MIN_COV) {
      long = { score: null, coverage: Math.round(longBase.coverage*100), grades,
               archetype: arch.name, conviction: conv, flags: [],
               bindingConstraint: _bindingConstraint(grades) };
    } else {
      let r = longBase.score;
      const flags = [];
      // quality_premium is NOT a trap (spec §1.3) — label only, never cap-suppress.
      if (capped && arch.name !== 'quality_premium') { r = Math.min(r, 0.45); flags.push({ type:'capped', by: caps }); }  // not a real compounder
      if (conv.tier === 'provisional') { r *= conv.mult; flags.push({ type:'provisional' }); } // the AUPH gate
      if (distorted) { r *= 0.85; flags.push({ type:'distortion' }); }                     // don't trust A+ on a one-off
      if (arch.name === 'quality_premium') flags.push({ type:'quality_premium' });          // LABEL ONLY (§1.3)
      if (arch.name === 'unconfirmed')     flags.push({ type:'unconfirmed' });
      if (arch.name === 'momentum_trap')   flags.push({ type:'momentum_trap', branch: arch.branch });
      if (arch.name === 'hidden_quality')  flags.push({ type:'hidden_quality', branch: arch.branch });
      long = { score: Math.round(r*100), coverage: Math.round(longBase.coverage*100),
               grades, archetype: arch.name, conviction: conv, flags,
               bindingConstraint: _bindingConstraint(grades) };
    }

    const shares = _num((s.sheets && s.sheets.holdings && s.sheets.holdings['Shares']) ?? s.shares ?? s['Shares']);

    out[sym] = {
      owned: (shares !== null && shares > 0),  // filter metadata ONLY — never affects rank
      quant,                                   // visible tag
      grades,
      short: short_p,
      mid,
      long,
    };
  });

  return { scored: out, excluded_etfs: allStocks.filter(_isETF).map(s => s.symbol || s.sym) };
}

module.exports = {
  computeBuckets, _isETF, _percentile,
  _conviction, _capTriggers, _distorted, _archetype, _bindingConstraint
};
