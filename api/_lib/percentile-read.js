// api/_lib/percentile-read.js
// THEISI — "وين السعر مقارنة بمعتاده؟"
//
// GOLDEN SEPARATION: every number AND every Arabic sentence here is produced by
// code from templates. Claude never writes these strings and never edits them.
//
// TWO comparisons, always both:
//   self  = today vs THIS stock's own history      → "is this normal for it?"
//   cross = today vs YOUR OTHER HOLDINGS today     → "is its normal itself extreme?"
// The GAP between them is the regime flag (the NVDA problem).
//
// NOT a verdict. NOT a prediction. Rarity is not reversal.

const WINDOW_DAYS   = 750;   // ~3 years of trading days
const MIN_DAYS      = 400;   // below this we refuse a self-percentile
const PCTS          = [1,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,99];

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — BUILD (run weekly by 922, output cached to data/distributions.json)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * closes: array of daily closes, NEWEST FIRST.
 * Returns compact breakpoints — never store the raw history.
 */
function buildBreakpoints(closes) {
  const c = (closes || []).filter(v => v != null && isFinite(v)).map(Number);
  if (c.length < MIN_DAYS) return { n: c.length, insufficient: true };

  const series = { sma50: [], sma200: [], ret3m: [] };

  // Walk each historical day and recompute what the reading WAS on that day.
  for (let i = 0; i < Math.min(c.length, WINDOW_DAYS); i++) {
    const px = c[i];
    if (i + 50  <= c.length) {
      const ma = mean(c.slice(i, i + 50));
      if (ma) series.sma50.push(((px - ma) / ma) * 100);
    }
    if (i + 200 <= c.length) {
      const ma = mean(c.slice(i, i + 200));
      if (ma) series.sma200.push(((px - ma) / ma) * 100);
    }
    if (i + 63  <= c.length) {
      const then = c[i + 63];
      if (then) series.ret3m.push(((px - then) / then) * 100);
    }
  }

  const out = { n: c.length, insufficient: false, normal: {}, span: {} };
  for (const k of ['sma50','sma200','ret3m']) {
    const s = series[k].slice().sort((a,b) => a - b);
    if (s.length < MIN_DAYS) { out[k] = null; continue; }
    out[k] = PCTS.map(p => round2(quantile(s, p / 100)));
    out.normal[k] = round2(quantile(s, 0.50));            // the number that exposes regime
    out.span[k]   = { lo: round2(s[0]), hi: round2(s[s.length - 1]), days: s.length };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — READ (run per stock, per analysis)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} a
 *   sym, price, sma50, sma200, ret3m   — today's values
 *   dist                               — this symbol's entry from distributions.json
 *   crossPct {sma50,sma200,ret3m}      — 0-100 rank vs the OTHER holdings today
 *                                        (from crossSectional() below)
 * Returns the full read. `show:false` means render nothing.
 */
function percentileRead(a = {}) {
  const today = {
    sma50:  pctAbove(a.price, a.sma50),
    sma200: pctAbove(a.price, a.sma200),
    ret3m:  num(a.ret3m)
  };

  const d = a.dist || {};
  const metrics = {};
  for (const k of ['sma50','sma200','ret3m']) {
    if (today[k] == null) continue;
    metrics[k] = {
      key: k,
      value: round2(today[k]),
      normal: d.normal ? d.normal[k] : null,
      self:  (d[k] && !d.insufficient) ? interpPct(d[k], today[k]) : null,
      cross: a.crossPct ? (a.crossPct[k] ?? null) : null
    };
  }

  const usable = Object.values(metrics).filter(m => m.self != null || m.cross != null);
  if (!usable.length) {
    return { show: false, reason: 'no_data', sym: a.sym };
  }

  // Position metrics (sma50/sma200) always win — this read is about WHERE the price
  // sits, not how fast it moved. ret3m is a fallback only when no SMA is available.
  const pos = usable.filter(m => m.key !== 'ret3m');
  const pool = pos.length ? pos : usable;
  const driver = pool.slice().sort((x, y) =>
    dist50(y.self ?? y.cross) - dist50(x.self ?? x.cross))[0];

  const self  = driver.self;
  const cross = driver.cross;
  const nRank = a.normalRank ? (a.normalRank[driver.key] ?? null) : null;

  // ── Regime flag: normal-for-it, but its NORMAL is extreme vs your other stocks.
  // This is the NVDA case — 3 years inside one boom makes abnormal look normal.
  // Uses normalRank (its typical vs their typicals), so it works on a single
  // lookup where there is no live peer set.
  const regime = (self != null && nRank != null && self < 70 && nRank >= 85);

  const zone = zoneOf(self, cross, regime);
  const show = zone.key !== 'normal';

  return {
    show,
    sym: a.sym,
    zone: zone.key,                 // very_high | high | normal | low | very_low | cross_only
    direction: (driver.value ?? 0) >= 0 ? 'up' : 'down',
    driver: driver.key,
    value: driver.value,
    normal: driver.normal,          // ALWAYS surfaced — never show a percentile alone
    self_pct: self,
    cross_pct: cross,
    normal_rank: nRank,
    days_rarer: (self != null && d.span?.[driver.key]) ? Math.round((( zone.key==="very_low"||zone.key==="low") ? self/100 : (100-self)/100) * d.span[driver.key].days) : null,
    days_total: d.span?.[driver.key]?.days ?? null,
    regime_flag: regime,
    window_days: d.n ?? null,
    insufficient: !!d.insufficient,
    text: buildText(driver, self, cross, zone, regime, d, a.sym, nRank),
    computed_at: new Date().toISOString()
  };
}

/**
 * Rank every holding against the others on the SAME metric, today.
 * holdings: [{sym, price, sma50, sma200, ret3m}]
 * Returns { SYM: {sma50, sma200, ret3m} } as 0-100 ranks.
 */
function crossSectional(holdings) {
  const cols = { sma50: [], sma200: [], ret3m: [] };
  const vals = {};
  (holdings || []).forEach(h => {
    vals[h.sym] = {
      sma50:  pctAbove(h.price, h.sma50),
      sma200: pctAbove(h.price, h.sma200),
      ret3m:  num(h.ret3m)
    };
    for (const k of ['sma50','sma200','ret3m'])
      if (vals[h.sym][k] != null) cols[k].push(vals[h.sym][k]);
  });
  for (const k in cols) cols[k].sort((a,b) => a - b);

  const out = {};
  for (const sym in vals) {
    out[sym] = {};
    for (const k of ['sma50','sma200','ret3m']) {
      const v = vals[sym][k];
      out[sym][k] = (v == null || !cols[k].length) ? null : interpPct(null, v, cols[k]);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — ARABIC TEMPLATES (fixed strings, variables filled — no LLM)
// ─────────────────────────────────────────────────────────────────────────────

// Descriptive, never technical. "المعتاد" is RESERVED for the habit (the `normal`
// value) so no word does two jobs — the reference line is just "متوسطه خلال…".
const METRIC_AR = {
  sma50:  'متوسطه خلال آخر شهرين',
  sma200: 'متوسطه خلال آخر سنة',
  ret3m:  null                      // movement, not position — handled separately
};

function zoneOf(self, cross, regime) {
  if (regime)          return { key: 'very_high' };
  if (self == null)    return cross != null && (cross >= 90 || cross <= 10)
                              ? { key: 'cross_only' } : { key: 'normal' };
  if (self >= 95)      return { key: 'very_high' };
  if (self >= 85)      return { key: 'high' };
  if (self <= 5)       return { key: 'very_low' };
  if (self <= 15)      return { key: 'low' };
  return { key: 'normal' };
}

function buildText(m, self, cross, zone, regime, d, sym, nRank) {
  const isRet   = (m.key === 'ret3m');
  const metric  = METRIC_AR[m.key];
  const up      = (m.value ?? 0) >= 0;          // today: above the line / gained
  const normal  = m.normal;
  const nUp     = normal != null && normal >= 0; // habit: usually above / usually gains
  const absV    = fmt(Math.abs(m.value));
  const absN    = normal == null ? null : fmt(Math.abs(normal));
  const totalD  = d.span?.[m.key]?.days ?? null;
  const isLow   = (zone.key === 'very_low' || zone.key === 'low');
  const rarer   = (self != null && totalD)
    ? Math.round((isLow ? self / 100 : (100 - self) / 100) * totalD) : null;
  const rareSay = (rarer != null && totalD && (rarer / totalD) <= 0.30);

  // ── الحالة — plain finding. No term to learn, no comparative-on-comparative.
  let state;
  if (regime)
    state = 'السعر ضمن معتاده — لكن معتاده نفسه بعيد';
  else if (zone.key === 'very_high' || zone.key === 'high')
    state = isRet ? 'صعوده خلال ٣ أشهر خارج إيقاعه المعتاد' : 'السعر خارج نطاقه المعتاد';
  else if (isLow)
    state = isRet ? 'حركته خلال ٣ أشهر خارج إيقاعه المعتاد' : 'السعر تحت نطاقه المعتاد';
  else if (zone.key === 'cross_only')
    state = 'وضعه طبيعي له — لكنه لافت مقارنة ببقية أسهمك';
  else
    state = 'السعر ضمن نطاقه المعتاد';

  // ── الأرقام — HABIT first, TODAY second, rarity last. Same order every time.
  //    Position uses فوق/تحت. Movement uses يرتفع/نزل. Never mixed.
  let numbers;
  if (isRet) {
    numbers = normal != null
      ? `السعر عادةً ${nUp ? 'يرتفع' : 'ينزل'} ${absN}% كل ٣ أشهر — هالمرة ${up ? 'ارتفع' : 'نزل'} ${absV}%.`
      : `${sym} ${up ? 'ارتفع' : 'نزل'} ${absV}% خلال آخر ٣ أشهر.`;
  } else if (normal != null) {
    numbers = `السعر عادةً ${nUp ? 'فوق' : 'تحت'} ${metric}`
      + (nUp || Math.abs(normal) >= 0.5 ? ` بـ ${absN}%` : '')
      + ` — اليوم ${up ? 'فوقه' : 'تحته'} بـ ${absV}%.`;
    // the "×" line only when the habit and today point the SAME way (else it is nonsense)
    if (nUp === up && normal !== 0) {
      const ratio = Math.abs(m.value / normal);
      if (ratio >= 1.8) numbers += ` يعني حوالي ${ratio.toFixed(1)} أضعاف المعتاد له.`;
    }
  } else {
    numbers = `السعر اليوم ${up ? 'فوق' : 'تحت'} ${metric} بـ ${absV}%.`;
  }

  if (rarer != null && totalD)
    numbers += rareSay
      ? ` وهذا صار في ${rarer} يوم فقط من آخر ${totalD}.`
      : ` وهذا صار في ${rarer} يوم من آخر ${totalD}.`;
  if (cross != null)
    numbers += ` ومقارنة ببقية أسهمك اليوم، ${sym} أعلى من ${Math.round(cross)}% منها على نفس المقياس.`;

  // ── هذا يعني — two-sided, never leaning. Both readings named.
  let meaning;
  if (regime)
    meaning = 'هذا يعني إن موقع السعر اليوم طبيعي بالنسبة لهذا السهم، لكن ما يعتبره السهم "طبيعي" بعيد عن بقية ما تملك. الطبيعي هنا محسوب على فترة كانت نفسها غير عادية.';
  else if (zone.key === 'very_high' || zone.key === 'high')
    meaning = 'هذا يعني إن السعر خرج من نطاقه المعتاد للأعلى. يصير في المراحل القوية، ويصير كمان قبل فترات التهدئة — الرقم وحده ما يفرّق بينهما.';
  else if (isLow)
    meaning = 'هذا يعني إن السعر خرج من نطاقه المعتاد للأسفل. يصير عند التصحيحات المؤقتة، ويصير كمان عند بداية تدهور حقيقي — الرقم وحده ما يفرّق بينهما.';
  else if (zone.key === 'cross_only')
    meaning = 'هذا يعني إن وضعه اليوم قريب من طبيعته، لكن طبيعته نفسها بعيدة عن بقية ما تملك.';
  else
    meaning = 'هذا يعني إنه ما في شي غير معتاد في موقع السعر اليوم.';

  // ── هذا لا يعني — name the wrong conclusion and block it. The protective line.
  let notMeaning;
  if (regime)
    notMeaning = 'هذا لا يعني إن السهم في خطر ولا إنه مبالغ فيه. يعني إن مقارنته بتاريخه القريب وحدها ما تكفي — تاريخه القريب نفسه استثنائي.';
  else if (zone.key === 'very_high' || zone.key === 'high')
    notMeaning = (normal != null && !nUp)
      ? 'هذا لا يعني إن الاتجاه تغيّر. خروج السعر فوق متوسطه شي وصفي — ما يثبت إن النزول انتهى.'
      : 'هذا لا يعني إن السهم راح ينزل. ممكن يظل عند هذا المستوى شهور وهو يواصل صعود.';
  else if (isLow)
    notMeaning = 'هذا لا يعني إن السهم رخيص ولا إنه راح يرتد. ممكن ينزل أكثر — كل سهم انهار مرّ بهذي المرحلة في طريقه.';
  else
    notMeaning = 'هذا لا يعني إن السهم جيد أو سيء — هذا مقياس موقع سعر فقط، ما يقيس الشركة.';

  // ── regime — the NVDA problem, stated plainly
  let regimeNote = null;
  if (regime)
    regimeNote = `انتبه: وضع ${sym} اليوم قريب من معتاده، بس معتاده نفسه استثنائي — السعر عادةً ${nUp ? 'فوق' : 'تحت'} ${metric} بـ ${absN}%، وهذا أعلى من معتاد ${Math.round(nRank)}% من بقية أسهمك. آخر ٣ سنوات كانت فترة غير عادية لهذا السهم، فـ"المعتاد" محسوب على فترة ما كانت معتادة.`;
  else if (d.insufficient)
    regimeNote = `تاريخ ${sym} أقصر من ٣ سنوات (${d.n || 0} يوم)، فالمقارنة مع تاريخه غير متاحة — المعروض مقارنة ببقية أسهمك فقط.`;

  return {
    state_ar: state,
    numbers_ar: numbers,
    meaning_ar: meaning,
    not_meaning_ar: notMeaning,
    regime_ar: regimeNote,
    one_line_ar: oneLine(zone, m, normal, sym, regime, nRank, metric, rarer, totalD),
    method_ar: 'يُحتسب بمقارنة موقع السعر اليوم بكل يوم من آخر ٣ سنوات لنفس السهم'
      + (cross != null ? '، وبمقارنته ببقية أسهمك اليوم' : '')
      + (nRank != null ? '، وبمقارنة معتاده بمعتاد بقية أسهمك' : '')
      + '. لا يعتمد على حدود ثابتة.',
    caveat_ar: 'قياس ندرة، مو توقّع. ندرة الوضع ما تعني تغيّر الاتجاه — تحليل معلوماتي، ليست نصيحة مالية.'
  };
}

function oneLine(zone, m, normal, sym, regime, nRank, metric, rarer, totalD) {
  const up   = (m.value ?? 0) >= 0;
  const nUp  = normal != null && normal >= 0;
  const absV = fmt(Math.abs(m.value));
  const absN = normal == null ? null : fmt(Math.abs(normal));
  const isRet = (m.key === 'ret3m');

  if (regime)
    return `السعر اليوم قريب من معتاده — لكن معتاده نفسه أعلى من ${Math.round(nRank)}% من أسهمك`;

  if (zone.key === 'cross_only') return 'وضعه طبيعي له — لكنه لافت مقارنة ببقية أسهمك';
  if (zone.key === 'normal')     return '';

  if (isRet && normal != null)
    return `السعر عادةً ${nUp ? 'يرتفع' : 'ينزل'} ${absN}% كل ٣ أشهر — هالمرة ${up ? 'ارتفع' : 'نزل'} ${absV}%`;

  if (normal == null)
    return `السعر ${up ? 'فوق' : 'تحت'} ${metric} بـ ${absV}%`;

  // The sharpest case: habit and today point OPPOSITE ways — the reversal explains itself.
  if (nUp !== up)
    return `السعر عادةً ${nUp ? 'فوق' : 'تحت'} ${metric} — اليوم ${up ? 'فوقه' : 'تحته'} بـ ${absV}%`;

  let line = `السعر عادةً ${nUp ? 'فوق' : 'تحت'} ${metric} بـ ${absN}% — اليوم بـ ${absV}%`;
  const ratio = normal !== 0 ? Math.abs(m.value / normal) : null;
  if (ratio && ratio >= 1.8) line += `، حوالي ${ratio.toFixed(1)} أضعاف`;
  return line;
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
const num      = v => (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v);
const round2   = v => v == null ? null : Math.round(v * 100) / 100;
const fmt      = v => v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1);
const dist50   = p => p == null ? -1 : Math.abs(p - 50);
const pctAbove = (p, ma) => (num(p) && num(ma)) ? ((p - ma) / ma) * 100 : null;
const mean     = arr => arr.length ? arr.reduce((a,b) => a + b, 0) / arr.length : null;
const daysRarer= (self, total) => (total == null) ? null : Math.round(((100 - self) / 100) * total);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Position of v as 0-100. Pass breakpoints (21 pts) OR a full sorted array. */
function interpPct(breakpoints, v, sortedArr) {
  if (sortedArr) {
    let n = 0;
    for (const x of sortedArr) { if (x < v) n++; else break; }
    return Math.round((n / sortedArr.length) * 100);
  }
  if (!breakpoints || !breakpoints.length) return null;
  if (v <= breakpoints[0]) return PCTS[0];
  if (v >= breakpoints[breakpoints.length - 1]) return PCTS[PCTS.length - 1];
  for (let i = 1; i < breakpoints.length; i++) {
    if (v <= breakpoints[i]) {
      const lo = breakpoints[i-1], hi = breakpoints[i];
      const f  = hi === lo ? 0 : (v - lo) / (hi - lo);
      return Math.round(PCTS[i-1] + f * (PCTS[i] - PCTS[i-1]));
    }
  }
  return 99;
}

/**
 * Rank ONE symbol's own "normal" value against every other symbol's normal.
 * Answers: "is this stock's typical state itself extreme?" — the regime question.
 * allDists = the whole distributions.json object.
 */
function normalRank(sym, allDists) {
  if (!allDists || !allDists[sym]) return null;
  const mine = allDists[sym].normal || {};
  const out = {};
  for (const k of ['sma50','sma200','ret3m']) {
    if (mine[k] == null) { out[k] = null; continue; }
    const peers = [];
    for (const s in allDists) {
      if (s[0] === '_' || s === sym) continue;
      const v = allDists[s] && allDists[s].normal && allDists[s].normal[k];
      if (v != null) peers.push(v);
    }
    if (peers.length < 5) { out[k] = null; continue; }
    peers.sort((a,b) => a - b);
    let n = 0; for (const v of peers) { if (v < mine[k]) n++; else break; }
    out[k] = Math.round((n / peers.length) * 100);
  }
  return out;
}

module.exports = { buildBreakpoints, percentileRead, crossSectional, normalRank, WINDOW_DAYS, MIN_DAYS };
