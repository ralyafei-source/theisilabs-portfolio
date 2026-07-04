// api/portfolio-for-ai.js
// Returns portfolio as formatted plain text for Claude
// Supports ?nickname=ahmed for per-user portfolios
// Supports ?include=intelligence for smart FMP data (earnings, targets, grades, metrics, technicals)
// Default (no nickname): reads Rashed's portfolio.json

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const FMP_KEY = process.env.FMP_API_KEY;
const FMP     = 'https://financialmodelingprep.com/stable';

// ─── FMP helper ──────────────────────────────────────────────────────────────
async function fmpGet(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? d : (d?.Error ? null : d);
  } catch { return null; }
}

function todayUAE() {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysAheadUAE(n) {
  return new Date(Date.now() + 4 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);
}

// ─── Extract latest value from FMP indicator response ────────────────────────
function latest(arr, field) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[0]?.[field] ?? null;
}

// ─── main ────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  // Auth check
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ', '').trim();
  if (key && key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ══════════════════════════════════════════════════════════════════
  // FMP-ONLY MODES — placed BEFORE portfolio load so a GitHub hiccup on
  // portfolio.json can never take these down (fear gauge + macro card).
  // ══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// THEISI — mode=sentiment  v3  (4-FACTOR FEAR & GREED)
// Drop-in REPLACEMENT for your existing `if (req.query.mode === 'sentiment')`
// block. Same response shape (score, label, label_ar, vix, vixPercentile,
// trend, weekAgoScore, asOf) so the dashboard card needs ZERO redesign.
//
// Adds three new factors alongside your VIX gauge for a real market feel:
//   1. Volatility   (VIX percentile, inverted)        weight 30%
//   2. Momentum     (S&P500 vs its 125d average)      weight 25%
//   3. Safe-haven   (stocks SPY vs bonds TLT, 20d)    weight 25%
//   4. Strength     (SPY position in 52-week range)   weight 20%
//
// Sources: FMP only (same FMP_API_KEY you already use). No scraping, no CNN.
// Test: /api/portfolio-for-ai?mode=sentiment
//       /api/portfolio-for-ai?mode=sentiment&debug=1   (see each factor)
// ═══════════════════════════════════════════════════════════════════════════
  if (req.query.mode === 'sentiment') {
    try {
      const FMP = process.env.FMP_API_KEY || process.env.FMP_KEY;
      const FMP_BASE = 'https://financialmodelingprep.com/stable';
      const debug = req.query.debug === '1';

      // ── tunable weights (must sum to 1.0) ──────────────────────────────────
      const W = { vol: 0.30, mom: 0.25, safe: 0.25, strength: 0.20 };

      // ── helpers ────────────────────────────────────────────────────────────
      const jget = async (url) => { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; } };
      const closesOf = (raw) => {
        const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.historical) ? raw.historical : []);
        return arr.map(d => ({ date: d.date, v: Number(d.price != null ? d.price : d.close) }))
                  .filter(x => isFinite(x.v));   // newest-first
      };
      const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
      const pctRank = (val, window) => {           // % of window below val → 0..100
        const w = window.filter(isFinite);
        if (!w.length) return null;
        return (w.filter(v => v < val).length / w.length) * 100;
      };
      const sma = (arr, n) => {                     // simple moving avg of first n (newest)
        const s = arr.slice(0, n).filter(isFinite);
        return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
      };

      // ── fetch all series in parallel ───────────────────────────────────────
      const Q = (sym) => `${FMP_BASE}/quote?symbol=${encodeURIComponent(sym)}&apikey=${FMP}`;
      const H = (sym) => `${FMP_BASE}/historical-price-eod/light?symbol=${encodeURIComponent(sym)}&apikey=${FMP}`;

      const [vixQ, vixH, spxH, spyH, tltH] = await Promise.all([
        jget(Q('^VIX')),
        jget(H('^VIX')),
        jget(H('^GSPC')),   // S&P 500 index for momentum
        jget(H('SPY')),     // S&P ETF for safe-haven + strength
        jget(H('TLT')),     // 20yr treasuries for safe-haven
      ]);

      const vixNow = Array.isArray(vixQ) && vixQ[0] ? Number(vixQ[0].price) : null;
      const vixSeries = closesOf(vixH);
      const spxSeries = closesOf(spxH);
      const spySeries = closesOf(spyH);
      const tltSeries = closesOf(tltH);
      
      
      // ════════════════════════════════════════════════════════════════════════
      // FACTOR 1 — VOLATILITY  (VIX percentile, inverted)  — same as your v2
      // low VIX vs its year = calm = greed = high score
      // ════════════════════════════════════════════════════════════════════════
      let fVol = null, vixPct252 = null;
      if (vixNow != null && vixSeries.length) {
        const closes = vixSeries.map(x => x.v).slice(0, 252);
        const below = closes.filter(v => v < vixNow).length;
        vixPct252 = below / closes.length;                    // 0..1
        fVol = clamp(Math.round((1 - vixPct252) * 100), 0, 100);
      }

      // ════════════════════════════════════════════════════════════════════════
      // FACTOR 2 — MOMENTUM  (S&P500 vs its own 125-day average)
      // above average = uptrend = greed.  Map ±5% gap → 0..100.
      // ════════════════════════════════════════════════════════════════════════
      let fMom = null, momGapPct = null;
      if (spxSeries.length > 125) {
        const px = spxSeries[0].v;
        const avg125 = sma(spxSeries.map(x => x.v), 125);
        if (avg125) {
          momGapPct = (px - avg125) / avg125 * 100;            // e.g. +6.4%
          // The S&P's gap-to-125d-avg historically swings ~±12%, so a +6% gap is
          // "moderately above trend", NOT maximum greed. Scale ±12% → 0..100.
          // Also subtract a short-term decay: if price fell over the last 10d,
          // bleed the score down so a selloff registers even when still above trend.
          let recentDrop = 0;
          if (spxSeries.length > 10) {
            const r10 = (px - spxSeries[10].v) / spxSeries[10].v * 100; // 10d return
            if (r10 < 0) recentDrop = Math.min(20, -r10 * 4);   // up to -20 pts
          }
          fMom = clamp(Math.round(50 + momGapPct * 4.1 - recentDrop), 0, 100);
        }
      }

      // ════════════════════════════════════════════════════════════════════════
      // FACTOR 3 — SAFE-HAVEN DEMAND  (stocks vs bonds, 20-day return spread)
      // SPY outperforming TLT = risk-on = greed.  Map ±8% spread → 0..100.
      // ════════════════════════════════════════════════════════════════════════
      let fSafe = null, safeSpread = null;
      if (spySeries.length > 21 && tltSeries.length > 21) {
        const spyRet = (spySeries[0].v - spySeries[20].v) / spySeries[20].v * 100;
        const tltRet = (tltSeries[0].v - tltSeries[20].v) / tltSeries[20].v * 100;
        safeSpread = spyRet - tltRet;                         // stocks minus bonds
        // +8% spread → 100 (greed), -8% → 0 (fear)
        fSafe = clamp(Math.round(50 + safeSpread * 6.25), 0, 100);
      }

      // ════════════════════════════════════════════════════════════════════════
      // FACTOR 4 — MARKET STRENGTH  (recency-sensitive short-term trend proxy)
      // The old "position in 52-week range" pinned ~90 in any bull year and could
      // not fall on a bad week. CNN uses breadth (advancers vs decliners), which
      // drops in selloffs. We approximate that responsiveness with SPY's OWN
      // short-term trend: distance from its 20-day average + 5-day momentum.
      // Above 20d avg & rising = strength (greed); below & falling = weak (fear).
      // ════════════════════════════════════════════════════════════════════════
      let fStrength = null, strGapPct = null, str5dRet = null;
      if (spySeries.length > 21) {
        const px = spySeries[0].v;
        const avg20 = sma(spySeries.map(x => x.v), 20);
        str5dRet = (px - spySeries[5].v) / spySeries[5].v * 100;   // 5-day return
        if (avg20) {
          strGapPct = (px - avg20) / avg20 * 100;                 // dist from 20d avg
          // 20d gap swings ~±5%; 5d return ~±5%. Blend both, centered at 50.
          fStrength = clamp(Math.round(50 + strGapPct * 6 + str5dRet * 4), 0, 100);
        }
      }

      // ════════════════════════════════════════════════════════════════════════
      // COMPOSITE — weighted average of available factors (re-normalise weights
      // if any factor is missing, so a single FMP gap doesn't break the score)
      // ════════════════════════════════════════════════════════════════════════
      const factors = [
        { key: 'vol',      score: fVol,      w: W.vol },
        { key: 'mom',      score: fMom,      w: W.mom },
        { key: 'safe',     score: fSafe,     w: W.safe },
        { key: 'strength', score: fStrength, w: W.strength },
      ];
      const present = factors.filter(f => f.score != null);
      if (!present.length) {
        return res.status(200).json({ error: 'sentiment data unavailable', vixNow });
      }
      const wSum = present.reduce((a, f) => a + f.w, 0);
      const score = Math.round(present.reduce((a, f) => a + f.score * f.w, 0) / wSum);

      // ── labels (same thresholds + Arabic as your card expects) ─────────────
      const label    = score < 25 ? 'Extreme Fear' : score < 45 ? 'Fear' : score < 55 ? 'Neutral' : score < 75 ? 'Greed' : 'Extreme Greed';
      const label_ar = score < 25 ? 'خوف شديد'     : score < 45 ? 'خوف'  : score < 55 ? 'محايد'   : score < 75 ? 'جشع'  : 'جشع شديد';

      // ════════════════════════════════════════════════════════════════════════
      // 30/90-DAY TREND — recompute the COMPOSITE for each recent day, using the
      // same rolling logic per factor against the day's trailing windows.
      // Keeps the dashboard trend line, now multi-factor instead of VIX-only.
      // ════════════════════════════════════════════════════════════════════════
      const trend = [];
      const N = Math.min(90, vixSeries.length, spxSeries.length, spySeries.length, tltSeries.length);
      for (let i = N - 1; i >= 0; i--) {
        const day = vixSeries[i].date;

        // factor 1: VIX percentile that day vs its trailing 252d
        let s1 = null;
        const vWin = vixSeries.slice(i, i + 252).map(x => x.v);
        if (vWin.length && isFinite(vixSeries[i].v)) {
          const below = vWin.filter(v => v < vixSeries[i].v).length;
          s1 = clamp(Math.round((1 - below / vWin.length) * 100), 0, 100);
        }
        // factor 2: SPX vs trailing 125d avg that day (rescaled + 10d decay)
        let s2 = null;
        if (spxSeries.length > i + 125) {
          const a = sma(spxSeries.slice(i).map(x => x.v), 125);
          if (a) {
            const gap = (spxSeries[i].v - a) / a * 100;
            let drop = 0;
            if (spxSeries.length > i + 10) {
              const r10 = (spxSeries[i].v - spxSeries[i + 10].v) / spxSeries[i + 10].v * 100;
              if (r10 < 0) drop = Math.min(20, -r10 * 4);
            }
            s2 = clamp(Math.round(50 + gap * 4.1 - drop), 0, 100);
          }
        }
        // factor 3: 20d SPY-TLT spread ending that day
        let s3 = null;
        if (spySeries.length > i + 20 && tltSeries.length > i + 20) {
          const sr = (spySeries[i].v - spySeries[i + 20].v) / spySeries[i + 20].v * 100;
          const tr = (tltSeries[i].v - tltSeries[i + 20].v) / tltSeries[i + 20].v * 100;
          s3 = clamp(Math.round(50 + (sr - tr) * 6.25), 0, 100);
        }
        // factor 4: SPY short-term trend that day (20d gap + 5d return)
        let s4 = null;
        if (spySeries.length > i + 21) {
          const a20 = sma(spySeries.slice(i).map(x => x.v), 20);
          if (a20) {
            const gap = (spySeries[i].v - a20) / a20 * 100;
            const r5 = (spySeries[i].v - spySeries[i + 5].v) / spySeries[i + 5].v * 100;
            s4 = clamp(Math.round(50 + gap * 6 + r5 * 4), 0, 100);
          }
        }

        const dayFactors = [
          { score: s1, w: W.vol }, { score: s2, w: W.mom },
          { score: s3, w: W.safe }, { score: s4, w: W.strength },
        ].filter(f => f.score != null);
        if (dayFactors.length) {
          const dw = dayFactors.reduce((a, f) => a + f.w, 0);
          trend.push({ date: day, score: Math.round(dayFactors.reduce((a, f) => a + f.score * f.w, 0) / dw) });
        }
      }

      const weekAgoScore = trend.length >= 8 ? trend[trend.length - 8].score : (trend.length ? trend[0].score : score);

      // ── CNN Fear & Greed (live) — fetched always now, for side-by-side ──────
      // CNN's index is a 7-factor sentiment gauge; we surface it as a reference.
      // Wrapped so a CNN outage never breaks our own score.
      let cnn = null;
      try {
        const cr = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' }
        });
        if (cr.ok) {
          const cj = await cr.json();
          const fg = cj && cj.fear_and_greed ? cj.fear_and_greed : null;
          if (fg && fg.score != null) {
            const cs = Math.round(Number(fg.score));
            cnn = {
              score: cs,
              rating: fg.rating || null,
              // Arabic label on OUR thresholds so the card stays bilingual-consistent
              label_ar: cs < 25 ? 'خوف شديد' : cs < 45 ? 'خوف' : cs < 55 ? 'محايد' : cs < 75 ? 'جشع' : 'جشع شديد',
            };
          }
        }
      } catch {}

      // ── response (same fields the card reads + breakdown + CNN reference) ───
      const resp = {
        score, label, label_ar,
        vix: vixNow != null ? +vixNow.toFixed(2) : null,
        vixPercentile: vixPct252 != null ? +(vixPct252 * 100).toFixed(0) : null,
        trend,                       // [{date, score}] oldest→newest
        weekAgoScore,
        asOf: new Date().toISOString().slice(0, 10),
        method: '4-factor (VIX 30% · momentum 25% · safe-haven 25% · strength 20%)',
        factors: {
          volatility: fVol,
          momentum:   fMom,
          safeHaven:  fSafe,
          strength:   fStrength,
        },
        cnn,                         // {score, rating, label_ar} or null
        vsCNN: cnn ? (score - cnn.score) : null,
      };
      if (debug) {
        resp.debug = {
          vixNow, vixPct252,
          momGapPct: momGapPct != null ? +momGapPct.toFixed(2) : null,
          safeSpread: safeSpread != null ? +safeSpread.toFixed(2) : null,
          strGapPct: strGapPct != null ? +strGapPct.toFixed(2) : null,
          str5dRet: str5dRet != null ? +str5dRet.toFixed(2) : null,
          weights: W,
          seriesLengths: { vix: vixSeries.length, spx: spxSeries.length, spy: spySeries.length, tlt: tltSeries.length },
        };
      }
      return res.status(200).json(resp);
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }

// ═══════════════════════════════════════════════════════════════════════════
// THEISI — mode=macro  (US MACRO EVENTS: Fed / CPI / PCE / Jobs / GDP …)
// Drop-in block for portfolio-for-ai.js. Paste alongside the other
// `if (req.query.mode === '...')` branches (after the auth check).
//
// Returns upcoming high-impact US economic events, each with:
//   • date (+ days away)            — from FMP economic calendar
//   • consensus / previous          — from FMP (current analyst expectation)
//   • what_ar                       — what the announcement is (Arabic)
//   • impact_ar                     — how hot/cold prints typically move markets
//
// Source: FMP /economic-calendar (same FMP_API_KEY you already use).
// The explainer/playbook text is a curated Arabic lookup (not from the API).
// Test: /api/portfolio-for-ai?mode=macro
//       /api/portfolio-for-ai?mode=macro&days=45
// ═══════════════════════════════════════════════════════════════════════════
  if (req.query.mode === 'macro') {
    try {
      const FMP = process.env.FMP_API_KEY || process.env.FMP_KEY;
      const FMP_BASE = 'https://financialmodelingprep.com/stable';

      const horizon = Math.min(120, Math.max(7, parseInt(req.query.days || '40', 10)));
      const today = new Date(Date.now() + 4*3600*1000).toISOString().slice(0,10);     // UAE
      const to    = new Date(Date.now() + 4*3600*1000 + horizon*86400000).toISOString().slice(0,10);

      // ── pull FMP economic calendar for the window ─────────────────────────
      let rows = [];
      try {
        const r = await fetch(`${FMP_BASE}/economic-calendar?from=${today}&to=${to}&apikey=${FMP}`);
        if (r.ok) { const j = await r.json(); rows = Array.isArray(j) ? j : []; }
      } catch {}

      // US only — strict. FMP tags US events with country 'US'. Some feeds also
      // carry 'United States'. Currency/USD is too loose (catches FX pairs), so
      // we require an explicit US country tag.
      rows = rows.filter(e => {
        const c = String(e.country || '').trim().toUpperCase();
        return c === 'US' || c === 'USA' || c === 'UNITED STATES';
      });

      // ── event catalog: which events we care about + Arabic playbook ───────
      // match[]  = lowercase substrings to detect this event in FMP's `event` name
      // tier     = 1 (top market-mover) … 2 (important)
      // unit     = how to format the numbers
      const CATALOG = [
        {
          key:'fomc', tier:1, unit:'%',
          match:['fomc','fed interest rate','federal funds','interest rate decision','fed rate'],
          name_ar:'قرار الفائدة — الاحتياطي الفيدرالي (FOMC)',
          what_ar:'الاجتماع اللي يحدد فيه الفيدرالي سعر الفائدة. أهم حدث اقتصادي للسوق كله — يأثر على كل الأسهم، خصوصاً النمو والتقنية.',
          hot_ar:'لو رفعوا الفائدة أو لمّحوا لتشديد أطول: ضغط على أسهم النمو والتقنية، وعادة هبوط بالسوق.',
          cold_ar:'لو خفّضوا أو لمّحوا لتيسير: دعم قوي للأسهم، خصوصاً النمو — وغالباً صعود.',
        },
        {
          key:'cpi', tier:1, unit:'%',
          match:['cpi','consumer price index','inflation rate'],
          name_ar:'مؤشر أسعار المستهلك (CPI) — التضخم',
          what_ar:'يقيس تضخم الأسعار للمستهلك. الرقم الأهم اللي يحدد توقعات السوق لقرارات الفيدرالي القادمة.',
          hot_ar:'تضخم أعلى من المتوقع: السوق يخاف من فائدة أعلى لمدة أطول → ضغط على الأسهم.',
          cold_ar:'تضخم أقل من المتوقع: يفتح الباب لخفض الفائدة → دعم للأسهم، خصوصاً النمو.',
        },
        {
          key:'pce', tier:1, unit:'%',
          match:['pce','personal consumption expenditure','core pce'],
          name_ar:'مؤشر نفقات الاستهلاك (PCE)',
          what_ar:'مقياس التضخم المفضّل لدى الفيدرالي نفسه. وزنه ثقيل في قرارات الفائدة.',
          hot_ar:'PCE أعلى من المتوقع: يقلّل احتمال خفض الفائدة → سلبي للأسهم.',
          cold_ar:'PCE أقل من المتوقع: يدعم خفض الفائدة → إيجابي للأسهم.',
        },
        {
          key:'nfp', tier:1, unit:'K',
          match:['nonfarm payroll','non-farm payroll','employment change','payrolls'],
          name_ar:'تقرير الوظائف (Nonfarm Payrolls)',
          what_ar:'عدد الوظائف الجديدة خارج القطاع الزراعي. مؤشر قوة الاقتصاد وسوق العمل.',
          hot_ar:'وظائف أقوى بكثير: اقتصاد قوي لكن قد يعني فائدة أعلى لمدة أطول → ردة فعل مختلطة.',
          cold_ar:'وظائف أضعف: قد يسرّع خفض الفائدة، لكن الضعف الشديد يقلق من ركود.',
        },
        {
          key:'unemp', tier:2, unit:'%',
          match:['unemployment rate'],
          name_ar:'معدل البطالة',
          what_ar:'نسبة العاطلين عن العمل. يُقرأ مع تقرير الوظائف لقياس صحة سوق العمل.',
          hot_ar:'بطالة أعلى من المتوقع: ضعف بسوق العمل — قد يدفع الفيدرالي للتيسير.',
          cold_ar:'بطالة أقل: سوق عمل قوي — قد يبقي الفائدة مرتفعة أطول.',
        },
        {
          key:'gdp', tier:2, unit:'%',
          match:['gdp','gross domestic product'],
          name_ar:'الناتج المحلي الإجمالي (GDP)',
          what_ar:'نمو الاقتصاد الكلي. يقيس هل الاقتصاد يتوسّع أو ينكمش.',
          hot_ar:'نمو أقوى: إيجابي للأسهم الدورية والصناعية.',
          cold_ar:'نمو أضعف: قلق من تباطؤ — ضغط على الأسهم الدورية.',
        },
        {
          key:'retail', tier:2, unit:'%',
          match:['retail sales'],
          name_ar:'مبيعات التجزئة',
          what_ar:'إنفاق المستهلك الأمريكي. مؤشر مبكر على قوة الطلب في الاقتصاد.',
          hot_ar:'مبيعات أقوى: إنفاق صحي — إيجابي للاستهلاكي والدوري.',
          cold_ar:'مبيعات أضعف: ضعف الطلب — سلبي للأسهم الاستهلاكية.',
        },
      ];

      function classify(name){
        const l = String(name||'').toLowerCase();
        return CATALOG.find(c => c.match.some(m => l.includes(m))) || null;
      }
      function daysAway(dateStr){
        const d = (dateStr||'').slice(0,10);
        return Math.round((new Date(d+'T00:00:00Z') - new Date(today+'T00:00:00Z'))/86400000);
      }
      function fmtNum(v, unit){
        if (v == null || v === '' || isNaN(Number(v))) return null;
        const n = Number(v);
        if (unit === 'K') return (n>=1000? (n/1000).toFixed(1)+'M' : n+'K');
        if (unit === '%') return n + '%';
        return String(n);
      }

      // ── build output ──────────────────────────────────────────────────────
      // Rules to avoid the duplicate/stale mess:
      //  1. Drop events whose date+time has already passed (event already released).
      //  2. For each event TYPE, keep only the SOONEST upcoming occurrence
      //     (so we don't list July + August NFP at the same time).
      //  3. A type can still appear twice only if both are genuinely upcoming AND
      //     more than 20 days apart (e.g. two FOMC meetings) — handled by cap=1
      //     per type by default; raise perTypeCap via &all=1 if you want the full list.
      const nowMs = Date.now();
      const perTypeCap = req.query.all === '1' ? 5 : 1;
      const byType = {};   // key -> count kept
      const out = [];

      // sort raw rows by datetime ascending first, so "soonest per type" works
      const dated = rows
        .map(e => ({ e, cat: classify(e.event), iso: (e.date || '') }))
        .filter(x => x.cat && x.iso)
        // parse the event datetime (FMP gives 'YYYY-MM-DD HH:MM:SS' in UTC)
        .map(x => ({ ...x, ms: Date.parse(x.iso.replace(' ', 'T') + 'Z') }))
        .filter(x => isFinite(x.ms) && x.ms >= nowMs - 3600*1000)  // allow 1h grace
        .sort((a, b) => a.ms - b.ms);

      const seen = new Set();
      dated.forEach(({ e, cat, iso }) => {
        const date = iso.slice(0, 10);
        const dkey = cat.key + '|' + date;
        if (seen.has(dkey)) return;                 // same type same day
        if ((byType[cat.key] || 0) >= perTypeCap) return;  // already have soonest
        seen.add(dkey);
        byType[cat.key] = (byType[cat.key] || 0) + 1;

        const consensus = e.estimate ?? e.consensus ?? null;
        let previous  = e.previous ?? null;
        // Guard against unit mismatch (e.g. CPI consensus 3.8% YoY vs previous
        // 0.92% MoM). If both exist as % and differ by >3x in magnitude, the feed
        // is mixing YoY and MoM — drop `previous` rather than show a false compare.
        if (cat.unit === '%' && consensus != null && previous != null) {
          const a = Math.abs(Number(consensus)), b = Math.abs(Number(previous));
          if (a > 0 && b > 0 && (a / b > 3 || b / a > 3)) previous = null;
        }

        out.push({
          key: cat.key,
          tier: cat.tier,
          name_ar: cat.name_ar,
          date,
          time: iso.slice(11, 16) || null,          // UTC time
          daysAway: daysAway(date),
          consensus: fmtNum(consensus, cat.unit),
          previous:  fmtNum(previous,  cat.unit),
          rawConsensus: consensus,
          rawPrevious: previous,
          what_ar: cat.what_ar,
          impact_ar: { higher: cat.hot_ar, lower: cat.cold_ar },
        });
      });

      out.sort((a,b) => a.date.localeCompare(b.date) || a.tier - b.tier);

      // next single most-important event (tier 1, soonest) for a headline
      const next = out.find(e => e.tier === 1) || out[0] || null;

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).json({
        asOf: today,
        horizonDays: horizon,
        count: out.length,
        next,             // soonest top-tier event, for a "next Fed decision in X days" headline
        events: out,
        note_ar: 'التوقعات (consensus) من إجماع المحللين قبل الإعلان. الأرقام الفعلية تظهر بعد صدورها.',
      });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }


  const { nickname, include } = req.query;
  const wantIntelligence = include === 'intelligence';

  try {
    let holdings = [];
    let cash = {};
    let investorName = 'Rashed';
    let isGenericUser = false;

    if (nickname && nickname !== 'rashed') {
      // ── Per-user portfolio ──
      investorName = nickname.charAt(0).toUpperCase() + nickname.slice(1);
      isGenericUser = true;
      const FILE = `data/portfolio-${nickname}.json`;
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/${FILE}?t=${Date.now()}`
      );
      if (!raw.ok) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(`Portfolio for ${investorName} is empty or not found.\nNo stocks to analyze.`);
      }
      const portfolio = await raw.json();
      const userStocks = portfolio.stocks || [];
      if (userStocks.length === 0) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(`Portfolio for ${investorName} is empty.\nNo stocks to analyze.`);
      }
      holdings = userStocks.map(s => ({
        sym: s.sym, shares: s.shares || (s.mv / s.cost),
        cost: s.cost, sector: s.sec || 'tech', name: s.en || s.sym
      }));

    } else {
      // ── Rashed's portfolio (default) ──
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/data/portfolio.json?t=${Date.now()}`
      );
      if (!raw.ok) throw new Error('Cannot read portfolio.json');
      const portfolio = await raw.json();
      holdings = portfolio.holdings || [];
      cash = portfolio.cash_summary || {};
    }

    const symbols  = holdings.map(h => h.sym);
    const ownedSet = new Set(symbols);

    // ── Earnings calendar as clean JSON (?format=earnings) ───────────────────
    // Shared data bank: dashboard, briefs, and any client can consume this.
    if (req.query.format === 'earnings') {
      const today = todayUAE();
      const horizon = daysAheadUAE(120);
      // /earnings?symbol=X returns that company's upcoming + past dates (reliable per-symbol).
      // /grades?symbol=X&limit=30 → recent analyst actions → revision trend (up/down).
      const [perSym, perGrades] = await Promise.all([
        Promise.all(symbols.map(sym => fmpGet(`/earnings?symbol=${sym}&limit=12`))),
        Promise.all(symbols.map(sym => fmpGet(`/grades?symbol=${sym}&limit=30`)))
      ]);

      // Revision trend per symbol from analyst grade actions (last ~90 days)
      const cutoff = daysAheadUAE(-90);
      function revTrend(grades){
        if(!Array.isArray(grades)) return { dir:'flat', up:0, down:0 };
        let up=0, down=0;
        grades.forEach(g=>{
          if(g.date && g.date < cutoff) return;
          const a=(g.action||'').toLowerCase();
          if (a.includes('up')) up++;        // upgrade
          else if (a.includes('down')) down++;                        // downgrade
        });
        const dir = up>down ? 'up' : (down>up ? 'down' : 'flat');
        return { dir, up, down };
      }
      const trendBySym = {};
      symbols.forEach((s,i)=>{ trendBySym[s]=revTrend(perGrades[i]); });

      // Build upcoming (soonest per symbol) + past quarters (B/M/I)
      const upcomingBySym = {};
      const historyBySym  = {};
      perSym.forEach((arr, i) => {
        const sym = symbols[i];
        historyBySym[sym] = [];
        (arr || []).forEach(e => {
          const date = e.date || null;
          if (!date) return;
          const est = e.epsEstimated ?? null;
          const act = e.epsActual ?? null;
          if (date >= today) {
            // upcoming — keep soonest within horizon
            if (date > horizon) return;
            if (!upcomingBySym[sym] || date < upcomingBySym[sym].date) {
              upcomingBySym[sym] = {
                symbol: sym, date,
                days: Math.round((new Date(date+'T00:00:00Z') - new Date(today+'T00:00:00Z'))/86400000),
                epsEstimated: est,
                revenueEstimated: e.revenueEstimated ?? null,
                revisionTrend: trendBySym[sym].dir,        // 'up' | 'down' | 'flat'
                revisionUp: trendBySym[sym].up,
                revisionDown: trendBySym[sym].down,
                inPortfolio: true
              };
            }
          } else if (act != null) {
            // past — classify Beat / Miss / In-line
            let result = 'I';
            if (est != null) {
              const diff = act - est;
              const tol = Math.max(0.01, Math.abs(est) * 0.01); // within 1% = in-line
              result = diff > tol ? 'B' : (diff < -tol ? 'M' : 'I');
            }
            historyBySym[sym].push({ date, epsActual: act, epsEstimated: est, result });
          }
        });
        // newest-first, keep last 5 quarters
        historyBySym[sym].sort((a,b)=>b.date.localeCompare(a.date));
        historyBySym[sym] = historyBySym[sym].slice(0,5);
      });

      const out = Object.values(upcomingBySym)
        .map(e => ({ ...e, history: historyBySym[e.symbol] || [] }))
        .sort((a, b) => a.date.localeCompare(b.date));

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).json({
        generated_at: today,
        count: out.length,
        portfolio: out,
        earnings:  out
      });
    }

    // ── Single-symbol fundamentals lookup (?mode=lookup&sym=XXX) ─────────────
    // Returns { data:{...}, quality:{...} } for the dashboard lookup card.
    // Source-data sanity gate runs here; the dashboard adds a second display gate.
    if (req.query.mode === 'lookup') {
      const sym = (req.query.sym || '').toString().trim().toUpperCase();
      if (!sym) return res.status(400).json({ error: 'missing sym' });

      const [quoteA, profileA, kmA, ptcA, ratingA, dcfA, growthA] = await Promise.all([
        fmpGet(`/quote?symbol=${sym}`),
        fmpGet(`/profile?symbol=${sym}`),
        fmpGet(`/key-metrics-ttm?symbol=${sym}`),
        fmpGet(`/price-target-consensus?symbol=${sym}`),
        fmpGet(`/ratings-snapshot?symbol=${sym}`),
        fmpGet(`/discounted-cash-flow?symbol=${sym}`),
        fmpGet(`/financial-growth?symbol=${sym}&limit=1`)
      ]);

      const q  = Array.isArray(quoteA)   ? quoteA[0]   : quoteA;
      const p  = Array.isArray(profileA) ? profileA[0] : profileA;
      const km = Array.isArray(kmA)      ? kmA[0]      : kmA;
      const pt = Array.isArray(ptcA)     ? ptcA[0]     : ptcA;
      const rt = Array.isArray(ratingA)  ? ratingA[0]  : ratingA;
      const dcf= Array.isArray(dcfA)     ? dcfA[0]     : dcfA;
      const gr = Array.isArray(growthA)  ? growthA[0]  : growthA;

      if (!q && !p) {
        return res.status(200).json({ error: `No data found for ${sym}` });
      }

      // analyst consensus label from ratings snapshot (or price-target buckets)
      let consensus = null;
      if (rt && rt.rating) consensus = rt.rating;            // e.g. "Strong Buy"
      else if (pt) {
        const tot = (pt.strongBuy||0)+(pt.buy||0)+(pt.hold||0)+(pt.sell||0)+(pt.strongSell||0);
        if (tot > 0) {
          const bull = (pt.strongBuy||0)+(pt.buy||0);
          const bear = (pt.sell||0)+(pt.strongSell||0);
          consensus = bull > bear*1.5 ? 'Bullish' : (bear > bull*1.5 ? 'Bearish' : 'Neutral');
        }
      }

      const data = {
        symbol:          sym,
        companyName:     (p && (p.companyName || p.name)) || (q && q.name) || sym,
        sector:          p ? p.sector  : null,
        website:         p ? p.website : null,
        description:     p ? p.description : null,
        price:           q ? (q.price ?? null) : null,
        changePct:       q ? (q.changePercentage ?? q.changesPercentage ?? null) : null,
        marketCap:       (q && q.marketCap) ?? (p && p.marketCap) ?? null,
        beta:            (p && p.beta) ?? (km && km.beta) ?? null,
        pe:              (q && q.pe) ?? (km && km.peRatioTTM) ?? null,
        peg:             km ? (km.pegRatioTTM ?? km.priceEarningsToGrowthRatioTTM ?? null) : null,
        roe:             km ? ((km.returnOnEquityTTM != null ? km.returnOnEquityTTM * 100 : null)) : null,
        revenueGrowth:   gr ? ((gr.revenueGrowth != null ? gr.revenueGrowth * 100 : null)) : null,
        targetMean:      pt ? (pt.targetConsensus ?? pt.targetMean ?? null) : null,
        targetMedian:    pt ? (pt.targetMedian ?? null) : null,
        targetHigh:      pt ? (pt.targetHigh ?? null) : null,
        targetLow:       pt ? (pt.targetLow ?? null) : null,
        dcfValue:        dcf ? (dcf.dcf ?? null) : null,
        analystConsensus: consensus
      };

      // ── Source-data sanity gate (server side) ───────────────────────────
      const RANGES = {
        price:[0,1000000], changePct:[-90,90], pe:[0,500], peg:[0,50],
        roe:[-150,150], beta:[0,4], revenueGrowth:[-60,300], marketCap:[0,5e13],
        targetMean:[0,1000000], dcfValue:[0,1000000]
      };
      const flags = [];
      for (const k in RANGES) {
        const v = data[k];
        if (v == null) continue;
        const n = Number(v);
        if (isNaN(n) || n < RANGES[k][0] || n > RANGES[k][1]) {
          flags.push({ field: k, rule: `source_sanity_${RANGES[k][0]}_${RANGES[k][1]}`, value: v });
          data[k] = null;
        }
      }
      // anchor DCF/targets to price (0.2×–5×)
      if (data.price > 0) {
        ['dcfValue','targetMean','targetMedian','targetHigh','targetLow'].forEach(k => {
          if (data[k] != null && (data[k] < data.price*0.2 || data[k] > data.price*5)) {
            flags.push({ field:k, rule:'source_anchor_vs_price', value:data[k] });
            data[k] = null;
          }
        });
      }

      const missing = ['price','companyName'].filter(k => data[k] == null);
      const confidence = missing.length ? 'low' : (flags.length ? 'medium' : 'high');

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).json({
        data,
        quality: {
          flags,
          notes_ar: flags.length ? ['تم استبعاد بعض القيم غير المنطقية تلقائياً'] : [],
          confidence
        },
        cached: false,
        generated_at: todayUAE()
      });
    }

    // ── AI analysis phase-2 (?mode=lookup-analysis&sym=XXX) ──────────────────
    // Returns { analysis: "<arabic markdown>" } for the lookup card's AI section.
    // The dashboard parser expects: a "## ...الاستثمارية..." thesis paragraph,
    // a "نقاط القوة" bullet list, and a "نقاط الضعف"/"المخاطر" bullet list.
    if (req.query.mode === 'lookup-analysis') {
      const sym = (req.query.sym || '').toString().trim().toUpperCase();
      if (!sym) return res.status(400).json({ analysis_error: 'missing sym' });

      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) return res.status(200).json({ analysis_error: 'no_anthropic_key' });

      // gather the same fundamentals the lookup card uses
      const [quoteA, profileA, kmA, ptcA, ratingA, dcfA, growthA] = await Promise.all([
        fmpGet(`/quote?symbol=${sym}`),
        fmpGet(`/profile?symbol=${sym}`),
        fmpGet(`/key-metrics-ttm?symbol=${sym}`),
        fmpGet(`/price-target-consensus?symbol=${sym}`),
        fmpGet(`/ratings-snapshot?symbol=${sym}`),
        fmpGet(`/discounted-cash-flow?symbol=${sym}`),
        fmpGet(`/financial-growth?symbol=${sym}&limit=1`)
      ]);
      const q  = Array.isArray(quoteA)?quoteA[0]:quoteA;
      const p  = Array.isArray(profileA)?profileA[0]:profileA;
      const km = Array.isArray(kmA)?kmA[0]:kmA;
      const pt = Array.isArray(ptcA)?ptcA[0]:ptcA;
      const rt = Array.isArray(ratingA)?ratingA[0]:ratingA;
      const dcf= Array.isArray(dcfA)?dcfA[0]:dcfA;
      const gr = Array.isArray(growthA)?growthA[0]:growthA;

      const facts = {
        symbol: sym,
        name: (p && (p.companyName||p.name)) || sym,
        sector: p ? p.sector : null,
        price: q ? q.price : null,
        changePct: q ? (q.changePercentage ?? q.changesPercentage) : null,
        marketCap: (q && q.marketCap) ?? (p && p.marketCap) ?? null,
        beta: (p && p.beta) ?? null,
        roe: km && km.returnOnEquityTTM != null ? +(km.returnOnEquityTTM*100).toFixed(1) : null,
        revenueGrowth: gr && gr.revenueGrowth != null ? +(gr.revenueGrowth*100).toFixed(1) : null,
        targetMean: pt ? (pt.targetConsensus ?? pt.targetMean) : null,
        targetHigh: pt ? pt.targetHigh : null,
        targetLow: pt ? pt.targetLow : null,
        dcfValue: dcf ? dcf.dcf : null,
        analystRating: rt ? rt.rating : null
      };

      const prompt =
`أنت محلل مالي. حلّل سهم ${facts.name} (${sym}) لمستثمر إماراتي طويل الأمد.
البيانات:
${JSON.stringify(facts, null, 2)}

اكتب تحليلاً موجزاً بالعربية الفصحى بهذا التنسيق بالضبط:

## الفرضية الاستثمارية
فقرة واحدة (٣-٤ جمل) تلخّص القصة الاستثمارية بناءً على الأرقام أعلاه فقط.

نقاط القوة
- نقطة (جملة قصيرة مبنية على رقم محدد)
- نقطة
- نقطة

المخاطر
- نقطة
- نقطة
- نقطة

قواعد صارمة: استند فقط إلى الأرقام المعطاة. لا تخترع أرقاماً. إن كان رقم = null تجاهله. لا توصِ بشراء أو بيع. اجعل كل نقطة جملة واحدة قصيرة.`;

      try {
        const ar = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
          body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:900, messages:[{role:'user',content:prompt}] })
        });
        if (!ar.ok) {
          const errTxt = await ar.text();
          return res.status(200).json({ analysis_error: `anthropic_${ar.status}`, detail: errTxt.slice(0,200) });
        }
        const aj = await ar.json();
        const analysis = (aj.content || []).map(b => b.type === 'text' ? b.text : '').join('\n').trim();
        if (!analysis) return res.status(200).json({ analysis_error: 'empty_analysis' });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.status(200).json({ analysis, generated_at: todayUAE() });
      } catch (e) {
        return res.status(200).json({ analysis_error: e.message });
      }
    }

// ============================================================================
// SENTIMENT ENDPOINTS for portfolio-for-ai.js  (TEST FIRST, build cards after)
// Paste these two blocks alongside your other `if (mode === '...')` branches,
// AFTER the auth check but with the other mode branches.
// Both use your existing FMP_API_KEY env var.
// ============================================================================
//
// Your file already defines the FMP key. These blocks assume:
//   const FMP = process.env.FMP_API_KEY || process.env.FMP_KEY;
//   const FMP_BASE = 'https://financialmodelingprep.com/stable';
// If your file names them differently, adjust the two consts below to match.



// ─────────────────────────────────────────────────────────────────────────
// BLOCK B FINAL — mode=stock-sentiment  (two separate signals)
// Returns per symbol:
//   analyst: FMP analyst tone (changes + standing rating + target)
//   sa:      Seeking Alpha EPS-revisions + momentum grades (from sa-buckets)
// The card shows BOTH so conflicts (e.g. BMRN: analyst positive, SA revisions weak)
// are visible, not averaged away.
// Test: /api/portfolio-for-ai?mode=stock-sentiment&sym=NVDA,BMRN
// ─────────────────────────────────────────────────────────────────────────
  if (req.query.mode === 'stock-sentiment') {
    try {
      const FMP = process.env.FMP_API_KEY || process.env.FMP_KEY;
      const FMP_BASE = 'https://financialmodelingprep.com/stable';
      const REPO_RAW = 'https://raw.githubusercontent.com/ralyafei-source/theisilabs-portfolio/main';
      const debug = req.query.debug === '1';

      const RATING_TONE = (() => {
        const pos = ['strong buy','conviction buy','top pick','buy','accumulate','outperform','outperformer','overweight','sector outperform','market outperform','positive','above average','speculative buy','action list buy','sector overweight','in-line sector outperform'];
        const neg = ['strong sell','sell','reduce','underperform','underperformer','underweight','sector underperform','market underperform','below average','negative','cautious','sector underweight'];
        return label => { const l = String(label||'').toLowerCase().trim(); if(!l) return 0; if(pos.includes(l)) return 1; if(neg.includes(l)) return -1; return 0; };
      })();

      // grade letter → tone (+1 best .. -1 worst), for SA EPS-revisions / momentum
      const GRADE_TONE = g => {
        const m = { 'A+':1,'A':0.9,'A-':0.8,'B+':0.5,'B':0.4,'B-':0.3,'C+':0.0,'C':-0.05,'C-':-0.1,'D+':-0.4,'D':-0.5,'D-':-0.6,'F':-1 };
        return (g!=null && m[String(g).toUpperCase()]!=null) ? m[String(g).toUpperCase()] : null;
      };

      // resolve symbols
      let symbols = [];
      if (req.query.sym) {
        symbols = String(req.query.sym).toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
      } else {
        const nick = (req.query.nickname || 'rashed').toLowerCase();
        const pfPath = nick === 'rashed' ? 'data/portfolio.json' : `data/portfolio-${nick}.json`;
        try { const pr = await fetch(`${REPO_RAW}/${pfPath}?t=${Date.now()}`); if (pr.ok) { const pd = await pr.json(); const hold = pd.holdings || pd.stocks || []; symbols = hold.map(h => (h.sym||'').toUpperCase()).filter(Boolean); } } catch {}
      }
      if (!symbols.length) return res.status(200).json({ error: 'no symbols', hint: 'pass &sym=NVDA or &nickname=' });
      symbols = symbols.slice(0, 50);

      // load SA buckets once (today, else most-recent prior) for the SA signal
      let scored = {};
      try {
        const today = new Date().toISOString().slice(0,10);
        let br = await fetch(`${REPO_RAW}/data/sa-buckets-${today}.json?t=${Date.now()}`);
        let bd = br.ok ? await br.json() : null;
        if (!bd || !bd.scored) {
          // walk back up to ~10 days
          for (let i=1;i<=10 && (!bd||!bd.scored);i++){
            const d = new Date(Date.now()-i*86400000).toISOString().slice(0,10);
            const r2 = await fetch(`${REPO_RAW}/data/sa-buckets-${d}.json?t=${Date.now()}`);
            if (r2.ok){ const j=await r2.json(); if(j&&j.scored){bd=j;break;} }
          }
        }
        scored = (bd && bd.scored) || {};
      } catch {}

      const since = new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
      const out = [];
      let debugRaw = null;

      for (const sym of symbols) {
        // ── analyst (FMP) ──
        let up=0, down=0, total90=0, returned=0, toneSum=0, toneCount=0;
        try {
          const gr = await fetch(`${FMP_BASE}/grades?symbol=${sym}&limit=100&apikey=${FMP}`);
          if (gr.ok) {
            const arr = await gr.json(); const a = Array.isArray(arr)?arr:[];
            returned = a.length;
            if (debug && !debugRaw && a.length) debugRaw = a[0];
            for (const g of a) {
              const d = String(g.date||g.publishedDate||g.gradeDate||'').slice(0,10);
              if(!d||d<since) continue;
              total90++;
              const act = String(g.action||'').toLowerCase().trim();
              if(act==='upgrade') up++; else if(act==='downgrade') down++;
              const t = RATING_TONE(g.newGrade); if(t!==0){ toneSum+=t; toneCount++; }
            }
          }
        } catch {}
        const toneAvg = toneCount ? toneSum/toneCount : null;
        let targetUpside = null;
        try {
          const tr = await fetch(`${FMP_BASE}/price-target-consensus?symbol=${sym}&apikey=${FMP}`);
          if (tr.ok) { const tj = await tr.json(); const t = Array.isArray(tj)?tj[0]:tj;
            const qr2 = await fetch(`${FMP_BASE}/quote-short?symbol=${sym}&apikey=${FMP}`);
            const qj2 = qr2.ok?await qr2.json():[]; const price = Array.isArray(qj2)&&qj2[0]?Number(qj2[0].price):null;
            const tgt = t?Number(t.targetConsensus||t.targetMedian||t.targetMean):null;
            if(price&&tgt) targetUpside = +(((tgt-price)/price)*100).toFixed(1);
          }
        } catch {}
        let aScore = 0;
        aScore += (up-down)*25;
        if(toneAvg!=null) aScore += Math.round(toneAvg*35);
        if(targetUpside!=null) aScore += Math.max(-15,Math.min(15,targetUpside/4));
        aScore = Math.max(-100,Math.min(100,Math.round(aScore)));
        const aSent = aScore>20?'positive':aScore<-20?'negative':'neutral';
        const aSent_ar = aScore>20?'إيجابي':aScore<-20?'سلبي':'محايد';

        // ── SA (EPS revisions + momentum) ──
        const o = scored[sym] || null;
        const Rg = o && o.grades ? o.grades.R : null;   // EPS revisions
        const Mg = o && o.grades ? o.grades.M : null;   // momentum
        const rTone = GRADE_TONE(Rg), mTone = GRADE_TONE(Mg);
        let saScore = null, saSent = null, saSent_ar = null;
        if (rTone!=null || mTone!=null) {
          const parts = []; if(rTone!=null) parts.push(rTone*0.65); if(mTone!=null) parts.push(mTone*0.35);
          const norm = (rTone!=null?0.65:0)+(mTone!=null?0.35:0);
          saScore = Math.round((parts.reduce((a,b)=>a+b,0)/norm)*100);
          saSent = saScore>20?'positive':saScore<-20?'negative':'neutral';
          saSent_ar = saScore>20?'إيجابي':saScore<-20?'سلبي':'محايد';
        }

        const conflict = (saSent && aSent && saSent!=='neutral' && aSent!=='neutral' && saSent!==aSent);

        out.push({
          sym,
          analyst: { sentiment:aSent, sentiment_ar:aSent_ar, score:aScore, upgrades90d:up, downgrades90d:down, ratingsIn90d:total90, standingTone: toneAvg!=null?+toneAvg.toFixed(2):null, targetUpsidePct:targetUpside },
          sa: { sentiment:saSent, sentiment_ar:saSent_ar, score:saScore, epsRevisions:Rg, momentum:Mg, hasData: o!=null },
          conflict
        });
      }

      const resp = { data: out, count: out.length, asOf: new Date().toISOString().slice(0,10) };
      if (debug) resp.debug_first_grade_record = debugRaw;
      return res.status(200).json(resp);
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }
    
    // ── Live prices (Yahoo Finance) ──────────────────────────────────────────
    const priceMap = {};
    const priceResults = await Promise.all(
      symbols.map(async sym => {
        try {
          const r = await fetch(
            `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
            { headers: { 'User-Agent': UA } }
          );
          if (!r.ok) return { sym, price: null };
          const d = await r.json();
          const meta = d?.chart?.result?.[0]?.meta;
          return { sym, price: meta?.regularMarketPrice || null, prev: meta?.chartPreviousClose || null };
        } catch { return { sym, price: null }; }
      })
    );
    priceResults.forEach(({ sym, price, prev }) => { priceMap[sym] = { price, prev }; });

    // ── Calculate totals ─────────────────────────────────────────────────────
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const q = priceMap[h.sym] || {};
      const price = q.price || h.cost;
      const value = Math.round(h.shares * price);
      const glPct = ((price - h.cost) / h.cost * 100);
      const dayPct = q.prev ? +(((price - q.prev) / q.prev) * 100).toFixed(2) : null;
      totalValue += value;
      return { ...h, livePrice: price, value, glPct, dayPct };
    });
    enriched.sort((a, b) => b.value - a.value);

    // ── Group by sector ──────────────────────────────────────────────────────
    const sectors = {
      tech:   { label: 'TECHNOLOGY',  items: [] },
      spec:   { label: 'SPECULATIVE', items: [] },
      bio:    { label: 'BIOTECH',     items: [] },
      mining: { label: 'MINING',      items: [] },
      etf:    { label: 'ETFs',        items: [] },
      other:  { label: 'OTHER',       items: [] },
    };
    enriched.forEach(h => { (sectors[h.sector] || sectors.other).items.push(h); });

    // ── Format portfolio text ────────────────────────────────────────────────
    const pricesAvailable = Object.values(priceMap).filter(q => q && q.price).length;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    let text = '';
    text += `═══════════════════════════════════════════════════════\n`;
    text += `${investorName.toUpperCase()}'S PORTFOLIO — Live as of ${timestamp}\n`;
    text += `Total Value: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
    text += `Live prices: ${pricesAvailable}/${symbols.length} stocks updated\n`;
    text += `═══════════════════════════════════════════════════════\n`;

    if (!isGenericUser) {
      text += `INVESTOR RULES (apply to all recommendations):\n`;
      text += `- UAE investor — ZERO capital gains tax on profits\n`;
      text += `- Cannot short sell or trade options (Wio Invest)\n`;
      text += `- SPUS = Sharia-compliant ETF — never recommend selling\n`;
      text += `- US market opens 5:30pm UAE time\n`;
      text += `- Long-term growth investor, high risk tolerance\n`;
    } else {
      text += `INVESTOR: ${investorName}, UAE investor\n`;
      text += `- Long-term growth focus\n`;
    }
    text += `═══════════════════════════════════════════════════════\n\n`;

    Object.values(sectors).forEach(sec => {
      if (sec.items.length === 0) return;
      text += `${sec.label}:\n`;
      sec.items.forEach(h => {
        const glSign = h.glPct >= 0 ? '+' : '';
        text += `${h.sym.padEnd(6)} ${String(h.shares).padEnd(10)} sh  `;
        text += `cost $${String(h.cost.toFixed(2)).padEnd(8)}  `;
        text += `now $${String(h.livePrice.toFixed(2)).padEnd(8)}  `;
        text += `value $${h.value.toLocaleString().padEnd(8)}  `;
        text += `${glSign}${h.glPct.toFixed(1)}%\n`;
      });
      text += '\n';
    });

    text += `═══════════════════════════════════════════════════════\n`;
    text += `TOTAL PORTFOLIO VALUE: $${totalValue.toLocaleString()}\n`;
    if (!isGenericUser && cash.fresh_cash_deposited) {
      const roi = (((totalValue - cash.fresh_cash_deposited) / cash.fresh_cash_deposited) * 100).toFixed(1);
      text += `Return on cash invested: +${roi}%\n`;
    }
    text += `═══════════════════════════════════════════════════════\n`;

    // ── Market Intelligence (only when ?include=intelligence) ────────────────
    if (wantIntelligence) {

      // Read today's market movers from saved market-data file
      let moverSyms = [];
      try {
        const mdr = await fetch(
          `https://raw.githubusercontent.com/${REPO}/main/data/market-data-${todayUAE()}.json?t=${Date.now()}`
        );
        if (mdr.ok) {
          const md   = await mdr.json();
          const str  = typeof md === 'string' ? md : JSON.stringify(md);
          const matches = str.match(/"ticker"\s*:\s*"([A-Z]{1,6})"/g) || [];
          moverSyms = [...new Set(
            matches.map(m => m.match(/"([A-Z]{1,6})"/)?.[1]).filter(Boolean)
          )].slice(0, 20);
        }
      } catch { /* market data not yet available — skip */ }

      // Top 10 non-ETF holdings for per-symbol analyst calls
      const ETF_LIST = new Set(["QQQ","SPY","VGT","SPUS","VOO","XLP","IVV","SMH","IBIT","QQQM"]);
      const top10 = enriched.filter(h => !ETF_LIST.has(h.sym)).slice(0, 10).map(h => h.sym);

      // All portfolio symbols for technical indicators (including ETFs)
      const allSyms = [...new Set([...symbols, ...moverSyms])];

      // ── Fetch everything in parallel ─────────────────────────────────────
      // Analyst data: top 10 non-ETF stocks only (per-symbol calls)
      // Technical indicators: ALL portfolio symbols (per-symbol calls, run in parallel)
      const [
        earningsRaw,
        targetResults,
        gradeResults,
        metricResults,
        rsiResults,
        macdResults,
        sma50Results,
        sma200Results,
        ema20Results,
        bbResults
      ] = await Promise.all([

        // Analyst & fundamental data
        fmpGet(`/earnings-calendar?from=${todayUAE()}&to=${daysAheadUAE(60)}&symbol=${allSyms.join(',')}`),
        Promise.all(top10.map(sym => fmpGet(`/price-target-consensus?symbol=${sym}`))),
        Promise.all(top10.map(sym => fmpGet(`/grades?symbol=${sym}&limit=3`))),
        Promise.all(top10.map(sym => fmpGet(`/key-metrics-ttm?symbol=${sym}`))),

        // Technical indicators — ALL portfolio stocks
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/rsi?symbol=${sym}&periodLength=14&timeframe=1day&limit=1`)
            .then(d => ({ sym, rsi: latest(d, 'rsi') }))
        )),
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/macd?symbol=${sym}&fastPeriod=12&slowPeriod=26&signalPeriod=9&timeframe=1day&limit=1`)
            .then(d => ({ sym, macd: latest(d, 'macd'), signal: latest(d, 'signal'), histogram: latest(d, 'histogram') }))
        )),
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=50&timeframe=1day&limit=1`)
            .then(d => ({ sym, sma50: latest(d, 'sma') }))
        )),
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=200&timeframe=1day&limit=1`)
            .then(d => ({ sym, sma200: latest(d, 'sma') }))
        )),
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/ema?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`)
            .then(d => ({ sym, ema20: latest(d, 'ema') }))
        )),
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/standardDeviation?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`)
            .then(d => ({ sym, stddev: latest(d, 'standardDeviation') }))
        ))

      ]);

      // ── Build technical signals summary per stock ─────────────────────────
      const techMap = {};
      symbols.forEach(sym => { techMap[sym] = {}; });

      rsiResults.forEach(   ({ sym, rsi })                     => { if (techMap[sym]) techMap[sym].rsi = rsi !== null ? +rsi.toFixed(2) : null; });
      macdResults.forEach(  ({ sym, macd, signal, histogram }) => {
        if (techMap[sym]) {
          techMap[sym].macd      = macd      !== null ? +macd.toFixed(4)      : null;
          techMap[sym].signal    = signal    !== null ? +signal.toFixed(4)    : null;
          techMap[sym].histogram = histogram !== null ? +histogram.toFixed(4) : null;
        }
      });
      sma50Results.forEach( ({ sym, sma50 })  => { if (techMap[sym]) techMap[sym].sma50  = sma50  !== null ? +sma50.toFixed(2)  : null; });
      sma200Results.forEach(({ sym, sma200 }) => { if (techMap[sym]) techMap[sym].sma200 = sma200 !== null ? +sma200.toFixed(2) : null; });
      ema20Results.forEach( ({ sym, ema20 })  => { if (techMap[sym]) techMap[sym].ema20  = ema20  !== null ? +ema20.toFixed(2)  : null; });
      bbResults.forEach(    ({ sym, stddev }) => {
        if (techMap[sym] && stddev !== null && priceMap[sym]?.price) {
          const mid = techMap[sym].sma20 || priceMap[sym].price;
          techMap[sym].bb_upper = +(priceMap[sym].price + 2 * stddev).toFixed(2);
          techMap[sym].bb_lower = +(priceMap[sym].price - 2 * stddev).toFixed(2);
          techMap[sym].bb_stddev = +stddev.toFixed(4);
        }
      });

      // ── Add plain-language signal interpretation ──────────────────────────
      Object.entries(techMap).forEach(([sym, t]) => {
        const price = priceMap[sym]?.price;
        const signals = [];

        if (t.rsi !== null) {
          if (t.rsi > 70)      signals.push(`RSI ${t.rsi} — OVERBOUGHT`);
          else if (t.rsi < 30) signals.push(`RSI ${t.rsi} — OVERSOLD`);
          else                 signals.push(`RSI ${t.rsi} — neutral`);
        }

        if (t.macd !== null && t.signal !== null) {
          if (t.macd > t.signal && t.histogram > 0) signals.push('MACD bullish crossover ↑');
          else if (t.macd < t.signal && t.histogram < 0) signals.push('MACD bearish crossover ↓');
          else signals.push('MACD neutral');
        }

        if (t.sma50 !== null && t.sma200 !== null) {
          if (t.sma50 > t.sma200) signals.push('Golden Cross ✅ (SMA50 > SMA200)');
          else signals.push('Death Cross ⚠️ (SMA50 < SMA200)');
        }

        if (price && t.ema20 !== null) {
          if (price > t.ema20) signals.push(`Price above EMA20 (${t.ema20}) — short-term bullish`);
          else signals.push(`Price below EMA20 (${t.ema20}) — short-term bearish`);
        }

        if (t.bb_upper && t.bb_lower && price) {
          const bbWidth = t.bb_upper - t.bb_lower;
          if (price >= t.bb_upper)      signals.push(`At BB upper band (${t.bb_upper}) — extended`);
          else if (price <= t.bb_lower) signals.push(`At BB lower band (${t.bb_lower}) — compressed`);
          else {
            const bbPct = ((price - t.bb_lower) / bbWidth * 100).toFixed(0);
            signals.push(`BB position: ${bbPct}% (lower=${t.bb_lower}, upper=${t.bb_upper})`);
          }
        }

        t.signals = signals;
      });

      // ── Flatten analyst results ───────────────────────────────────────────
      const earnings = earningsRaw || [];
      const targets  = targetResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));
      const grades   = gradeResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));
      const metrics  = metricResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));

      const earningsSorted = (earnings || []).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}))
        .sort((a, b) => {
          if (a.inPortfolio && !b.inPortfolio) return -1;
          if (!a.inPortfolio && b.inPortfolio) return 1;
          return new Date(a.date) - new Date(b.date);
        });

      // ── Append intelligence block ─────────────────────────────────────────
      text += `\n═══════════════════════════════════════════════════════\n`;
      text += `MARKET INTELLIGENCE — ${todayUAE()}\n`;
      text += `Portfolio symbols: ${symbols.join(', ')}\n`;
      text += `Market movers tracked: ${moverSyms.join(', ') || 'none yet'}\n`;
      text += `═══════════════════════════════════════════════════════\n\n`;

      // Technical indicators — formatted as a readable table for Claude
      text += `TECHNICAL INDICATORS (all ${symbols.length} portfolio stocks):\n`;
      text += `${'SYM'.padEnd(7)} ${'RSI'.padEnd(8)} ${'MACD'.padEnd(10)} ${'SMA50'.padEnd(9)} ${'SMA200'.padEnd(9)} ${'EMA20'.padEnd(9)} BB_UPPER / BB_LOWER\n`;
      text += `─────────────────────────────────────────────────────────────────────────────\n`;
      symbols.forEach(sym => {
        const t = techMap[sym];
        text += `${sym.padEnd(7)} `;
        text += `${(t.rsi    !== null ? String(t.rsi)    : 'N/A').padEnd(8)} `;
        text += `${(t.macd   !== null ? String(t.macd)   : 'N/A').padEnd(10)} `;
        text += `${(t.sma50  !== null ? String(t.sma50)  : 'N/A').padEnd(9)} `;
        text += `${(t.sma200 !== null ? String(t.sma200) : 'N/A').padEnd(9)} `;
        text += `${(t.ema20  !== null ? String(t.ema20)  : 'N/A').padEnd(9)} `;
        text += `${t.bb_upper || 'N/A'} / ${t.bb_lower || 'N/A'}\n`;
      });
      text += `\n`;

      // Signal interpretation — plain English for Claude
      text += `SIGNAL INTERPRETATION:\n`;
      symbols.forEach(sym => {
        const t = techMap[sym];
        if (t.signals && t.signals.length > 0) {
          text += `${sym}: ${t.signals.join(' | ')}\n`;
        }
      });
      text += `\n`;

      text += `EARNINGS CALENDAR (next 60 days — portfolio stocks first):\n`;
      text += JSON.stringify({
        portfolio: earningsSorted.filter(e => e.inPortfolio),
        movers:    earningsSorted.filter(e => !e.inPortfolio).slice(0, 10)
      }, null, 2) + '\n\n';

      text += `ANALYST PRICE TARGETS:\n`;
      text += JSON.stringify(targets, null, 2) + '\n\n';

      text += `ANALYST GRADES (recent):\n`;
      text += JSON.stringify(grades, null, 2) + '\n\n';

      text += `KEY METRICS TTM (P/E, ROE, margins etc):\n`;
      text += JSON.stringify(metrics, null, 2) + '\n';

      text += `\n═══════════════════════════════════════════════════════\n`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch (e) {
    res.status(500).send(`Portfolio data unavailable: ${e.message}`);
  }
};
