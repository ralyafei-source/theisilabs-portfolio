/* ============================================================================
   THEISI — نبض السوق (Market Pulse)  ·  on-demand "what / why / so-what"
   ----------------------------------------------------------------------------
   INSTALL (Vercel Pro — standalone function is fine):
   1. Save this whole file as:  api/market-pulse.js  in your GitHub repo.
   2. Nothing else — the card POSTs to /api/market-pulse.

   Endpoint:  POST /api/market-pulse   body { nickname, forceRefresh }
   ENV needed (all already in your Vercel project except the last):
     ANTHROPIC_API_KEY, GITHUB_TOKEN, and MARKETAUX_TOKEN (add this one).
   FMP key falls back to your hardcoded key like your other handlers.
   ============================================================================ */

const MP_FMP_KEY   = process.env.FMP_API_KEY   || 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
const MP_MARKETAUX = process.env.MARKETAUX_TOKEN || '';
const MP_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const MP_GH_TOKEN  = process.env.GITHUB_TOKEN;
const MP_GH_OWNER  = 'ralyafei-source';
const MP_GH_REPO   = 'theisilabs-portfolio';
const MP_GH_BRANCH = 'main';

// ── tuning knobs ────────────────────────────────────────────────────────────
const MP_MATCH_MIN   = 20;      // Marketaux match_score below this = noise (Eli-Lilly→NVDA was 13.5)
const MP_MOVER_ABS   = 3.0;     // |dayPct| >= this qualifies as a mover
const MP_MOVER_VALUE = 5000;    // OR holding value >= this (only movers that matter to the portfolio)
const MP_MAX_MOVERS  = 8;       // cap movers we explain
const MP_INDEXES     = ['SPY', 'QQQ', 'DIA'];  // market context (S&P / Nasdaq / Dow proxies)

// Motley-Fool / newsletter ad boilerplate that Marketaux mis-tags to tickers.
// Any highlight containing one of these is IGNORED (it is an ad, not news).
const MP_AD_PATTERNS = [
  /missed\s+\w+\s+in\s+20\d\d/i,        // "Missed Nvidia in 2009?"
  /the analyst who called/i,           // "Act now: the analyst who called NVIDIA..."
  /\bact now\b/i,
  /double down/i,
  /this rare/i,
  /when \w+ made this list/i
];

// ── tiny GitHub JSON helpers (self-contained, no name clash) ─────────────────
async function mpGhRead(path) {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${MP_GH_OWNER}/${MP_GH_REPO}/contents/${path}?ref=${MP_GH_BRANCH}`,
      { headers: { Authorization: `Bearer ${MP_GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  } catch (_) { return null; }
}
async function mpGhWrite(path, obj) {
  try {
    // fetch existing sha (update-in-place) if present
    let sha;
    const cur = await fetch(
      `https://api.github.com/repos/${MP_GH_OWNER}/${MP_GH_REPO}/contents/${path}?ref=${MP_GH_BRANCH}`,
      { headers: { Authorization: `Bearer ${MP_GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (cur.ok) { sha = (await cur.json()).sha; }
    const body = {
      message: `pulse: ${path}`,
      content: Buffer.from(JSON.stringify(obj, null, 2)).toString('base64'),
      branch: MP_GH_BRANCH,
      ...(sha ? { sha } : {})
    };
    const w = await fetch(
      `https://api.github.com/repos/${MP_GH_OWNER}/${MP_GH_REPO}/contents/${path}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${MP_GH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    return w.ok;
  } catch (_) { return false; }
}

// ── FMP quote (batch with per-symbol fallback for Starter tier) ──────────────
// FIX: compute dayPct OURSELVES from (price - previousClose)/previousClose.
// FMP's changePercentage field occasionally returns a bad value (e.g. DIA showed
// +1.2% on 2026-07-28 when the real close was +0.57%). We only fall back to
// FMP's field if previousClose is missing.
function mpNorm(q) {
  const price = +q.price;
  const prev  = +q.previousClose;
  let dayPct = null;
  if (prev > 0 && isFinite(price)) {
    dayPct = +(((price - prev) / prev) * 100).toFixed(2);      // self-computed (trusted)
  } else if (q.changePercentage != null) {
    dayPct = +(+q.changePercentage).toFixed(2);                // fallback only
  }
  return { price, previousClose: prev || null, dayPct, name: q.name };
}
async function mpQuotes(symbols) {
  const out = {};
  const chunk = (a, n) => a.reduce((r, _, i) => (i % n ? r : [...r, a.slice(i, i + n)]), []);
  for (const grp of chunk(symbols, 20)) {
    try {
      const r = await fetch(`https://financialmodelingprep.com/stable/batch-quote?symbols=${grp.join(',')}&apikey=${MP_FMP_KEY}`);
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr) && arr.length) {
          arr.forEach(q => { if (q && q.symbol) out[q.symbol] = mpNorm(q); });
          continue;
        }
      }
    } catch (_) {}
    // fallback: single quotes
    for (const s of grp) {
      try {
        const r = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${s}&apikey=${MP_FMP_KEY}`);
        const a = await r.json();
        const q = Array.isArray(a) ? a[0] : a;
        if (q && q.symbol) out[q.symbol] = mpNorm(q);
      } catch (_) {}
    }
  }
  return out;
}

// ── Is the US market open right now? (labels the card intraday vs closed) ─────
// Regular hours 9:30–16:00 ET. DST approximated as Mar–Oct (EDT, UTC-4);
// otherwise EST (UTC-5). Good enough for a session label.
function mpSession() {
  const now = new Date();                       // UTC in Vercel
  const dow = now.getUTCDay();                  // 0=Sun … 6=Sat
  if (dow === 0 || dow === 6) return 'closed';
  const month = now.getUTCMonth() + 1;
  const edt = month >= 3 && month <= 10;        // rough DST window
  const openMin  = edt ? (13 * 60 + 30) : (14 * 60 + 30);
  const closeMin = edt ? (20 * 60) : (21 * 60);
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (mins >= openMin && mins < closeMin) ? 'intraday' : 'closed';
}

// ── Marketaux: news for movers, with HARD noise filter ───────────────────────
function mpCleanHighlight(h) { return (h || '').replace(/<\/?em>/g, '').replace(/\[\+\d+ characters\]/g, '').trim(); }
function mpIsAd(text) { return MP_AD_PATTERNS.some(re => re.test(text || '')); }

async function mpDrivers(moverSyms) {
  const drivers = {}; // sym -> {title, sentiment, source} | null
  moverSyms.forEach(s => { drivers[s] = null; });
  if (!MP_MARKETAUX || !moverSyms.length) return drivers;

  // 2-day lookback so a mover always has a shot at a catalyst
  const since = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  let data = [];
  try {
    const url = `https://api.marketaux.com/v1/news/all?symbols=${moverSyms.join(',')}`
      + `&filter_entities=true&language=en&limit=25&published_after=${since}`
      + `&api_token=${MP_MARKETAUX}`;
    const r = await fetch(url);
    const j = await r.json();
    data = j.data || [];
  } catch (_) { return drivers; }

  for (const art of data) {
    const titleIsAd = mpIsAd(art.title);
    for (const ent of (art.entities || [])) {
      const sym = ent.symbol;
      if (!moverSyms.includes(sym)) continue;
      if ((ent.match_score || 0) < MP_MATCH_MIN) continue;          // kill weak tags (the Eli-Lilly→NVDA trap)

      // require at least one NON-AD highlight that mentions the entity
      const goodHi = (ent.highlights || [])
        .map(h => ({ ...h, clean: mpCleanHighlight(h.highlight) }))
        .filter(h => h.clean && !mpIsAd(h.clean));
      const inTitle = (ent.highlights || []).some(h => h.highlighted_in === 'title') && !titleIsAd;
      if (!goodHi.length && !inTitle) continue;

      const cand = {
        title: (art.title || '').trim(),
        sentiment: ent.sentiment_score,
        source: art.source || '',
        url: art.url || '',
        match: ent.match_score
      };
      // keep the highest-match, non-ad driver per symbol
      if (!drivers[sym] || cand.match > drivers[sym].match) drivers[sym] = cand;
    }
  }
  // strip internal match score before returning
  Object.keys(drivers).forEach(s => { if (drivers[s]) delete drivers[s].match; });
  return drivers;
}

// ── Arabic narrative (Golden Separation: code gives facts, Claude only phrases) ─
function mpBuildPrompt(payload, name) {
  return `أنت محلل مالي يكتب للمستثمر الخليجي "${name}". اكتب بالعربية الخليجية، بأسلوب صديق خبير لا تقرير بنك.
مهمتك: اشرح ما يحدث الآن في السوق ومحفظته — ماذا، لماذا، وماذا يعني — من البيانات المعطاة فقط.

قواعد صارمة (ممنوع كسرها):
- لا تخترع أي رقم. استخدم الأرقام المعطاة كما هي فقط.
- لا تربط خبراً بسهم إلا إذا كان مذكوراً صراحة في حقل driver لذلك السهم.
- إذا كان driver = null لسهم، اكتب أن سبب حركته "غير مؤكد من البيانات المتاحة" — لا تخمّن.
- اشرح ولا توصِ. لا "اشترِ" ولا "بِع". صف ما يعنيه الوضع وما يستحق المتابعة.
- لا تصف الشركات بمعلومات غير موجودة في البيانات.

أعد النتيجة JSON فقط بهذا الشكل (بدون أي نص خارج الـ JSON):
{
  "what": "جملتان عن الصورة الكلية للسوق اليوم من أرقام المؤشرات.",
  "why": [ { "sym": "AAPL", "text": "سطر واحد: كم تحرك السهم ولماذا (من driver أو 'غير مؤكد')." } ],
  "so_what": "فقرة قصيرة: ماذا يعني هذا لتوزيع محفظته وما الذي يستحق المتابعة — بلا توصية.",
  "watch": [ "بند متابعة قصير", "بند آخر" ]
}

البيانات:
${JSON.stringify(payload, null, 2)}`;
}

async function mpClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MP_ANTHROPIC, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  let t = (d.content?.[0]?.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(t);
}

// ── main handler ─────────────────────────────────────────────────────────────
async function runPulse(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body     = req.body || {};
    const nickname = (body.nickname || 'rashed').toLowerCase();
    const force    = !!body.forceRefresh;
    const displayName = nickname.charAt(0).toUpperCase() + nickname.slice(1);
    const today    = new Date(Date.now() + 4 * 36e5).toISOString().slice(0, 10); // UAE date
    const cachePath = `data/market-pulse-${nickname}-${today}.json`;

    // 1) cache (skip Claude if fresh copy exists and not forced)
    if (!force) {
      const cached = await mpGhRead(cachePath);
      if (cached) return res.status(200).json({ ...cached, cached: true });
    }

    // 2) portfolio holdings
    const pf = await mpGhRead(nickname === 'rashed' ? 'data/portfolio.json' : `data/portfolio-${nickname}.json`);
    const holdings = (pf && (pf.stocks || pf.holdings || pf)) || [];
    const rows = (Array.isArray(holdings) ? holdings : []).map(h => ({
      sym: h.sym || h.symbol,
      shares: +(h.shares || 0),
      cost: +(h.cost || 0)
    })).filter(h => h.sym);
    const pfSyms = [...new Set(rows.map(r => r.sym))];

    // 3) quotes for indices + holdings
    const quotes = await mpQuotes([...MP_INDEXES, ...pfSyms]);

    const market = MP_INDEXES.map(s => ({
      sym: s,
      dayPct: quotes[s] ? +(+quotes[s].dayPct).toFixed(2) : null
    })).filter(m => m.dayPct != null);

    // 4) rank movers (matters if it moved OR it's a big position)
    let movers = rows.map(r => {
      const q = quotes[r.sym] || {};
      const price = +q.price || 0;
      const value = price * r.shares;
      const dayPct = q.dayPct != null ? +(+q.dayPct).toFixed(2) : null;
      return { sym: r.sym, name: q.name || r.sym, dayPct, value: Math.round(value) };
    }).filter(m => m.dayPct != null)
      .filter(m => Math.abs(m.dayPct) >= MP_MOVER_ABS || m.value >= MP_MOVER_VALUE)
      .sort((a, b) => Math.abs(b.dayPct) - Math.abs(a.dayPct))
      .slice(0, MP_MAX_MOVERS);

    // 5) drivers (the "why") — filtered hard against noise
    const drivers = await mpDrivers(movers.map(m => m.sym));
    movers = movers.map(m => ({ ...m, driver: drivers[m.sym] || null }));

    // 6) narrative
    const payload = { date: today, market, movers };
    let narrative;
    try {
      narrative = await mpClaude(mpBuildPrompt(payload, displayName));
    } catch (e) {
      return res.status(500).json({ error: 'narrative_failed', details: String(e).slice(0, 200), payload });
    }

    const result = {
      schema: 3,
      nickname,
      date: today,
      session: mpSession(),   // 'intraday' = numbers still moving | 'closed' = final
      generated_at: new Date(Date.now() + 4 * 36e5).toISOString().slice(0, 16).replace('T', ' '),
      market,
      movers,
      what: narrative.what || '',
      why: Array.isArray(narrative.why) ? narrative.why : [],
      so_what: narrative.so_what || '',
      watch: Array.isArray(narrative.watch) ? narrative.watch : [],
      disclaimer: 'تحليل معلوماتي — ليست نصيحة مالية',
      footer: `القرار في النهاية عندك يا ${displayName}`
    };

    // 7) cache + return
    await mpGhWrite(cachePath, result);
    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = runPulse;
