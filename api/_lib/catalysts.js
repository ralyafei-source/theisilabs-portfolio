// ============================================================================
// api/_lib/catalysts.js — THEISI shared catalyst + news engine
// v1.0 · 2026-06-24 · Session 35
// ----------------------------------------------------------------------------
// Single source of truth for: recent-catalyst building (earnings beat/miss +
// analyst upgrade/downgrade, 14-day window) and Benzinga news filtering.
// Imported by api/sa-analyze.js (deep-read enrichment) and api/portfolio-for-ai.js.
//
// Lives in _lib/ (leading underscore) so Vercel does NOT route it as a function.
// ============================================================================

const FMP_KEY      = process.env.FMP_API_KEY || process.env.FMP_KEY || '';
const FMP          = 'https://financialmodelingprep.com/stable';
const BENZINGA_KEY = process.env.BENZINGA_API_KEY || '';

const CATALYST_CHANNELS = new Set([
  'Analyst Ratings','Downgrades','Upgrades','Earnings','Price Target','Guidance'
]);

// ── date helpers (UAE = UTC+4) ──────────────────────────────────────────────
function todayUAE()      { return new Date(Date.now() + 4*3600*1000).toISOString().slice(0,10); }
function daysAgoUAE(n)   { return new Date(Date.now() + 4*3600*1000 - n*86400000).toISOString().slice(0,10); }

// ── FMP fetch (lean, timeout-guarded) ───────────────────────────────────────
async function fmpGet(path) {
  if (!FMP_KEY) return null;
  try {
    const sep = path.includes('?') ? '&' : '?';
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`, { signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? d : (d?.Error ? null : d);
  } catch { return null; }
}

// ── Build catalysts from past earnings + grade actions ──────────────────────
// trackedSet = symbols allowed (holdings ∪ watchlist); ownedSet = holdings (for tag)
function buildCatalysts(pastEarnings, grades, trackedSet, ownedSet, opts = {}) {
  const WINDOW_DAYS = 14;
  const EPS_PCT_MIN = 5;
  const EPS_ABS_MIN = 0.02;
  const EPS_PCT_MAX = 300;
  const trackedOnly = opts.trackedOnly !== false;
  const cutoff = daysAgoUAE(WINDOW_DAYS);
  const today  = todayUAE();
  const out = {};

  const ageDays = (dateStr) => {
    if (!dateStr) return null;
    const d = String(dateStr).slice(0, 10);
    const ms = new Date(today) - new Date(d);
    return ms >= 0 ? Math.round(ms / 86400000) : null;
  };
  const push = (sym, item) => { if (!out[sym]) out[sym] = []; out[sym].push(item); };

  (pastEarnings || []).forEach(e => {
    const sym = e.symbol;
    if (!sym) return;
    if (trackedOnly && !trackedSet.has(sym)) return;
    if (sym.includes('.')) return;
    const date = String(e.date || '').slice(0, 10);
    if (!date || date < cutoff || date > today) return;
    const actual   = e.epsActual   ?? e.eps        ?? e.actualEarningResult ?? null;
    const estimate = e.epsEstimated ?? e.epsEstimate ?? e.estimatedEarning   ?? null;
    if (actual == null || estimate == null) return;
    const a = Number(actual), est = Number(estimate);
    if (!isFinite(a) || !isFinite(est) || est === 0) return;
    const gap = a - est;
    const pct = Math.abs(gap / Math.abs(est)) * 100;
    if (pct <= EPS_PCT_MIN || Math.abs(gap) < EPS_ABS_MIN) return;
    if (pct > EPS_PCT_MAX) return;
    const beat = gap > 0;
    push(sym, {
      type: beat ? 'earnings_beat' : 'earnings_miss',
      label_ar: beat ? 'تجاوز الأرباح' : 'تقصير في الأرباح',
      date, age_days: ageDays(date),
      color: beat ? 'green' : 'red',
      detail: `${beat ? '+' : '-'}${pct.toFixed(0)}%`,
      owned: ownedSet.has(sym),
    });
  });

  (grades || []).forEach(g => {
    const sym = g.symbol;
    if (!sym) return;
    if (trackedOnly && !trackedSet.has(sym)) return;
    const date = String(g.date || g.gradingDate || '').slice(0, 10);
    if (!date || date < cutoff || date > today) return;
    const action = String(g.action || '').toLowerCase();
    if (action !== 'upgrade' && action !== 'downgrade') return;
    const up = action === 'upgrade';
    push(sym, {
      type: up ? 'upgrade' : 'downgrade',
      label_ar: up ? 'رفع التصنيف' : 'خفض التصنيف',
      date, age_days: ageDays(date),
      color: up ? 'green' : 'red',
      detail: `${g.gradingCompany || ''}: ${g.previousGrade || ''} → ${g.newGrade || ''}`.trim(),
      owned: ownedSet.has(sym),
    });
  });

  Object.values(out).forEach(list => list.sort((x, y) => (y.date < x.date ? -1 : 1)));
  return out;
}

// ── Benzinga news: catalyst-relevant, low-noise, scoped to one ticker ───────
function filterNews(items, sym, maxStocks = 4) {
  return (items || []).filter(n => {
    const stocks = (n.stocks || []).map(s => s.name || s);
    if (!stocks.includes(sym)) return false;
    if (stocks.length > maxStocks) return false;
    const ch  = (n.channels || []).map(c => c.name || c);
    const imp = Number(n.importance_rank || 0);
    return ch.some(c => CATALYST_CHANNELS.has(c)) || imp >= 2;
  }).slice(0, 3).map(n => ({ title: n.title, date: String(n.created || '').slice(0, 16) }));
}

async function benzingaNews(sym, fromDate) {
  if (!BENZINGA_KEY) return [];
  try {
    const url = `https://api.benzinga.com/api/v2/news?token=${BENZINGA_KEY}&tickers=${sym}`
              + `&pageSize=15&displayOutput=abstract&dateFrom=${fromDate}&format=json`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) return [];
    const data = await r.json();
    const items = Array.isArray(data) ? data : (data?.result || data?.item || []);
    return filterNews(items, sym);
  } catch { return []; }
}

// ── Convenience: fetch catalysts + news for ONE symbol (used by deep-read) ──
// Returns { catalysts:[...], news:[title,...] } ready to pass as deep-read extras.
async function fetchExtrasForSymbol(sym, trackedSet, ownedSet) {
  const [pastEarnings, gradesArr, news] = await Promise.all([
    fmpGet(`/earnings-calendar?from=${daysAgoUAE(14)}&to=${todayUAE()}&symbol=${sym}`),
    fmpGet(`/grades?symbol=${sym}&limit=3`),
    benzingaNews(sym, daysAgoUAE(14))
  ]);
  const grades = Array.isArray(gradesArr) ? gradesArr : (gradesArr ? [gradesArr] : []);
  const cats = buildCatalysts(pastEarnings, grades, trackedSet, ownedSet);
  return { catalysts: cats[sym] || [], news: (news || []).map(n => n.title) };
}

module.exports = {
  todayUAE, daysAgoUAE, fmpGet,
  buildCatalysts, filterNews, benzingaNews, fetchExtrasForSymbol
};

// ── FMP NEWS (Session 35 — replaces Benzinga; Starter plan includes news) ────
// Returns raw items scoped to the given symbols, newest first.
async function fmpNews(symbols, limit = 50) {
  if (!FMP_KEY) return [{sym:'DBG',title:'NO_FMP_KEY',text:'',date:'',site:'',url:''}];
  if (!symbols || !symbols.length) return [{sym:'DBG',title:'NO_SYMBOLS',text:'',date:'',site:'',url:''}];
  try {
    const syms = symbols.slice(0, 50).join(',');
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(`${FMP}/news/stock?symbols=${syms}&limit=${limit}&apikey=${FMP_KEY}`, { signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) return [{sym:'DBG',title:'FMP_HTTP_'+r.status,text:'',date:'',site:'',url:''}];
    const d = await r.json();
    if (!Array.isArray(d)) return [{sym:'DBG',title:'NOT_ARRAY_'+JSON.stringify(d).slice(0,100),text:'',date:'',site:'',url:''}];
    return d.map(n => ({
      sym: n.symbol, title: n.title, text: n.text || '',
      date: String(n.publishedDate || '').slice(0, 16),
      site: n.site || n.publisher || '', url: n.url || ''
    }));
  } catch { return [{sym:'DBG',title:'CATCH_ERROR',text:'',date:'',site:'',url:''}]; }
}

module.exports.fmpNews = fmpNews;
