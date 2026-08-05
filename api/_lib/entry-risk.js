// api/_lib/entry-risk.js
// THEISI — ENTRY RISK READ (قراءة مخاطر الدخول)
// GOLDEN SEPARATION: this file computes EVERYTHING. Claude only narrates the
// returned fields. No number here may be re-derived, rounded, or invented downstream.
//
// Answers one question: "how much of the good news is already in the price?"
// Higher score = more demanding entry point. It is NOT a buy/sell verdict.

const clamp01 = x => Math.max(0, Math.min(1, x));

// Linear ramp: at/below lo => 0 risk, at/above hi => 1 risk.
const ramp = (v, lo, hi) => (v == null || !isFinite(v)) ? null : clamp01((v - lo) / (hi - lo));

// SA letter grade -> 0..1 risk (A = cheap = 0 risk, F = demanding = 1)
const GRADE_RISK = {
  'A+':0.00,'A':0.05,'A-':0.12,
  'B+':0.22,'B':0.30,'B-':0.38,
  'C+':0.48,'C':0.55,'C-':0.63,
  'D+':0.73,'D':0.80,'D-':0.88,
  'F':1.00
};

const WEIGHTS = {
  runup:      0.25,  // how much it has already risen
  extension:  0.25,  // how far above its moving averages
  resistance: 0.20,  // how close to a major ceiling
  valuation:  0.20,  // how demanding the price is vs fundamentals
  optimism:   0.10   // how much upside analysts still see left
};

/**
 * @param {object} d
 *   price            number   current price
 *   chg3m            number   % change over ~3 months (e.g. 42.5)
 *   chg6m            number   % change over ~6 months (optional)
 *   sma50            number
 *   sma200           number
 *   high52           number   52-week high
 *   low52            number   52-week low (optional, context only)
 *   valuationGrade   string   SA "Valuation Grade" (A+..F)  [primary]
 *   pe               number   fallback if no SA grade
 *   peg              number   fallback if no SA grade
 *   analystTarget    number   price-target-consensus targetConsensus
 *   rsi              number   RSI(14)
 * @returns {object} entry-risk block (all numbers final, ready to render)
 */
function entryRisk(d = {}) {
  const price = num(d.price);
  const factors = [];

  // ── 1. RUN-UP ─────────────────────────────────────────────────────────────
  // 3m preferred; 6m used only when 3m missing. 0% => no risk, +60% => full.
  const runSrc = num(d.chg3m) != null ? '3m' : (num(d.chg6m) != null ? '6m' : null);
  const runVal = runSrc === '3m' ? num(d.chg3m) : num(d.chg6m);
  const runHi  = runSrc === '6m' ? 90 : 60;
  factors.push(mk('runup', ramp(runVal, 0, runHi), {
    value: runVal, unit: '%', window: runSrc,
    label_ar: 'الارتفاع السابق',
    detail_ar: runVal == null ? null
      : `السهم تحرك ${fmtPct(runVal)} خلال آخر ${runSrc === '6m' ? '٦ أشهر' : '٣ أشهر'}`
  }));

  // ── 2. EXTENSION ABOVE MOVING AVERAGES ────────────────────────────────────
  // Distance above SMA50 (full risk at +25%) and SMA200 (full at +50%).
  // Below the average = 0 risk on this factor (it is not "extended").
  const above50  = pctAbove(price, num(d.sma50));
  const above200 = pctAbove(price, num(d.sma200));
  const r50  = ramp(above50, 0, 25);
  const r200 = ramp(above200, 0, 50);
  const extRaw = avgDefined([r50, r200]);
  factors.push(mk('extension', extRaw, {
    above_sma50_pct: round2(above50), above_sma200_pct: round2(above200),
    label_ar: 'البعد عن المتوسطات',
    detail_ar: above50 == null && above200 == null ? null
      : [ above50  != null ? `${fmtPct(above50)} عن متوسط ٥٠ يوم`   : null,
          above200 != null ? `${fmtPct(above200)} عن متوسط ٢٠٠ يوم` : null
        ].filter(Boolean).join(' · ')
  }));

  // ── 3. RESISTANCE (52-week high as the major ceiling) ─────────────────────
  // At/above the high => full risk (buying into the ceiling).
  // 20% or more below it => 0 risk on this factor.
  const belowHigh = pctBelow(price, num(d.high52)); // 0 = at the high
  factors.push(mk('resistance', belowHigh == null ? null : clamp01(1 - belowHigh / 20), {
    below_52w_high_pct: round2(belowHigh), high52: num(d.high52),
    label_ar: 'القرب من مقاومة رئيسية',
    detail_ar: belowHigh == null ? null
      : belowHigh <= 1 ? 'السعر عند قمة ٥٢ أسبوع أو قريب منها جداً'
      : `${fmtPct(-belowHigh)} تحت قمة ٥٢ أسبوع`
  }));

  // ── 4. VALUATION (SA grade primary, PE/PEG fallback) ──────────────────────
  let valRaw = null, valSrc = null, valDetail = null;
  const g = (d.valuationGrade || '').trim().toUpperCase();
  if (GRADE_RISK[g] != null) {
    valRaw = GRADE_RISK[g]; valSrc = 'sa_grade';
    valDetail = `تقييم Seeking Alpha للسعر: ${g}`;
  } else if (num(d.peg) != null) {
    valRaw = ramp(num(d.peg), 1.0, 3.0); valSrc = 'peg';
    valDetail = `PEG عند ${round2(num(d.peg))}`;
  } else if (num(d.pe) != null) {
    valRaw = ramp(num(d.pe), 18, 60); valSrc = 'pe';
    valDetail = `مكرر الربحية ${round2(num(d.pe))}`;
  }
  factors.push(mk('valuation', valRaw, {
    source: valSrc, grade: GRADE_RISK[g] != null ? g : null,
    pe: num(d.pe), peg: num(d.peg),
    label_ar: 'صعوبة التقييم', detail_ar: valDetail
  }));

  // ── 5. OPTIMISM ALREADY PRICED IN ─────────────────────────────────────────
  // Remaining analyst upside: >=30% left => 0 risk; <=0% left => full risk.
  // RSI above 70 adds a capped bump (short-term crowding).
  const upside = (price && num(d.analystTarget))
    ? ((num(d.analystTarget) - price) / price) * 100 : null;
  let optRaw = upside == null ? null : clamp01(1 - upside / 30);
  const rsi = num(d.rsi);
  if (optRaw != null && rsi != null && rsi > 70) optRaw = clamp01(optRaw + Math.min(0.15, (rsi - 70) / 100));
  else if (optRaw == null && rsi != null) optRaw = ramp(rsi, 50, 85); // RSI-only fallback
  factors.push(mk('optimism', optRaw, {
    analyst_upside_pct: round2(upside), target: num(d.analystTarget), rsi,
    label_ar: 'التفاؤل المُسعّر مسبقاً',
    detail_ar: upside != null
      ? (upside <= 0 ? 'السعر تجاوز متوسط أهداف المحللين'
                     : `يبقى ${fmtPct(upside)} حتى متوسط أهداف المحللين`)
      : (rsi != null ? `RSI عند ${round2(rsi)}` : null)
  }));

  // ── AGGREGATE (renormalized over available factors only) ──────────────────
  let wsum = 0, ssum = 0;
  factors.forEach(f => { if (f.risk != null) { wsum += WEIGHTS[f.key]; ssum += WEIGHTS[f.key] * f.risk; } });
  const available = factors.filter(f => f.risk != null);
  const score = wsum > 0 ? Math.round((ssum / wsum) * 100) : null;
  const coverage = Math.round((wsum / 1) * 100);

  factors.forEach(f => {
    f.weight_used_pct = f.risk == null ? 0 : Math.round((WEIGHTS[f.key] / (wsum || 1)) * 100);
  });

  // Honest conflict surfacing (CORE PRINCIPLE §language rule)
  const conflicts = [];
  const byKey = Object.fromEntries(factors.map(f => [f.key, f]));
  if (byKey.valuation.risk >= 0.7 && byKey.runup.risk >= 0.7)
    conflicts.push('الزخم قوي والتقييم مرتفع في نفس الوقت — الإشارتان تشدّان باتجاهين مختلفين');
  if (byKey.resistance.risk >= 0.8 && byKey.optimism.risk <= 0.3)
    conflicts.push('السعر عند مقاومة لكن المحللون ما زالوا يرون مجالاً للصعود');
  if (byKey.extension.risk <= 0.2 && byKey.valuation.risk >= 0.7)
    conflicts.push('السعر ليس ممتداً فوق متوسطاته لكن التقييم يبقى مرتفعاً');

  return {
    schema: 1,
    score,                                   // 0-100, higher = more demanding entry
    band: band(score),                       // {key, ar, en, color}
    coverage_pct: coverage,                  // % of the model's weight backed by real data
    factors: factors.sort((a, b) => (b.contribution || 0) - (a.contribution || 0)),
    top_drivers: available.slice().sort((a, b) => b.contribution - a.contribution).slice(0, 2).map(f => f.key),
    conflicts,
    missing: factors.filter(f => f.risk == null).map(f => f.key),
    method_ar: 'يُحتسب من خمسة عوامل: الارتفاع السابق ٢٥٪ · البعد عن المتوسطات ٢٥٪ · القرب من المقاومة ٢٠٪ · صعوبة التقييم ٢٠٪ · التفاؤل المُسعّر ١٠٪. تُعاد الموازنة على العوامل المتوفرة فقط.',
    means_ar: 'الرقم يقيس كم من الأخبار الجيدة مُسعّرة في السهم اليوم — يعني هل نقطة الدخول مريحة أو متطلبة. ما يقول إن السهم جيد أو سيء.',
    caveat_ar: 'إحساس باتجاه فقط وبهامش خطأ واسع — ما يتوقع الأسعار، وما هو نصيحة مالية.',
    computed_at: new Date().toISOString()
  };
}

function band(s) {
  if (s == null) return { key: 'unknown', ar: 'بيانات غير كافية', en: 'Insufficient data', color: '#8a93a3' };
  if (s < 30) return { key: 'comfortable', ar: 'نقطة دخول مريحة نسبياً', en: 'Relatively comfortable', color: '#19c37d' };
  if (s < 50) return { key: 'moderate',    ar: 'متوسطة',              en: 'Moderate',              color: '#2bb3b8' };
  if (s < 70) return { key: 'demanding',   ar: 'متطلبة',              en: 'Demanding',             color: '#fbbf24' };
  return       { key: 'stretched',  ar: 'متطلبة جداً',         en: 'Stretched',             color: '#e5484d' };
}

function mk(key, risk, extra) {
  const r = (risk == null || !isFinite(risk)) ? null : clamp01(risk);
  return {
    key,
    risk: r == null ? null : round2(r),
    risk_pct: r == null ? null : Math.round(r * 100),
    weight_pct: Math.round(WEIGHTS[key] * 100),
    contribution: r == null ? 0 : round2(r * WEIGHTS[key]),
    ...extra
  };
}

const num = v => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? null : Number(v);
const round2 = v => v == null ? null : Math.round(v * 100) / 100;
const pctAbove = (p, ma) => (p && ma) ? ((p - ma) / ma) * 100 : null;
const pctBelow = (p, hi) => (p && hi) ? Math.max(0, ((hi - p) / hi) * 100) : null;
const fmtPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const avgDefined = arr => {
  const a = arr.filter(x => x != null);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
};

module.exports = { entryRisk, WEIGHTS, GRADE_RISK };
