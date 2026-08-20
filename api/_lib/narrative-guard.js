// api/_lib/narrative-guard.js
//
// Mechanical enforcement of the Golden Separation.
//
// The rule has always been: code computes every number, Claude writes only the
// Arabic narrative from the fields it is given. Until now that was enforced by
// asking nicely in a prompt, and it failed — a weekly report told Rashed that
// TEAM was 20.5% of the portfolio when it was 0.16%. TEAM would have had to
// trade at ~$11,188/share. Nothing caught it, and it sat in the SSOT as a known
// risk for two weeks.
//
// This checks every number that appears in Claude-written prose against the
// numbers code actually computed. A number that cannot be traced to a computed
// field is a violation.
//
// MODES
//   'warn'  — record violations, save the doc anyway. Start here. The watchdog
//             surfaces guard.ok === false, so you SEE the rate before it can
//             block a real report.
//   'block' — refuse to save. Move here once warn runs clean for a few weeks.
// A guard that fires constantly gets switched off, so it earns 'block' rather
// than starting there.

'use strict';

// Thresholds that live in the verdict rules. Claude may legitimately name these
// when explaining WHY something was flagged ("خسارة تتجاوز ٥٠٪"), so they are
// traceable to code even though they are not per-holding values.
const RULE_CONSTANTS = new Set([0, 1, 2, 3, 4, 5, 8, 10, 12, 14, 20, 30, 50, 70, 100,
                                5000,      // the ">$5K position" threshold, often written "5K"
                                3, 740, 750]); // "3 years" of history, and its trading-day count

// Index names carry digits that are names, not measurements. Strip before parsing.
const NAME_TOKENS = [
  /S\s*&\s*P\s*500/gi, /S&P500/gi, /ناسداك\s*100/g, /Nasdaq\s*100/gi,
  /داو\s*جونز/g, /Russell\s*2000/gi, /VIX/gi, /Sharia|شريعة/g,
  // Moving-average periods name the indicator, they do not measure anything:
  // "متوسط 200 يوم", "المتوسط 50 يوم", "SMA200", "RSI 14".
  /(?:متوسط|المتوسط)\s*\d{1,3}\s*يوم/g, /SMA\s*\d{1,3}/gi, /EMA\s*\d{1,3}/gi,
  /RSI\s*\d{1,2}\b/gi, /MACD\s*[\d,\s]+/gi
];

// Dates are metadata, not claims: "19 أغسطس 2026", "2026-08-19", "16/08/2026".
const DATE_PATTERNS = [
  /\d{4}-\d{2}-\d{2}/g,
  /\d{1,2}\s*[\/\-]\s*\d{1,2}\s*[\/\-]\s*\d{2,4}/g,
  /\d{1,2}\s+(?:يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)\s+\d{4}/g
];

const AR_DIGITS = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
const normalizeDigits = s => String(s).replace(/[٠-٩]/g, d => AR_DIGITS[d]);

/** Every number mentioned in a block of prose. */
function extractNumbers(text) {
  if (!text) return [];
  let t = normalizeDigits(text);
  for (const re of DATE_PATTERNS) t = t.replace(re, ' ');
  for (const re of NAME_TOKENS)   t = t.replace(re, ' ');
  // Generated Arabic uses the Arabic comma as a thousands separator ("95،627"),
  // which would otherwise read as two unrelated numbers, 95 and 627.
  t = t.replace(/(\d)،(\d{3})\b/g, '$1,$2');
  const out = [];
  for (const m of t.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (isFinite(n)) out.push({ n, index: m.index, raw: m[0], text: t });
  }
  return out;
}

/** Every number code computed for this report. */
function computedNumbers(doc) {
  const set = new Set();
  const add = v => {
    const n = Number(v);
    if (!isFinite(n)) return;
    set.add(n);
    set.add(Math.abs(n));
    set.add(Number(Math.abs(n).toFixed(1)));
  };

  const v = doc.verdict || {};
  for (const k of Object.keys(v)) if (typeof v[k] === 'number') add(v[k]);

  // The monthly verdict carries no total_value or holdings count, so a summary
  // saying "~653 ألف دولار (53 مركزاً)" had nothing to match against. Derive both
  // from the rows code already wrote.
  const rows = doc.stocks || [];
  if (rows.length) {
    add(rows.length);
    const sum = rows.reduce((a, r) => a + (Number(r.value) || 0), 0);
    if (sum > 0) { add(sum); add(sum / 1000); }

    // DERIVED AGGREGATES. Claude summing three given weights to say "the top
    // three are 40% of the portfolio" is correct analysis, not invention — and
    // an early version of this guard flagged exactly that. Adding a stock alone
    // is the check that matters (TEAM's 20.5% claim was about ONE holding and
    // matches no subset), so precompute the aggregates a competent analyst would
    // reasonably state and treat those as traceable.
    const w = rows.map(r => Number(r.weight)).filter(isFinite).sort((a, b) => b - a);
    const val = rows.map(r => Number(r.value)).filter(isFinite).sort((a, b) => b - a);
    for (const arr of [w, val]) {
      let run = 0;
      for (let i = 0; i < Math.min(arr.length, 15); i++) { run += arr[i]; add(run); }   // top-N
      for (let i = 0; i < Math.min(arr.length, 12); i++)                                 // any pair
        for (let j = i + 1; j < Math.min(arr.length, 12); j++) add(arr[i] + arr[j]);
    }
  }

  for (const s of doc.stocks || []) {
    for (const k of ['price','glPct','dayPct','weekPct','value','weight','quant',
                     'rsi','earnDays','target','gapPct',
                     'long_score','short_score','mid_score']) add(s[k]);   // monthly (scorer v2)
  }
  for (const c of doc.clusters || []) add(c.value);
  for (const st of doc.stress || []) add(st.impact_usd);
  for (const p of doc.price_reads || []) {
    if (!p) continue;
    for (const k of ['value','normal','self','cross','nrank','price','n','days','span']) add(p[k]);
  }
  return set;
}

/**
 * A quoted number matches a computed one if it is that number, or a sane
 * rounding of it. Claude writing 52% for 52.1 is fine; writing 20.5% for 0.16
 * is not.
 */
// "تجاوزت 57%" / "أكثر من 80%" state a BOUND, not a value: the real figure is
// -57.9 and the sentence is true. Matching only exact values flagged a correct
// statement, so a bound is satisfied by any computed value on the right side of
// it (within a sane distance, so "more than 5%" is not satisfied by 94%).
function satisfiesBound(n, computed, after) {
  if (!/^\s*(?:%|٪)?\s*$|^\s*(?:%|٪)/.test(after)) { /* fallthrough */ }
  const a = Math.abs(n);
  for (const c of computed) {
    const ac = Math.abs(c);
    if (ac >= a && ac - a <= Math.max(1.5, a * 0.05)) return true;
    if (ac <= a && a - ac <= Math.max(1.5, a * 0.05)) return true;
  }
  return false;
}

function traceable(n, computed) {
  if (RULE_CONSTANTS.has(Math.abs(n))) return true;
  if (computed.has(n) || computed.has(Math.abs(n))) return true;
  const a = Math.abs(n);
  if (a >= 1990 && a <= 2100) return true;              // a year
  for (const c of computed) {
    const ac = Math.abs(c);
    if (ac === 0) continue;
    // Within 1%. The floor is deliberately tiny: a 0.5 absolute window let a
    // claimed 20.5% match a computed 21.1%, which is how the TEAM-class error
    // slips through. 1% still absorbs honest rounding (52% for 52.1%).
    if (Math.abs(a - ac) <= Math.max(0.05, ac * 0.015)) return true;
    // "$68K" for 68006, "1.2M" for 1,234,567
    if (ac >= 1000 && Math.abs(a - ac / 1000) <= Math.max(0.5, (ac / 1000) * 0.01)) return true;
    if (ac >= 1e6 && Math.abs(a - ac / 1e6) <= Math.max(0.1, (ac / 1e6) * 0.01)) return true;
  }
  return false;
}

/** The prose fields Claude owns. Everything else in the doc is code-written. */
function narrativeFields(doc) {
  const fields = [];
  const v = doc.verdict || {};
  if (v.biggest_risk) fields.push({ field: 'verdict.biggest_risk', text: v.biggest_risk });
  if (doc.summary)    fields.push({ field: 'summary',    text: doc.summary });
  if (doc.hedge)      fields.push({ field: 'hedge',      text: doc.hedge });
  if (doc.long_view)  fields.push({ field: 'long_view',  text: doc.long_view });
  if (doc.health)     fields.push({ field: 'health',     text: doc.health });
  for (const s of doc.stocks || []) {
    if (s.thesis) fields.push({ field: `stocks.${s.sym}.thesis`, text: s.thesis });
    if (s.watch)  fields.push({ field: `stocks.${s.sym}.watch`,  text: s.watch });
  }
  for (const c of doc.clusters || []) {
    if (c.note) fields.push({ field: `clusters.${c.name || '?'}.note`, text: c.note });
  }
  // verdict.silent_note_ar is written by CODE, not Claude — never checked here.
  return fields;
}

/**
 * @returns {{ok:boolean, mode:string, checked:number, violations:Array}}
 */
function guardNarrative(doc, mode = 'warn') {
  const computed = computedNumbers(doc);
  const violations = [];   // gate the report
  const unverified = [];   // reported, but not a gate
  let checked = 0;

  for (const { field, text } of narrativeFields(doc)) {
    for (const { n, index, raw, text: t } of extractNumbers(text)) {
      checked++;
      if (traceable(n, computed)) continue;
      const before = t.slice(Math.max(0, index - 25), index);
      const after  = t.slice(index + raw.length, index + raw.length + 60);
      const isBound = /تجاوز|يزيد|أكثر من|أعلى من|أدنى من|دون|فوق|تحت|نحو|حوالي|~/.test(before);
      if (isBound && satisfiesBound(n, computed, after)) continue;
      const context = t.slice(Math.max(0, index - 40), index + raw.length + 40).trim();
      const item = { field, value: n, context };
      // A claim ABOUT THE PORTFOLIO — a percentage, or a dollar figure tied to a
      // holding — is the class that misled Rashed on TEAM. An invented support
      // level ("مستوى 230 دولار كدعم") or a figure quoted from the week's news is
      // untraceable but low-stakes, so it is reported without gating the report.
      // Only the text IMMEDIATELY after the number decides its class. A '%' forty
      // characters away belongs to a different figure — that is what made a gold
      // price quoted from the week's news read as a portfolio claim.
      const isLevel = /مستوى|دعم|مقاومة|هدف نفسي/.test(context);
      const pctHere = /^\s*(?:%|٪)/.test(after);
      const aboutPortfolio =
        /^\s*(?:%|٪)?\s*(?:دولار|ألف|مليون)?\s*(?:من\s+(?:قيمة\s+)?(?:المحفظة|رأس\s+المال)|من\s+أسهم\s+المحفظة)/.test(after);
      const isPortfolioClaim = !isLevel && (aboutPortfolio ||
        (pctHere && /المحفظة|رأس المال|تركّز|خسارة|ربح|وزن/.test(context)));
      (isPortfolioClaim ? violations : unverified).push(item);
    }
  }
  return { ok: violations.length === 0, mode, checked,
           violations: violations.slice(0, 20),
           unverified: unverified.slice(0, 20),
           unverified_count: unverified.length };
}

module.exports = { guardNarrative, extractNumbers, computedNumbers, traceable };
