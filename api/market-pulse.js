/* ============================================================================
   THEISI — /api/market-pulse  (SERVERLESS HANDLER)
   ----------------------------------------------------------------------------
   Replaces the old client-snippet that was wrongly sitting in /api/ (it ran
   `window.…` at import → "window is not defined" → 500 on every call).
   The client code already lives inline in index.html; this file is ONLY the
   endpoint now.

   GOLDEN SEPARATION:
     • Code computes market[] (indices) and movers[] (dayPct) — deterministic.
     • Claude writes ONLY the Arabic narrative: what / why[].text / so_what /
       watch[]. It never sees prices to invent and never links news to a stock.

   POST body: { mode:'pulse', nickname, forceRefresh }
   Returns  : { market[], movers[], why[], what, so_what, watch[], session,
                footer, disclaimer, generated_at, cached }
   ============================================================================ */

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const FMP_KEY = process.env.FMP_API_KEY || process.env.FMP_KEY || '';
const FMP     = 'https://financialmodelingprep.com/stable';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CACHE_TTL_MS = 10 * 60 * 1000;      // serve cached within 10 min unless forceRefresh
const MOVERS_N     = 6;                    // top movers by |dayPct|
const INDEXES      = ['SPY', 'QQQ', 'DIA'];

// module-scope cache — persists across warm invocations (stops the DOM-poll
// from re-billing Claude on every card mount). Cold starts recompute.
let CACHE = {};

// ─── helpers ─────────────────────────────────────────────────────────────────
async function fmpGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  try {
    const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function ghRead(path) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function pctOf(q) {
  const x = Array.isArray(q) ? q[0] : q;
  if (!x) return null;
  const v = x.changePercentage ?? x.changesPercentage ?? null;
  return v == null ? null : Math.round(v * 100) / 100;
}

// US market session by UTC clock (RTH 13:30–20:00 UTC, Mon–Fri; DST-agnostic
// enough for a session label — numbers themselves come from FMP).
function usSession() {
  const now = new Date();
  const day = now.getUTCDay();                       // 0 Sun … 6 Sat
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = day >= 1 && day <= 5 && mins >= 810 && mins < 1200;
  return open ? 'intraday' : 'closed';
}

function dubaiTime() {
  try {
    return new Intl.DateTimeFormat('ar', {
      timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit',
      day: '2-digit', month: '2-digit'
    }).format(new Date());
  } catch {
    return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }
}

// small concurrency limiter so 56 holdings don't fire 56 FMP calls at once
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

function displayName(pf, nickname) {
  return (pf && (pf.nameAr || pf.name || pf.owner)) ||
         (nickname === 'rashed' ? 'راشد' : nickname);
}

// ─── narrative (Claude writes text ONLY, from computed fields) ────────────────
async function callClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error('Claude API error: ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return d.content?.[0]?.text || '';
}

function parseJson(txt) {
  let s = String(txt).replace(/```json|```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

function narrativePrompt(market, movers, session) {
  const sessTxt = session === 'intraday' ? 'خلال الجلسة (الأرقام غير نهائية)' : 'بعد الإغلاق';
  return `أنت محلل مالي تكتب "نبض السوق" بالعربية الخليجية المهنية لمستثمر.
الحالة: ${sessTxt}.

المؤشرات (٪ اليوم) — أرقام حقيقية محسوبة، لا تخترع غيرها:
${JSON.stringify(market)}

أكبر تحركات محفظته اليوم (٪ اليوم) — أرقام حقيقية، لا تخترع غيرها:
${JSON.stringify(movers)}

اكتب JSON فقط بهذا الشكل بالضبط، دون أي نص خارج الأقواس:
{
  "what": "جملة أو جملتان: ماذا يحدث في السوق اليوم بناءً على المؤشرات أعلاه فقط.",
  "why": [ { "sym": "الرمز", "text": "سبب محتمل عام لحركة هذا السهم — بصياغة حذرة (قد/يبدو)، دون اختراع خبر أو رقم أو ربط بخبر غير مذكور." } ],
  "so_what": "جملة: ماذا يعني هذا لمستثمر طويل الأمد — تفسير لا توصية.",
  "watch": [ "نقطة متابعة قصيرة", "نقطة أخرى" ]
}

قواعد صارمة:
- استخدم فقط الرموز والأرقام المعطاة أعلاه. لا تضف أرقاماً أو نسباً أو أهدافاً.
- لا تخترع أخباراً ولا تربط سهماً بحدث غير مذكور. لا تصف الشركات.
- في why: أدرج فقط الرموز الموجودة في قائمة التحركات أعلاه.
- لا نصيحة استثمارية — تفسير فقط. اكتب JSON صحيحاً فقط.`;
}

// ─── handler ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const nickname = (body.nickname || 'rashed').toLowerCase();
  const force = !!body.forceRefresh;

  // cache
  const hit = CACHE[nickname];
  if (!force && hit && (Date.now() - hit.at) < CACHE_TTL_MS) {
    return res.status(200).json({ ...hit.data, cached: true });
  }

  const disclaimer = 'تحليل معلوماتي — ليست نصيحة مالية';

  try {
    if (!FMP_KEY) return res.status(500).json({ error: 'FMP_API_KEY missing' });

    // 1) portfolio holdings
    const pf = await ghRead(nickname === 'rashed' ? 'data/portfolio.json' : `data/portfolio-${nickname}.json`);
    const holdings = ((pf && (pf.holdings || pf.stocks)) || [])
      .filter(h => h && h.sym && (h.shares == null || h.shares > 0))
      .map(h => String(h.sym).toUpperCase());

    // 2) market indices (batch)
    const idxRaw = await fmpGet(`/quote?symbol=${INDEXES.join(',')}`);
    const idxArr = Array.isArray(idxRaw) ? idxRaw : (idxRaw ? [idxRaw] : []);
    const market = INDEXES.map(sym => {
      const q = idxArr.find(x => String(x.symbol).toUpperCase() === sym);
      return { sym, dayPct: pctOf(q) };
    });

    // 3) holdings quotes → top movers by |dayPct|
    const quotes = await mapLimit(holdings, 8, async sym => {
      const q = await fmpGet(`/quote?symbol=${sym}`);
      return { sym, dayPct: pctOf(q) };
    });
    const movers = quotes
      .filter(m => m.dayPct != null)
      .sort((a, b) => Math.abs(b.dayPct) - Math.abs(a.dayPct))
      .slice(0, MOVERS_N);

    const session = usSession();

    // 4) narrative (text only) — falls back gracefully if Claude/key fails
    let narr = { what: '', why: [], so_what: '', watch: [] };
    if (ANTHROPIC_API_KEY && movers.length) {
      try {
        const parsed = parseJson(await callClaude(narrativePrompt(market, movers, session)));
        const valid = new Set(movers.map(m => m.sym));
        narr = {
          what: String(parsed.what || ''),
          so_what: String(parsed.so_what || ''),
          watch: Array.isArray(parsed.watch) ? parsed.watch.map(String).slice(0, 4) : [],
          why: Array.isArray(parsed.why)
            ? parsed.why.filter(w => w && valid.has(String(w.sym).toUpperCase()))
                        .map(w => ({ sym: String(w.sym).toUpperCase(), text: String(w.text || '') }))
            : []
        };
      } catch (e) { narr.what = 'تعذّر توليد التحليل النصي مؤقتاً — الأرقام أعلاه محدّثة.'; }
    }

    const data = {
      market, movers,
      why: narr.why, what: narr.what, so_what: narr.so_what, watch: narr.watch,
      session,
      footer: `القرار في النهاية عندك يا ${displayName(pf, nickname)}`,
      disclaimer,
      generated_at: dubaiTime(),
      cached: false
    };

    CACHE[nickname] = { at: Date.now(), data };
    return res.status(200).json(data);

  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e).slice(0, 200) });
  }
};
