/* ============================================================================
   THEISI — /api/market-pulse  (SERVERLESS HANDLER, GitHub-cached)
   ----------------------------------------------------------------------------
   Serves the نبض السوق card. Persists each generation to
   data/market/pulse-{nick}-{UAEdate}.json so page reloads read a static file
   (fast, no Claude call) instead of recomputing every time.

   REGENERATION RULES:
     • Market OPEN   : auto-load regenerates only if cache older than 30 min.
                       ↻ refresh regenerates immediately.
     • Market CLOSED : auto-load never regenerates (serves cache).
                       ↻ refresh regenerates AT MOST ONCE PER DAY.
     • No cache yet  : generate once (so the card is never empty).
   Opening the card popup never hits this endpoint (client reads a snapshot).

   GOLDEN SEPARATION: code computes market[]/movers[]; Claude writes only the
   Arabic narrative (what/why/so_what/watch).

   Env: FMP_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN.
   ============================================================================ */

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const FMP_KEY = process.env.FMP_API_KEY || process.env.FMP_KEY || '';
const FMP     = 'https://financialmodelingprep.com/stable';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;

const STALE_MS = 30 * 60 * 1000;          // open-market auto-refresh threshold
const MOVERS_N = 6;
const INDEXES  = ['SPY', 'QQQ', 'DIA'];

// ─── date / session ──────────────────────────────────────────────────────────
function uaeDate() { return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10); }

function usSession() {
  const now = new Date();
  const day = now.getUTCDay();                              // 0 Sun … 6 Sat
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = day >= 1 && day <= 5 && mins >= 810 && mins < 1200; // 13:30–20:00 UTC
  return open ? 'intraday' : 'closed';
}

function dubaiTime() {
  try {
    return new Intl.DateTimeFormat('ar', {
      timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'
    }).format(new Date());
  } catch {
    return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }
}

// ─── GitHub read / write ─────────────────────────────────────────────────────
async function ghReadRaw(path) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// fresh read via the git contents API (avoids raw.githubusercontent CDN lag
// right after a write — used for the cache file whose _genMs must be current)
async function ghReadJsonApi(path) {
  if (!GITHUB_TOKEN) return await ghReadRaw(path);
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=main`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.content) return null;
    return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  } catch { return null; }
}

async function ghWrite(path, obj) {
  if (!GITHUB_TOKEN) return false;
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const hdr = { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app' };
  let sha = null;
  try { const c = await fetch(url, { headers: hdr }); if (c.ok) sha = (await c.json()).sha; } catch {}
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { ...hdr, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `pulse: ${path}`,
        content: Buffer.from(JSON.stringify(obj)).toString('base64'),
        ...(sha ? { sha } : {})
      })
    });
    return r.ok;
  } catch { return false; }
}

// ─── FMP ─────────────────────────────────────────────────────────────────────
async function fmpGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  try { const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`); if (!r.ok) return null; return await r.json(); }
  catch { return null; }
}
function pctOf(q) {
  const x = Array.isArray(q) ? q[0] : q;
  if (!x) return null;
  const v = x.changePercentage ?? x.changesPercentage ?? null;
  return v == null ? null : Math.round(v * 100) / 100;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}
function displayName(pf, nickname) {
  return (pf && (pf.nameAr || pf.name || pf.owner)) || (nickname === 'rashed' ? 'راشد' : nickname);
}

// ─── narrative (Claude writes text only) ─────────────────────────────────────
async function callClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error('Claude API error: ' + (await r.text()).slice(0, 200));
  return (await r.json()).content?.[0]?.text || '';
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

// ─── compute a fresh pulse ───────────────────────────────────────────────────
async function generate(nickname, session) {
  const pf = await ghReadRaw(nickname === 'rashed' ? 'data/portfolio.json' : `data/portfolio-${nickname}.json`);
  const holdings = ((pf && (pf.holdings || pf.stocks)) || [])
    .filter(h => h && h.sym && (h.shares == null || h.shares > 0))
    .map(h => String(h.sym).toUpperCase());

  // indices — per-symbol (batch symbol lists aren't supported on all FMP plans)
  const market = await mapLimit(INDEXES, 3, async sym => ({ sym, dayPct: pctOf(await fmpGet(`/quote?symbol=${sym}`)) }));

  // holdings → top movers by |dayPct|
  const quotes = await mapLimit(holdings, 8, async sym => ({ sym, dayPct: pctOf(await fmpGet(`/quote?symbol=${sym}`)) }));
  const movers = quotes.filter(m => m.dayPct != null)
    .sort((a, b) => Math.abs(b.dayPct) - Math.abs(a.dayPct)).slice(0, MOVERS_N);

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
    } catch { narr.what = 'تعذّر توليد التحليل النصي مؤقتاً — الأرقام أعلاه محدّثة.'; }
  }

  return {
    market, movers, why: narr.why, what: narr.what, so_what: narr.so_what, watch: narr.watch,
    session,
    footer: `القرار في النهاية عندك يا ${displayName(pf, nickname)}`,
    disclaimer: 'تحليل معلوماتي — ليست نصيحة مالية',
    generated_at: dubaiTime()
  };
}

// ─── handler ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!FMP_KEY) return res.status(500).json({ error: 'FMP_API_KEY missing' });

  const body = req.body || {};
  const nickname = (body.nickname || 'rashed').toLowerCase();
  const force = !!body.forceRefresh;
  const session = usSession();
  const today = uaeDate();
  const cachePath = `data/market/pulse-${nickname}-${today}.json`;

  try {
    const cached = await ghReadJsonApi(cachePath);      // { ...data, _genMs, _manualDate }
    const ageMs = cached && cached._genMs ? (Date.now() - cached._genMs) : Infinity;

    // decide whether to regenerate + whether this counts as today's manual refresh
    let regen = false, manualUsed = cached && cached._manualDate === today;
    let setManual = false, blockedMsg = null;

    if (!cached) {
      regen = true;                                     // never leave the card empty
    } else if (force) {
      if (session === 'intraday') {
        regen = true;                                   // manual refresh always allowed when open
      } else if (!manualUsed) {
        regen = true; setManual = true;                 // closed: one manual refresh per day
      } else {
        blockedMsg = 'تم التحديث اليوم — السوق مغلق، جرّب غداً';  // closed + already refreshed today
      }
    } else {
      // auto-load
      if (session === 'intraday' && ageMs > STALE_MS) regen = true;
      // closed auto-load → never regenerate
    }

    if (!regen) {
      const out = { ...cached, cached: true };
      delete out._genMs; delete out._manualDate;
      if (blockedMsg) out.refresh_note = blockedMsg;
      return res.status(200).json(out);
    }

    const fresh = await generate(nickname, session);
    const store = {
      ...fresh,
      _genMs: Date.now(),
      _manualDate: setManual ? today : (cached && cached._manualDate) || null
    };
    await ghWrite(cachePath, store);                    // best-effort; card still returns if write fails

    return res.status(200).json({ ...fresh, cached: false });

  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e).slice(0, 200) });
  }
};
