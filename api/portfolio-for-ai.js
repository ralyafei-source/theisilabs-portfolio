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
// BLOCK A — mode=sentiment  →  Fear & Greed gauge from VIX
// Test URL after deploy:  /api/portfolio-for-ai?mode=sentiment
// Returns: { score, label, label_ar, vix, vixPercentile, asOf }
// ─────────────────────────────────────────────────────────────────────────
  if (req.query.mode === 'sentiment') {
    try {
      const FMP = process.env.FMP_API_KEY || process.env.FMP_KEY;
      const FMP_BASE = 'https://financialmodelingprep.com/stable';

      // current VIX
      const qr = await fetch(`${FMP_BASE}/quote?symbol=^VIX&apikey=${FMP}`);
      const qj = qr.ok ? await qr.json() : [];
      const vixNow = Array.isArray(qj) && qj[0] ? Number(qj[0].price) : null;

      // ~1y VIX history for percentile context
      const hr = await fetch(`${FMP_BASE}/historical-price-eod/light?symbol=^VIX&apikey=${FMP}`);
      const hj = hr.ok ? await hr.json() : null;
      // FMP may return {historical:[...]} or a bare array; handle both
      const hist = Array.isArray(hj) ? hj : (hj && Array.isArray(hj.historical) ? hj.historical : []);
      const closes = hist.map(d => Number(d.price != null ? d.price : d.close)).filter(v => isFinite(v)).slice(0, 252);

      if (vixNow == null || !closes.length) {
        return res.status(200).json({ error: 'VIX data unavailable', vixNow, histCount: closes.length, rawQuote: qj, rawHistType: typeof hj });
      }

      // percentile of current VIX within the trailing window
      const below = closes.filter(v => v < vixNow).length;
      const vixPct = below / closes.length; // 0..1, high = VIX elevated = more fear
      // invert: high VIX -> fear (low score); low VIX -> greed (high score)
      const score = Math.round((1 - vixPct) * 100);

      const label = score < 25 ? 'Extreme Fear' : score < 45 ? 'Fear' : score < 55 ? 'Neutral' : score < 75 ? 'Greed' : 'Extreme Greed';
      const label_ar = score < 25 ? 'خوف شديد' : score < 45 ? 'خوف' : score < 55 ? 'محايد' : score < 75 ? 'جشع' : 'جشع شديد';

      return res.status(200).json({
        score, label, label_ar,
        vix: +vixNow.toFixed(2),
        vixPercentile: +(vixPct * 100).toFixed(0),
        windowDays: closes.length,
        asOf: new Date().toISOString().slice(0, 10),
        method: 'VIX percentile (inverted) over trailing window'
      });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }


// ─────────────────────────────────────────────────────────────────────────
// BLOCK B v3 (FINAL) — mode=stock-sentiment
// Fix over v2: heavily-covered stocks (NVDA) get mostly "maintain" actions, so
// up/down changes alone read flat. v3 ALSO scores the standing rating LEVEL of
// recent actions (a wall of "maintain Buy/Overweight" is bullish; "maintain Sell"
// bearish). Three signals now: (1) rating changes, (2) standing rating tone,
// (3) target upside — combined and capped.
// Test: /api/portfolio-for-ai?mode=stock-sentiment&sym=NVDA&debug=1
// ─────────────────────────────────────────────────────────────────────────
  if (req.query.mode === 'stock-sentiment') {
    try {
      const FMP = process.env.FMP_API_KEY || process.env.FMP_KEY;
      const FMP_BASE = 'https://financialmodelingprep.com/stable';
      const debug = req.query.debug === '1';

      // map a rating label → tone (+1 bullish .. -1 bearish)
      const RATING_TONE = (() => {
        const pos = ['strong buy','conviction buy','top pick','buy','accumulate','outperform','outperformer','overweight','sector outperform','market outperform','positive','above average','speculative buy','action list buy','buy','sector overweight','in-line sector outperform'];
        const neg = ['strong sell','sell','reduce','underperform','underperformer','underweight','sector underperform','market underperform','below average','negative','cautious','sector underweight'];
        return label => {
          const l = String(label || '').toLowerCase().trim();
          if (!l) return 0;
          if (pos.includes(l)) return 1;
          if (neg.includes(l)) return -1;
          return 0; // hold / neutral / market perform / equal-weight / mixed / peer perform
        };
      })();

      let symbols = [];
      if (req.query.sym) {
        symbols = String(req.query.sym).toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
      } else {
        const nick = (req.query.nickname || 'rashed').toLowerCase();
        const REPO_RAW = 'https://raw.githubusercontent.com/ralyafei-source/theisilabs-portfolio/main';
        const pfPath = nick === 'rashed' ? 'data/portfolio.json' : `data/portfolio-${nick}.json`;
        try {
          const pr = await fetch(`${REPO_RAW}/${pfPath}?t=${Date.now()}`);
          if (pr.ok) { const pd = await pr.json(); const hold = pd.holdings || pd.stocks || []; symbols = hold.map(h => (h.sym || '').toUpperCase()).filter(Boolean); }
        } catch {}
      }
      if (!symbols.length) return res.status(200).json({ error: 'no symbols', hint: 'pass &sym=NVDA or &nickname=' });
      symbols = symbols.slice(0, 50);

      const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      const out = [];
      let debugRaw = null;

      for (const sym of symbols) {
        let up = 0, down = 0, total90 = 0, returned = 0;
        let toneSum = 0, toneCount = 0; // standing rating tone across recent actions
        try {
          const gr = await fetch(`${FMP_BASE}/grades?symbol=${sym}&limit=100&apikey=${FMP}`);
          if (gr.ok) {
            const gj = await gr.json();
            const arr = Array.isArray(gj) ? gj : [];
            returned = arr.length;
            if (debug && !debugRaw && arr.length) debugRaw = arr[0];
            for (const g of arr) {
              const d = String(g.date || g.publishedDate || g.gradeDate || '').slice(0, 10);
              if (!d || d < since) continue;
              total90++;
              const action = String(g.action || '').toLowerCase().trim();
              if (action === 'upgrade') up++;
              else if (action === 'downgrade') down++;
              // standing tone from the NEW grade (covers maintains + changes)
              const t = RATING_TONE(g.newGrade);
              if (t !== 0) { toneSum += t; toneCount++; }
            }
          }
        } catch {}
        const toneAvg = toneCount ? (toneSum / toneCount) : null; // -1..+1

        // target vs price (secondary, capped)
        let targetUpside = null;
        try {
          const tr = await fetch(`${FMP_BASE}/price-target-consensus?symbol=${sym}&apikey=${FMP}`);
          if (tr.ok) {
            const tj = await tr.json();
            const t = Array.isArray(tj) ? tj[0] : tj;
            const qr2 = await fetch(`${FMP_BASE}/quote-short?symbol=${sym}&apikey=${FMP}`);
            const qj2 = qr2.ok ? await qr2.json() : [];
            const price = Array.isArray(qj2) && qj2[0] ? Number(qj2[0].price) : null;
            const tgt = t ? Number(t.targetConsensus || t.targetMedian || t.targetMean) : null;
            if (price && tgt) targetUpside = +(((tgt - price) / price) * 100).toFixed(1);
          }
        } catch {}

        // blend: changes (strong) + standing tone (medium) + target (weak, capped)
        let score = 0;
        score += (up - down) * 25;                                  // rating changes
        if (toneAvg != null) score += Math.round(toneAvg * 35);     // standing consensus tone
        if (targetUpside != null) score += Math.max(-15, Math.min(15, targetUpside / 4)); // target, capped
        score = Math.max(-100, Math.min(100, Math.round(score)));
        const sentiment = score > 20 ? 'positive' : score < -20 ? 'negative' : 'neutral';
        const sentiment_ar = score > 20 ? 'إيجابي' : score < -20 ? 'سلبي' : 'محايد';

        out.push({ sym, sentiment, sentiment_ar, score, signals: {
          upgrades90d: up, downgrades90d: down, ratingsIn90d: total90,
          standingTone: toneAvg != null ? +toneAvg.toFixed(2) : null,
          targetUpsidePct: targetUpside, gradesReturned: returned
        }});
      }

      const resp = { data: out, count: out.length, asOf: new Date().toISOString().slice(0, 10) };
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
          return { sym, price: d?.chart?.result?.[0]?.meta?.regularMarketPrice || null };
        } catch { return { sym, price: null }; }
      })
    );
    priceResults.forEach(({ sym, price }) => { priceMap[sym] = price; });

    // ── Calculate totals ─────────────────────────────────────────────────────
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price = priceMap[h.sym] || h.cost;
      const value = Math.round(h.shares * price);
      const glPct = ((price - h.cost) / h.cost * 100);
      totalValue += value;
      return { ...h, livePrice: price, value, glPct };
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
    const pricesAvailable = Object.values(priceMap).filter(Boolean).length;
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
        if (techMap[sym] && stddev !== null && priceMap[sym]) {
          const mid = techMap[sym].sma20 || priceMap[sym];
          techMap[sym].bb_upper = +(priceMap[sym] + 2 * stddev).toFixed(2);
          techMap[sym].bb_lower = +(priceMap[sym] - 2 * stddev).toFixed(2);
          techMap[sym].bb_stddev = +stddev.toFixed(4);
        }
      });

      // ── Add plain-language signal interpretation ──────────────────────────
      Object.entries(techMap).forEach(([sym, t]) => {
        const price = priceMap[sym];
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
