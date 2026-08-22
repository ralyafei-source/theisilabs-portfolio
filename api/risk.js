// api/risk.js — portfolio risk read (Vercel Cron trigger + manual)
// ---------------------------------------------------------------------------
// The exposure/exit defense the analysis pipeline never had. For each user it
// computes concentration, measured correlation, effective INDEPENDENT bets,
// beta-implied drawdown scenarios, and thesis-exit flags — then commits
// data/risk-{nick}-{date}.json. The dashboard risk card renders that file.
//
// MACRO EXTENSION (Aug 2026): the same run now also produces the macro risk
// simulation — data/macro-{nick}-{date}.json — using api/_lib/macro-core.js:
//   step 1  surfaceRisks()      news themes → which risks are surfaced NOW
//   step 2  CATALOGUE/COMPOSITES  risk → factor channels (assumptions printed)
//   step 3  factorBetas()+simulate()  stress every holding
//   step 4  bands                 group by impact, sum value & dollars per band
// Structural revenue geography (layer 3) is cached per symbol in
// data/structural/{sym}.json and refreshed quarterly, a few names per run.
//
// Runs server-side: FMP works fine from Vercel. No new Vercel function — this
// stays inside the existing Sunday 03:00 cron (vercel.json).
//
// Env (all already in your project): FMP_API_KEY, GITHUB_TOKEN.
// Optional: CRON_SECRET.
// ---------------------------------------------------------------------------
'use strict';

const REPO         = 'ralyafei-source/theisilabs-portfolio';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const FMP          = process.env.FMP_API_KEY || process.env.FMP_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';
const DAYS         = 500;              // macro betas want ~2y; risk-core uses the tail it needs
const BENCH        = 'SPY';
const STRUCTURAL_REFRESH_DAYS = 90;    // segmentation is annual data
const STRUCTURAL_BUDGET_PER_RUN = 12;  // fills the whole book over a few weeks

const { holdingsFromWorkbook, buildReport } = require('./_lib/risk-core');
const {
  factorBetas, simulate, compositeSimulate, surfaceRisks,
  findShocks, replay, structuralExposure, CATALOGUE, COMPOSITES,
  makePrediction, gradePredictions, scorecard
} = require('./_lib/macro-core');

const { findSession } = require('./_lib/pin');
const uaeDate = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);

async function ghRead(path) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function ghWrite(path, data) {
  const check = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app' } });
  let sha = null;
  if (check.ok) { const ex = await check.json(); sha = ex.sha; }
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Risk read ${path}`, content, ...(sha && { sha }) })
  });
  return r.ok;
}

/** Latest SA workbook for a nick: prefer sa-portfolio-{nick}-{date}, fall back
 *  to the shared sa-portfolio-{date}. Returns { date, workbook } or null. */
async function latestWorkbook(nick) {
  for (let o = 0; o < 30; o++) {
    const d = new Date(Date.now() + 4 * 3600000 - o * 86400000).toISOString().slice(0, 10);
    const wb = (await ghRead(`data/sa-portfolio-${nick}-${d}.json`)) || (await ghRead(`data/sa-portfolio-${d}.json`));
    if (wb) return { date: d, workbook: wb };
  }
  return null;
}

/** Daily closes — FMP primary, Yahoo chart fallback. FMP blocks datacenter IPs
 *  on this plan (prices.js sees the same: "FMP(0) + Yahoo(N)"), so from Vercel
 *  the Yahoo path is what actually runs; from a local node FMP works.
 *  Returns BOTH shapes one fetch: closes array (risk-core/macro-core) and
 *  by-date map + dates (replay/grading). */
const YA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
function shapeRows(rows) {
  rows = rows.filter(x => isFinite(x.c)).sort((a, b) => a.d < b.d ? -1 : 1).slice(-DAYS);
  if (rows.length <= 20) return null;
  return { closes: rows.map(x => x.c), byDate: Object.fromEntries(rows.map(x => [x.d, x.c])), dates: rows.map(x => x.d) };
}
async function fmpClosesRaw(sym) {
  if (!FMP) return null;
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${sym}&apikey=${FMP}`,
      { headers: { 'User-Agent': 'theisi' } });
    if (!r.ok) return null;
    const j = await r.json();
    const hist = Array.isArray(j) ? j : (j.historical || []);
    return shapeRows(hist.map(h => ({ d: h.date, c: +(h.close ?? h.price) })));
  } catch { return null; }
}
async function yahooCloses(sym) {
  try {
    const to = Math.floor(Date.now() / 1000), from = to - 86400 * 800; // ~2.2y ⊇ DAYS
    const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=${from}&period2=${to}`,
      { headers: { 'User-Agent': YA_UA } });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.timestamp) return null;
    const cl = ((res.indicators || {}).quote || [{}])[0].close || [];
    return shapeRows(res.timestamp.map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), c: +cl[i] })));
  } catch { return null; }
}
async function fmpCloses(sym) {
  return (await fmpClosesRaw(sym)) || (await yahooCloses(sym));
}

// ── macro: factor proxies, fetched once per handler run ─────────────────────
const PROXY_SYMS = Array.from(new Set([
  ...CATALOGUE.filter(c => c.proxy).map(c => c.proxy),
  ...COMPOSITES.flatMap(c => [c.market.proxy, ...c.channels.map(x => x.proxy)])
]));
let _proxyCache = null;
async function proxySeries() {
  if (_proxyCache) return _proxyCache;
  const out = {};
  for (let i = 0; i < PROXY_SYMS.length; i += 6) {
    const got = await Promise.all(PROXY_SYMS.slice(i, i + 6).map(s => fmpCloses(s).then(c => [s, c])));
    got.forEach(([s, c]) => { if (c) out[s] = c; });
  }
  _proxyCache = out;
  return out;
}

// ── macro: structural revenue geography, cached quarterly per symbol ────────
async function refreshStructural(syms) {
  if (!FMP) return {};
  const exposures = {};
  let budget = STRUCTURAL_BUDGET_PER_RUN;
  const today = uaeDate();
  for (const sym of syms) {
    const cached = await ghRead(`data/structural/${sym}.json`);
    const staleDays = cached && cached.fetched
      ? (new Date(today) - new Date(cached.fetched)) / 86400000 : Infinity;
    if (cached && staleDays < STRUCTURAL_REFRESH_DAYS) { exposures[sym] = cached.exposure; continue; }
    if (budget <= 0) { if (cached) exposures[sym] = cached.exposure; continue; }
    budget--;
    try {
      const r = await fetch(`https://financialmodelingprep.com/stable/revenue-geographic-segmentation?symbol=${sym}&apikey=${FMP}`,
        { headers: { 'User-Agent': 'theisi' } });
      if (!r.ok) { if (cached) exposures[sym] = cached.exposure; continue; }
      const rows = await r.json();
      const latest = Array.isArray(rows) ? rows[0] : rows;
      const exposure = structuralExposure(latest);
      await ghWrite(`data/structural/${sym}.json`, { sym, fetched: today, exposure });
      if (exposure) exposures[sym] = exposure;
    } catch { if (cached) exposures[sym] = cached.exposure; }
  }
  return exposures;
}

// ── macro: the full pipeline for one book ───────────────────────────────────
function buildMacro(rows, holdingSeries, proxies, newsThemes, exposures, meta) {
  const holdings = rows.map(h => ({ sym: h.sym, value: h.value }));
  const closes = {};
  for (const [s, v] of Object.entries(holdingSeries)) closes[s] = v.closes;
  for (const [s, v] of Object.entries(proxies)) closes[s] = closes[s] || v.closes;
  const byDate = {};
  for (const [s, v] of Object.entries(holdingSeries)) byDate[s] = v.byDate;

  // step 1 — which risks are surfaced in the news right now
  const surfaced = surfaceRisks(newsThemes || []);
  const salience = Object.fromEntries(surfaced.map(s => [s.id, s]));

  // steps 2–4 — every catalogue risk with a proxy
  const risks = [];
  for (const c of CATALOGUE) {
    if (!c.proxy || !proxies[c.proxy]) continue;
    const betas = factorBetas(closes, holdings.map(h => h.sym), c.proxy, BENCH);
    // R2 (validation): market-wide channel gets R²-shrunk betas; factor channels raw
    const sims = c.shocks.map((s, i) => {
      const r = simulate(holdings, betas, s, { marketChannel: c.id === 'market' });
      if (i > 0) delete r.names;               // full name list once; bands after
      return r;
    });
    // layer 2 — worst factor-specific windows, replayed on THIS book
    let windows = [];
    if (c.layers.includes(2) && proxies[c.proxy]) {
      const f = proxies[c.proxy];
      const shocks = findShocks(f.dates, f.byDate, c.proxy === BENCH ? null : proxies[BENCH]?.byDate, { count: 2 });
      windows = shocks.map(w => {
        const r = replay(holdings, byDate, w);
        r.names = r.names.slice(0, 8);          // worst 8 is the story
        return r;
      });
    }
    risks.push({
      id: c.id, ar: c.ar, proxy: c.proxy, note_ar: c.note_ar || null,
      layers: c.layers, salience: salience[c.id] || null,
      sims, windows
    });
  }
  risks.sort((a, b) => (a.sims[0]?.impact_usd ?? 0) - (b.sims[0]?.impact_usd ?? 0));

  // composite (named-event) scenarios — Taiwan war, Hormuz closure
  const composites = COMPOSITES.map(sc => {
    const r = compositeSimulate(holdings, closes, sc);
    r.salience = salience[sc.riskId] || null;
    r.structural_note_ar = sc.structural?.note_ar || null;
    return r;
  }).sort((a, b) => a.impact_usd - b.impact_usd);

  // layer 3 — exposure facts only (price translation stays with the user)
  const structural = {};
  for (const h of holdings) {
    const ex = exposures[h.sym];
    if (!ex) continue;
    structural[h.sym] = {
      fiscal_year: ex.fiscal_year,
      greater_china_pct: ex.by_region.greater_china?.pct ?? 0,
      middle_east_pct: ex.by_region.middle_east?.pct ?? 0,
      us_pct: ex.by_region.united_states?.pct ?? 0,
      unclassified_pct: ex.unclassified_pct
    };
  }

  return {
    as_of: meta.asOf, sa_date: meta.saDate,
    surfaced_risks: surfaced,
    risks, composites, structural,
    caveat_ar: 'محاكاة معلوماتية مبنية على علاقات تاريخية وافتراضات معلنة — مو تنبؤ. الأسماء ضعيفة التفسير معلّمة، والقرار في النهاية عندك.'
  };
}

async function runOne(nick, proxies, newsThemes) {
  const found = await latestWorkbook(nick);
  if (!found) return { nick, ok: false, error: 'no SA workbook in 30 days' };
  const { rows } = holdingsFromWorkbook(found.workbook);
  if (!rows.length) return { nick, ok: false, error: 'no owned holdings' };

  // fetch history (concentration still works if this yields nothing)
  const series = {};
  const syms = [...rows.map(h => h.sym), BENCH];
  const CONC = 6;
  for (let i = 0; i < syms.length; i += CONC) {
    const batch = syms.slice(i, i + CONC);
    const got = await Promise.all(batch.map(s => fmpCloses(s).then(c => [s, c])));
    got.forEach(([s, c]) => { if (c) series[s] = c; });
  }
  const closes = Object.fromEntries(Object.entries(series).map(([s, v]) => [s, v.closes]));

  const report = buildReport(rows, closes, found.workbook, { asOf: uaeDate(), saDate: found.date, bench: BENCH });
  const path = `data/risk-${nick}-${report.as_of}.json`;
  const saved = await ghWrite(path, report);

  // macro simulation — same fetched data, no extra holding calls
  let macroSaved = false, macroPath = null;
  try {
    const exposures = await refreshStructural(rows.map(h => h.sym));
    const macro = buildMacro(rows, series, proxies, newsThemes, exposures,
      { asOf: report.as_of, saDate: found.date });

    // R1: prospective self-grading — grade last runs' predictions against what
    // actually happened, then freeze THIS run's prediction for the next one.
    // The model builds a live track record; survivorship-proof by construction.
    try {
      const vPath = `data/macro-validation-${nick}.json`;
      const prev = (await ghRead(vPath)) || { pending: [], graded: [] };
      const byDate = Object.fromEntries(Object.entries(series).map(([s, v]) => [s, v.byDate]));
      const proxyByDate = Object.fromEntries(Object.entries(proxies).map(([s, v]) => [s, v.byDate]));
      const benchDates = (proxies[BENCH] || series[BENCH] || {}).dates || [];
      const { graded, still_pending } = gradePredictions(prev.pending, byDate, proxyByDate, benchDates);
      const holdings = rows.map(h => ({ sym: h.sym, value: h.value }));
      const closesOnly = Object.fromEntries(Object.entries(series).map(([s, v]) => [s, v.closes]));
      for (const [s, v] of Object.entries(proxies)) closesOnly[s] = closesOnly[s] || v.closes;
      const lastBench = benchDates[benchDates.length - 1] || report.as_of;
      const factors = CATALOGUE.filter(c => c.proxy && proxies[c.proxy]).map(c => c.proxy);
      const pending = [...still_pending, makePrediction(holdings, closesOnly, factors, BENCH, lastBench)];
      const allGraded = [...(prev.graded || []), ...graded].slice(-300);
      const card = scorecard(allGraded);
      await ghWrite(vPath, { updated: report.as_of, scorecard: card, pending, graded: allGraded });
      macro.scorecard = card;   // the tab can show "دقة النموذج الحيّة"
    } catch (e) { macro.scorecard = { n: 0, error: String(e && e.message || e).slice(0, 100) }; }

    macroPath = `data/macro-${nick}-${report.as_of}.json`;
    macroSaved = await ghWrite(macroPath, macro);
  } catch (e) { macroPath = `macro failed: ${String(e && e.message || e).slice(0, 120)}`; }

  return { nick, ok: saved, path: saved ? path : null,
           macro_ok: macroSaved, macro_path: macroPath,
           effective_independent_bets: report.correlation.effective_independent_bets ?? null,
           beta: report.concentration.portfolio_beta_24m, exits: report.exits.length };
}

// A logged-in user may manually refresh their OWN read: verify their session
// token against users.json and return their nickname (or null).
async function verifySessionNick(token) {
  try {
    const usersData = await ghRead('data/users.json');
    const list = Array.isArray(usersData) ? usersData : ((usersData && usersData.users) || []);
    const user = list.find(u => findSession(u, token));
    return user ? String(user.nickname || user.nick || '').toLowerCase() : null;
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  // Auth: Vercel Cron carries the CRON_SECRET; a logged-in user may manually
  // refresh their own read with their session token.
  const bearer = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const isCron = !!CRON_SECRET && bearer === CRON_SECRET;
  let sessionNick = null;
  if (!isCron && bearer) sessionNick = await verifySessionNick(bearer);
  if (CRON_SECRET && !isCron && !sessionNick) return res.status(401).json({ error: 'Unauthorized' });
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN missing' });

  // nick selection: a manual (session) user runs only their own; cron/secret runs all (or ?nick=)
  const only = (req.query && req.query.nick) || (req.body && req.body.nick) || null;
  let nicks;
  if (sessionNick && !isCron) {
    nicks = [sessionNick];
  } else if (only) {
    nicks = [String(only).toLowerCase()];
  } else {
    const usersData = await ghRead('data/users.json');
    const list = Array.isArray(usersData) ? usersData : ((usersData && usersData.users) || []);
    nicks = Array.from(new Set(['rashed', ...list.map(u => String(u.nickname || u.nick || '').toLowerCase()).filter(Boolean)]));
  }

  // shared across all nicks in this run: factor proxies + today's news themes
  const proxies = await proxySeries();
  const news = await ghRead('data/themed-news.json');
  const newsThemes = (news && news.themes) || [];

  const results = [];
  for (const nick of nicks) {
    try { results.push(await runOne(nick, proxies, newsThemes)); }
    catch (e) { results.push({ nick, ok: false, error: String(e && e.message || e).slice(0, 160) }); }
  }
  const ok = results.filter(x => x.ok).length;
  return res.status(200).json({ ran: nicks.length, ok, failed: nicks.length - ok, results });
};

// exported for offline tests only — not used by the handler
module.exports._internals = { buildMacro, PROXY_SYMS };
