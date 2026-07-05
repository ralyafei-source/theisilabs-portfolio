// ============================================================================
// bucket_scorer.js — THEISI bucket scorer v2 (SPEC-compliant)
// STATUS: implements THEISI_SCORER_EXPLAINER_LOGIC_SPEC_v1 (hybrid target, spec §7)
// and THEISI_HORIZON_INTELLIGENCE_MASTER_v2 §3 routing.
//   • SHORT: computed timing 0–100 (unchanged math). NO Quant blend anywhere.
//   • MID:   grade-routed = mean(Valuation, Growth, EPS Revisions). Honest read.
//   • LONG:  grade-routed = mean(Profitability, Growth, Valuation). Quant = TAG only.
//   • Archetypes (§1, precedence: value_trap > momentum_trap > quality_premium > hidden_quality).
//   • Conviction tiers (§2): High ≥180d & ≥10 analysts · Medium ≥30d & ≥5 · else Provisional.
//   • Distortion sniff-test (§3): NIM ≥95% or EPSg FWD >150% while P/E & PEG blank.
//   • Value-trap cap (§1.2): mid flagged capped, suppress from MID opportunities.
//   • Binding constraint (§4): weakest routed LONG grade.
//   • owned = filter metadata ONLY. ETFs excluded. <60% coverage → bucket null.
// Fixes the MXL long 45→81 inflation: no composite, no blend — routed grades only.
// Backward-compat: short/mid/long each expose {score, blended:score, coverage}.
// ============================================================================

const _num = v => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s === 'NM' || s === 'N/A') return null;
  const n = Number(String(s).replace(/%/g, ''));
  return isFinite(n) ? n : null;
};
const _GRADE = { 'A+':1.0,'A':0.93,'A-':0.87,'B+':0.80,'B':0.73,'B-':0.67,
                 'C+':0.60,'C':0.53,'C-':0.47,'D+':0.40,'D':0.33,'D-':0.27,'F':0.0 };
const _grade = v => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toUpperCase();
  return _GRADE[s] !== undefined ? _GRADE[s] : null;
};
const _gLetter = v => (v === undefined || v === null) ? null : String(v).trim().toUpperCase();
const _atMost = (letter, cut) => { const g=_grade(letter); return g !== null && g <= _GRADE[cut]; };   // letter ≤ cut
const _atLeast = (letter, cut) => { const g=_grade(letter); return g !== null && g >= _GRADE[cut]; };  // letter ≥ cut

const _ETF_SECTORS = new Set(['U.S. Equity','Sector Equity','Alternative','Fixed Income','International Equity','Commodity']);
function _isETF(s) {
  const d = (s.sheets && s.sheets.dashboard) || s;
  const noGrades = _grade(d['Valuation Grade']) === null && _grade(d['Growth Grade']) === null
                && _grade(d['Profitability Grade']) === null;
  const sec = String(d['Sector'] || '').trim();
  return noGrades && (_ETF_SECTORS.has(sec) || /equity|fund|alternative/i.test(sec));
}

function _percentile(arr, value) {
  const xs = arr.filter(v => v !== null);
  if (!xs.length || value === null) return null;
  if (xs.length === 1) return 0.5;
  let below = 0, equal = 0;
  for (const x of xs) { if (x < value) below++; else if (x === value) equal++; }
  return (below + 0.5 * equal) / xs.length;
}
const _sweet = (v, ideal, width) => v === null ? null : Math.max(0, 1 - Math.abs(v - ideal) / width);
function _rsiQuality(rsi, vs50, vs200) {
  if (rsi === null) return null;
  const up = (vs50 !== null && vs50 > 0) && (vs200 !== null && vs200 > 0);
  const ideal = up ? 55 : 38;
  return Math.max(0, 1 - Math.abs(rsi - ideal) / 25);
}
function _wmean(pairs) {
  let sw = 0, s = 0, total = 0;
  for (const [sc, w] of pairs) { total += w; if (sc !== null) { s += sc * w; sw += w; } }
  if (sw === 0) return { score: null, coverage: 0 };
  return { score: s / sw, coverage: total ? (sw / total) : 0 };
}

// ---- archetype detection (SPEC §1, precedence §1 tail) ----------------------
function _archetype(T, rsi, vs50) {
  const strongMomLeg = _atLeast(T.M,'A-') || (_atLeast(T.G,'A-') && _atLeast(T.R,'A-'));
  const weakProf     = _atMost(T.P,'D+');
  const cheap        = _atLeast(T.V,'B-');
  const growthFail   = _atMost(T.G,'D+') || _atMost(T.R,'D+');
  // 1.2 value trap
  if (cheap && growthFail) return { key:'value_trap', frame:'رخيص لسبب — الخصم تحذير لا فرصة' };
  // 1.1 momentum trap (decay vs growth-bet branch)
  if (strongMomLeg && weakProf) {
    const growthBet = _atLeast(T.G,'A-') && _atLeast(T.R,'A-');
    return growthBet
      ? { key:'momentum_trap', branch:'growth_bet', frame:'رهان نمو — هوامش ضعيفة لأن الأرباح في بداية منحنى، راقب التنفيذ' }
      : { key:'momentum_trap', branch:'decay', frame:'صفقة لا استثمار — القوة زخم وليست جودة أعمال' };
  }
  // 1.3 quality premium
  if (_atLeast(T.P,'A-') && _atMost(T.V,'D+') && (_grade(T.G)!==null && _grade(T.G) <= _GRADE['C+'])) {
    return { key:'quality_premium', frame:'أعمال ممتازة بسعر كامل ونمو بطيء — تدفع مقابل الأمان لا الصعود' };
  }
  // 1.4 hidden quality (out of favor OR extended)
  const qualityStrong = _atLeast(T.P,'B+') || (_atLeast(T.G,'B+') && _atLeast(T.P,'B'));
  const coolTiming = (_grade(T.M)!==null && _grade(T.M) <= _GRADE['C+']);
  const extended = (rsi !== null && rsi >= 75) || (vs50 !== null && vs50 >= 0.35);
  if (qualityStrong && (coolTiming || extended)) {
    return extended
      ? { key:'hidden_quality', branch:'extended', frame:'أعمال قوية لكنها ركضت بسرعة — الدرجة القصيرة توقيت لا جودة' }
      : { key:'hidden_quality', branch:'out_of_favor', frame:'أعمال جيدة خارج الأضواء — التوقيت بارد لا الجودة' };
  }
  return null;
}

// ---- conviction (SPEC §2) ----------------------------------------------------
function _conviction(days, analysts) {
  if (days === null && analysts === null) return { tier:'unknown', days, analysts };
  if ((days !== null && days < 14) || (analysts !== null && analysts <= 3))
    return { tier:'provisional', days, analysts };
  if (days !== null && days >= 180 && analysts !== null && analysts >= 10)
    return { tier:'high', days, analysts };
  if (days !== null && days >= 30 && analysts !== null && analysts >= 5)
    return { tier:'medium', days, analysts };
  return { tier:'medium', days, analysts };
}

// ---- distortion sniff-test (SPEC §3) -----------------------------------------
function _distortion(D) {
  const nim = _num(D['Net Income Margin']);
  const epsG = _num(D['EPS Growth (FWD)']);
  const peBlank = _num(D['P/E FWD']) === null;
  const pegBlank = _num(D['PEG FWD']) === null;
  if (((nim !== null && nim >= 95) || (epsG !== null && epsG > 150)) && peBlank && pegBlank) {
    return 'الدرجة تستند إلى بند غير متكرر على الأرجح (هامش/نمو غير معتاد مع غياب P/E وPEG) — تعامل معها بحذر';
  }
  return null;
}

// ---- binding constraint (SPEC §4): weakest routed LONG grade ------------------
function _binding(T) {
  const routed = [['Profitability','P'],['Growth','G'],['Valuation','V']];
  let worst = null;
  routed.forEach(([name,k]) => {
    const g = _grade(T[k]);
    if (g === null) return;
    if (!worst || g < worst.g) worst = { name, letter:T[k], g };
  });
  if (!worst || worst.g >= _GRADE['B-']) return null;
  return { grade:worst.name, letter:worst.letter, note:'العائق: درجة '+worst.name+' ('+worst.letter+') — تتحسن القراءة إذا ارتفعت' };
}

// ---- grade-routed horizon score: mean of routed grade points → 0..100 --------
function _routedScore(letters) {
  const gs = letters.map(_grade).filter(g => g !== null);
  if (!gs.length) return { score:null, coverage:0 };
  return { score: Math.round((gs.reduce((a,b)=>a+b,0)/gs.length)*100), coverage: gs.length/letters.length };
}

// ---- the scorer ---------------------------------------------------------------
function computeBuckets(allStocks) {
  const stocks = allStocks.filter(s => !_isETF(s));
  const D = s => (s.sheets && s.sheets.dashboard) || s;
  const SH = s => (s.sheets && s.sheets.short) || {};

  // SHORT cross-sectional inputs (unchanged timing math — the one computed number)
  const shVs10 = stocks.map(s => _sweet(_num(SH(s)['Last Price Vs. 10D SMA']), 0.0, 0.10));
  const shRSI  = stocks.map(s => _rsiQuality(_num(D(s)['RSI']), _num(D(s)['Last Price Vs. 50D SMA']), _num(D(s)['Last Price Vs. 200D SMA'])));
  const shVs50 = stocks.map(s => _sweet(_num(D(s)['Last Price Vs. 50D SMA']), 0.02, 0.15));
  const shVol  = stocks.map(s => _num(SH(s)['Week Vol / Shares']));
  const sh52   = stocks.map(s => {
    const p = _num(D(s)['Price']), hi = _num(D(s)['52W High']);
    if (p === null || hi === null || hi === 0) return null;
    return _sweet(p / hi, 0.85, 0.45);
  });
  const up = arr => arr.map(v => _percentile(arr, v));
  const SHv10 = up(shVs10), SHrsi = up(shRSI), SHv50 = up(shVs50), SHvol = up(shVol), SH52 = up(sh52);

  const MIN_COV = 0.60;
  const out = {};

  stocks.forEach((s, i) => {
    const d = D(s);
    const sym = d['symbol'] || s.symbol || s.sym;
    const T = { V:_gLetter(d['Valuation Grade']), G:_gLetter(d['Growth Grade']),
                P:_gLetter(d['Profitability Grade']), M:_gLetter(d['Momentum Grade']),
                R:_gLetter(d['EPS Revision Grade']) };
    const quant = _num(d['Quant Rating']);
    const rsi = _num(d['RSI']);
    const vs50 = _num(d['Last Price Vs. 50D SMA']);
    const days = _num(d['Days at Rating']);
    const analysts = _num(d['# SA Analysts Covering']);

    // SHORT — computed timing only. NO blend.
    const shortRaw = _wmean([[SHv10[i],0.30],[SHrsi[i],0.25],[SHv50[i],0.20],[SH52[i],0.15],[SHvol[i],0.10]]);
    const short = (shortRaw.score === null || shortRaw.coverage < MIN_COV)
      ? { score:null, blended:null, coverage:Math.round(shortRaw.coverage*100) }
      : { score:Math.round(shortRaw.score*100), blended:Math.round(shortRaw.score*100), coverage:Math.round(shortRaw.coverage*100) };

    // MID — routed grades: V, G, R (master §3). Value-trap cap suppresses.
    const midR = _routedScore([T.V, T.G, T.R]);
    // LONG — routed grades: P, G, V (master §3). Quant is a tag, never an ingredient.
    const longR = _routedScore([T.P, T.G, T.V]);

    const arch = _archetype(T, rsi, vs50);
    const conv = _conviction(days, analysts);
    const distortion = _distortion(d);
    const binding = _binding(T);
    const capped = arch && arch.key === 'value_trap';

    const packR = (r, isCapped) => (r.score === null || r.coverage < MIN_COV)
      ? { score:null, blended:null, coverage:Math.round(r.coverage*100), method:'routed_grades' }
      : { score:r.score, blended:r.score, coverage:Math.round(r.coverage*100), method:'routed_grades', ...(isCapped?{capped:true}:{}) };

    const shares = _num((s.sheets && s.sheets.holdings && s.sheets.holdings['Shares']) ?? s.shares ?? s['Shares']);

    out[sym] = {
      owned: (shares !== null && shares > 0),   // metadata only — never affects rank
      quant,
      tags: T,
      conviction: conv,
      archetype: arch,
      distortion,
      binding,
      short,
      mid: packR(midR, capped),
      long: packR(longR, false)
    };
  });

  return { scored: out, excluded_etfs: allStocks.filter(_isETF).map(s => s.symbol || s.sym), engine:'v2_spec_routed' };
}

module.exports = { computeBuckets, _isETF, _percentile };
