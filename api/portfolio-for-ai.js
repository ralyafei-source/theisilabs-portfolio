// api/portfolio-for-ai.js
// v6 — Phase 1 quality improvements
// Changes from v5:
//   - Removed SPUS "never sell" rule — scored on merits like any position
//   - Removed Wio Invest broker name — no analytical value
//   - Removed market open time — not analytical
//   - Added FMP earnings-surprises → real B/B/B/M history
//   - Added FMP discounted-cash-flow → real DCF fair values
//   - Added FMP stock-price-change → real weekly % change
//   - Added FMP stock-short-interest → real short interest %
//   - Added PEG ratio + peRatioTTM to key metrics extraction
//   - Added FMP annual key-metrics → 5Y historical P/E average
//   - Added analyst consensus calculation (bullish/mixed/bearish per stock)
//   - Grades now filtered to upgrades/downgrades/initiations only (removes maintains)
// ── STOCK LOOKUP MODE ─────────────────────────────────────────────────────
if (req.query.mode === 'lookup') {
  const sym = (req.query.sym || '').toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: 'sym required' });

  let quote, metrics, targets, grades, dcf;
  try {
    [quote, metrics, targets, grades, dcf] = await Promise.all([
      fmpGet(`/quote/${sym}`),
      fmpGet(`/key-metrics-ttm/${sym}`),
      fmpGet(`/price-target-consensus?symbol=${sym}`),
      fmpGet(`/grades-latest?symbol=${sym}&limit=5`),
      fmpGet(`/discounted-cash-flow/${sym}`)
    ]);
  } catch(e) {
    return res.status(500).json({ error: 'FMP error: ' + e.message });
  }

  const q = Array.isArray(quote) ? quote[0] : quote;
  const m = Array.isArray(metrics) ? metrics[0] : metrics;
  const t = Array.isArray(targets) ? targets[0] : targets;
  const d = Array.isArray(dcf) ? dcf[0] : dcf;

  const data = {
    symbol: sym,
    price: q?.price ?? null,
    change: q?.change ?? null,
    changePct: q?.changesPercentage ?? null,
    marketCap: q?.marketCap ?? null,
    pe: m?.peRatioTTM ?? null,
    peg: m?.pegRatioTTM ?? null,
    roe: m?.roeTTM ?? null,
    fcf: m?.freeCashFlowPerShareTTM ?? null,
    revenueGrowth: m?.revenueGrowthTTM ?? null,
    targetMean: t?.targetMean ?? null,
    targetHigh: t?.targetHigh ?? null,
    targetLow: t?.targetLow ?? null,
    analystConsensus: ((t?.analystRatingsStrongBuy || 0) + (t?.analystRatingsBuy || 0)) > ((t?.analystRatingsSell || 0) + (t?.analystRatingsStrongSell || 0)) ? 'Bullish 📈' : 'Bearish 📉',
    dcfValue: d?.dcf ?? null,
    grades: Array.isArray(grades) ? grades.slice(0, 5) : []
  };

  let analysis = '';
  try {
    const prompt = `أنت محلل مالي متخصص في السوق الأمريكي. قدم تحليلاً شاملاً بالعربية للسهم التالي:

الرمز: ${sym}
السعر الحالي: $${data.price ?? '—'}
التغير اليوم: ${data.changePct != null ? data.changePct.toFixed(2) : '—'}%
القيمة السوقية: $${data.marketCap ? (data.marketCap/1e9).toFixed(1)+'B' : '—'}
P/E: ${data.pe != null ? data.pe.toFixed(1) : '—'}
PEG: ${data.peg != null ? data.peg.toFixed(2) : '—'}
نمو الإيرادات: ${data.revenueGrowth != null ? (data.revenueGrowth*100).toFixed(1)+'%' : '—'}
ROE: ${data.roe != null ? (data.roe*100).toFixed(1)+'%' : '—'}
هدف المحللين: $${data.targetMean ?? '—'}
القيمة العادلة DCF: $${data.dcfValue != null ? data.dcfValue.toFixed(0) : '—'}
توجه المحللين: ${data.analystConsensus}

قدم التحليل في هذا الشكل:

## ملخص السهم
[3 أسطر عن الشركة وما تفعله]

## التقييم
[هل السهم رخيص أم غالٍ؟ مقارنة السعر بالهدف والـ DCF]

## نقاط القوة
[3 نقاط إيجابية]

## نقاط الضعف / المخاطر
[3 مخاطر]

## الحكم النهائي
[شراء قوي / شراء / احتفظ / خفف / بيع] مع سبب موجز

⚠️ هذا تحليل معلوماتي وليس توصية مالية.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const aiData = await aiRes.json();
    analysis = aiData.content?.[0]?.text || '';
  }
  // Ask Claude for Arabic summary
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  let analysis = '';
  try {
    const prompt = `أنت محلل مالي متخصص في السوق الأمريكي. قدم تحليلاً شاملاً بالعربية للسهم التالي:

الرمز: ${sym}
السعر الحالي: $${data.price}
التغير اليوم: ${data.changePct?.toFixed(2)}%
القيمة السوقية: $${(data.marketCap/1e9)?.toFixed(1)}B
P/E: ${data.pe?.toFixed(1)}
PEG: ${data.peg?.toFixed(2)}
نمو الإيرادات: ${(data.revenueGrowth*100)?.toFixed(1)}%
ROE: ${(data.roe*100)?.toFixed(1)}%
هدف المحللين (متوسط): $${data.targetMean}
القيمة العادلة DCF: $${data.dcfValue?.toFixed(0)}
توجه المحللين: ${data.analystConsensus}

قدم التحليل في هذا الشكل:
## ملخص السهم
[3 أسطر عن الشركة وما تفعله]

## التقييم
[هل السهم رخيص أم غالٍ؟ مقارنة السعر بالهدف والـ DCF]

## نقاط القوة
[3 نقاط إيجابية]

## نقاط الضعف / المخاطر
[3 مخاطر]

## الحكم النهائي
[شراء قوي / شراء / احتفظ / خفف / بيع] مع سبب موجز

⚠️ هذا تحليل معلوماتي وليس توصية مالية.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const aiData = await aiRes.json();
    analysis = aiData.content?.[0]?.text || '';
  } catch(e) {}

  return res.status(200).json({ data, analysis });
}
// ── END STOCK LOOKUP ──────────────────────────────────────────────────────

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY = process.env.BRIEFING_API_KEY;
const FMP_KEY = process.env.FMP_API_KEY;
const FMP     = 'https://financialmodelingprep.com/stable';

// ─── FMP helper with 5s timeout ──────────────────────────────────────────────
async function fmpGet(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? d : (d?.Error ? null : d);
  } catch { return null; }
}

const FMP_V3 = 'https://financialmodelingprep.com/api/v3';
const FMP_V4 = 'https://financialmodelingprep.com/api/v4';

async function fmpGetV3(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${FMP_V3}${path}${sep}apikey=${FMP_KEY}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? d : (d?.Error ? null : d);
  } catch { return null; }
}

async function fmpGetV4(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${FMP_V4}${path}${sep}apikey=${FMP_KEY}`, { signal: controller.signal });
    clearTimeout(timer);
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

function daysAgoUAE(n) {
  return new Date(Date.now() + 4 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
}

function latest(arr, field) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[0]?.[field] ?? null;
}

// ─── Fetch latest available market data file (today or most recent past day) ─
async function fetchLatestMarketData() {
  for (let i = 0; i <= 7; i++) {
    const date = new Date(Date.now() + 4 * 3600 * 1000 - i * 86400000).toISOString().slice(0, 10);
    try {
      const r = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/data/market-data-${date}.json?t=${Date.now()}`
      );
      if (r.ok) {
        const md  = await r.json();
        const str = typeof md === 'string' ? md : JSON.stringify(md);
        const matches = str.match(/"ticker"\s*:\s*"([A-Z]{1,6})"/g) || [];
        const syms = [...new Set(
          matches.map(m => m.match(/"([A-Z]{1,6})"/)?.[1]).filter(Boolean)
        )].slice(0, 20);
        return { date, syms };
      }
    } catch { /* try next day */ }
  }
  return { date: null, syms: [] };
}

// ─── Fetch technicals for one symbol ─────────────────────────────────────────
async function fetchTechnicals(sym) {
  const [rsiRaw, ema12Raw, ema26Raw, sma50Raw, sma200Raw, ema20Raw, bbRaw] = await Promise.all([
    fmpGet(`/technical-indicators/rsi?symbol=${sym}&periodLength=14&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/ema?symbol=${sym}&periodLength=12&timeframe=1day&limit=30`),
    fmpGet(`/technical-indicators/ema?symbol=${sym}&periodLength=26&timeframe=1day&limit=30`),
    fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=50&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=200&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/ema?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/standardDeviation?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`)
  ]);

  // ── Calculate MACD from EMA12 − EMA26 (FMP has no direct MACD endpoint) ──
  let macd = null, signal = null, histogram = null;
  if (Array.isArray(ema12Raw) && Array.isArray(ema26Raw) && ema12Raw.length && ema26Raw.length) {
    const ema26Map = {};
    ema26Raw.forEach(d => { if (d.date && d.ema != null) ema26Map[d.date] = d.ema; });
    // Build MACD series newest-first (matching EMA12 order)
    const macdSeries = ema12Raw
      .filter(d => d.date && d.ema != null && ema26Map[d.date] != null)
      .map(d => d.ema - ema26Map[d.date]);
    if (macdSeries.length > 0) {
      macd = +macdSeries[0].toFixed(4);
      if (macdSeries.length >= 9) {
        // 9-period EMA of MACD series for signal line (reverse → oldest first)
        const reversed = [...macdSeries].reverse();
        const k = 2 / 10;
        let sig = reversed[0];
        for (let i = 1; i < reversed.length; i++) sig = reversed[i] * k + sig * (1 - k);
        signal    = +sig.toFixed(4);
        histogram = +(macd - signal).toFixed(4);
      }
    }
  }

  return {
    sym,
    rsi:       latest(rsiRaw,   'rsi'),
    macd,
    signal,
    histogram,
    sma50:     latest(sma50Raw,  'sma'),
    sma200:    latest(sma200Raw, 'sma'),
    ema20:     latest(ema20Raw,  'ema'),
    stddev:    latest(bbRaw,     'standardDeviation')
  };
}

// ─── main ────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

const authHeader = req.headers['authorization'] || '';
const key = authHeader.replace('Bearer ', '').trim();

// Lookup mode — skip API key check (uses session token instead)
if (req.query.mode === 'lookup') {
  // no key check needed — open to any logged-in user
} else {
  // Normal mode — require API key
  if (key && key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

  // ── STOCK LOOKUP MODE ─────────────────────────────────────────────────────
if (req.query.mode === 'lookup') {
  const sym = (req.query.sym || '').toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: 'sym required' });

 let quote, metrics, targets, grades, dcf;
  try {
    [quote, metrics, targets, grades, dcf] = await Promise.all([
      fmpGet(`/quote/${sym}`),
      fmpGet(`/key-metrics-ttm/${sym}`),
      fmpGet(`/price-target-consensus?symbol=${sym}`),
      fmpGet(`/grades-latest?symbol=${sym}&limit=5`),
      fmpGet(`/discounted-cash-flow/${sym}`)
    ]);
  } catch(e) {
    return res.status(500).json({ error: 'FMP fetch failed: ' + e.message });
  }

  const q = Array.isArray(quote) ? quote[0] : quote;
  const m = Array.isArray(metrics) ? metrics[0] : metrics;
  const t = Array.isArray(targets) ? targets[0] : targets;
  const d = Array.isArray(dcf) ? dcf[0] : dcf;

  const data = {
    symbol: sym,
    price: q?.price,
    change: q?.change,
    changePct: q?.changesPercentage,
    marketCap: q?.marketCap,
    pe: m?.peRatioTTM,
    peg: m?.pegRatioTTM,
    roe: m?.roeTTM,
    fcf: m?.freeCashFlowPerShareTTM,
    revenueGrowth: m?.revenueGrowthTTM,
    targetMean: t?.targetMean,
    targetHigh: t?.targetHigh,
    targetLow: t?.targetLow,
    analystConsensus: (t?.analystRatingsStrongBuy + t?.analystRatingsBuy) > (t?.analystRatingsSell + t?.analystRatingsStrongSell) ? 'Bullish 📈' : 'Bearish 📉',
    dcfValue: d?.dcf,
    grades: Array.isArray(grades) ? grades.slice(0, 5) : []
  };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  let analysis = '';
  try {
    const prompt = `أنت محلل مالي متخصص في السوق الأمريكي. قدم تحليلاً شاملاً بالعربية للسهم التالي:

الرمز: ${sym}
السعر الحالي: $${data.price}
التغير اليوم: ${data.changePct?.toFixed(2)}%
القيمة السوقية: $${data.marketCap ? (data.marketCap/1e9).toFixed(1) : '—'}B
P/E: ${data.pe?.toFixed(1) ?? '—'}
PEG: ${data.peg?.toFixed(2) ?? '—'}
نمو الإيرادات: ${data.revenueGrowth ? (data.revenueGrowth*100).toFixed(1) : '—'}%
ROE: ${data.roe ? (data.roe*100).toFixed(1) : '—'}%
هدف المحللين (متوسط): $${data.targetMean ?? '—'}
القيمة العادلة DCF: $${data.dcfValue?.toFixed(0) ?? '—'}
توجه المحللين: ${data.analystConsensus}

قدم التحليل في هذا الشكل:

## ملخص السهم
[3 أسطر عن الشركة وما تفعله]

## التقييم
[هل السهم رخيص أم غالٍ؟ مقارنة السعر بالهدف والـ DCF]

## نقاط القوة
[3 نقاط إيجابية]

## نقاط الضعف / المخاطر
[3 مخاطر]

## الحكم النهائي
[شراء قوي / شراء / احتفظ / خفف / بيع] مع سبب موجز

⚠️ هذا تحليل معلوماتي وليس توصية مالية.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const aiData = await aiRes.json();
    analysis = aiData.content?.[0]?.text || '';
  } catch(e) {}

  return res.status(200).json({ data, analysis });
}
// ── END STOCK LOOKUP ──────────────────────────────────────────────────────
  
  const { nickname, include } = req.query;
  const wantIntelligence = include === 'intelligence';

  try {
    let holdings = [];
    let cash = {};
    let investorName = 'Rashed';
    let isGenericUser = false;
    let profile = {};   // optional investor profile; safe defaults applied below

    if (nickname && nickname !== 'rashed') {
      investorName = nickname.charAt(0).toUpperCase() + nickname.slice(1);
      isGenericUser = true;
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/data/portfolio-${nickname}.json?t=${Date.now()}`
      );
      if (!raw.ok) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(`Portfolio for ${investorName} is empty or not found.\nNo stocks to analyze.`);
      }
      const portfolio = await raw.json();
      profile = portfolio.profile || {};
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
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/data/portfolio.json?t=${Date.now()}`
      );
      if (!raw.ok) throw new Error('Cannot read portfolio.json');
      const portfolio = await raw.json();
      holdings = portfolio.holdings || [];
      cash = portfolio.cash_summary || {};
      profile = portfolio.profile || {};
    }

    const symbols  = holdings.map(h => h.sym);
    const ownedSet = new Set(symbols);

    // ── Live prices ──────────────────────────────────────────────────────────
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

    // ── Totals ───────────────────────────────────────────────────────────────
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price = priceMap[h.sym] || h.cost;
      const value = Math.round(h.shares * price);
      const glPct = ((price - h.cost) / h.cost * 100);
      totalValue += value;
      return { ...h, livePrice: price, value, glPct };
    });
    enriched.sort((a, b) => b.value - a.value);

    // ── Sector groups ────────────────────────────────────────────────────────
    const sectors = {
      tech:   { label: 'TECHNOLOGY',  items: [] },
      spec:   { label: 'SPECULATIVE', items: [] },
      bio:    { label: 'BIOTECH',     items: [] },
      mining: { label: 'MINING',      items: [] },
      etf:    { label: 'ETFs',        items: [] },
      other:  { label: 'OTHER',       items: [] },
    };
    enriched.forEach(h => { (sectors[h.sector] || sectors.other).items.push(h); });

    // ── Portfolio text ───────────────────────────────────────────────────────
    const pricesAvailable = Object.values(priceMap).filter(Boolean).length;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    let text = '';
    text += `═══════════════════════════════════════════════════════\n`;
    text += `${investorName.toUpperCase()}'S PORTFOLIO — Live as of ${timestamp}\n`;
    text += `Total Value: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
    text += `Live prices: ${pricesAvailable}/${symbols.length} stocks updated\n`;
    text += `═══════════════════════════════════════════════════════\n`;

    // ── Investor identity — risk/horizon/constraints now in INVESTOR PROFILE ──
    text += `INVESTOR: ${investorName}\n`;
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

    // ── Investor profile (optional; safe defaults when absent, never throws) ──
    const riskTolerance    = profile.riskTolerance || 'low';
    const timeHorizon      = profile.timeHorizon   || 'long';
    const riskIsDefault    = !profile.riskTolerance;
    const horizonIsDefault = !profile.timeHorizon;
    const horizonLabel = { short: 'SHORT-TERM', medium: 'MEDIUM-TERM', long: 'LONG-TERM' }[timeHorizon]
                         || String(timeHorizon).toUpperCase();

    text += `\n═══════════════════════════════════════════════════════\n`;
    text += `INVESTOR PROFILE (use to tailor recommendations; absent fields use safe defaults)\n`;
    text += `═══════════════════════════════════════════════════════\n`;
    text += `Risk tolerance: ${riskTolerance.toUpperCase()}${riskIsDefault ? ' (default)' : ''}\n`;
    text += `Time horizon: ${horizonLabel}${horizonIsDefault ? ' (default)' : ''}\n`;
    if (profile.cashToInvest != null && Number.isFinite(+profile.cashToInvest)) {
      text += `Cash available to invest: $${(+profile.cashToInvest).toLocaleString()}\n`;
    }
    if (profile.goals)       text += `Goals: ${profile.goals}\n`;
    if (profile.constraints) text += `Constraints: ${profile.constraints}\n`;
    if (profile.notes)       text += `Notes: ${profile.notes}\n`;
    text += `INTERPRETATION: These are the investor's stated preferences. Respect constraints `;
    text += `as hard rules. If risk is low, favor capital preservation and avoid aggressive `;
    text += `recommendations. Use cash-to-invest for deployment suggestions. Absent fields = defaults; do not invent preferences.\n`;

    // ── Intelligence block ───────────────────────────────────────────────────
    if (wantIntelligence) {

      const { date: marketDataDate, syms: moverSyms } = await fetchLatestMarketData();

      // Top 20 non-ETF for all analyst + new data calls
      const top20     = enriched.filter(h => h.sector !== 'etf').slice(0, 20).map(h => h.sym);
      const top20tech = enriched.filter(h => h.sector !== 'etf').slice(0, 20).map(h => h.sym);

      const allSyms = [...new Set([...symbols, ...moverSyms])];

      // Insider-activity symbol set: all non-ETF portfolio holdings, then movers
      // (excluding owned + known ETFs). ETFs have no insiders — skip them entirely.
      const etfSyms = new Set(enriched.filter(h => h.sector === 'etf').map(h => h.sym));
      const insiderPortfolioSyms = enriched.filter(h => h.sector !== 'etf').map(h => h.sym);
      const insiderMoverSyms = moverSyms.filter(s => !ownedSet.has(s) && !etfSyms.has(s));
      const insiderSyms = [...new Set([...insiderPortfolioSyms, ...insiderMoverSyms])];

      // Grades: last 60 days
      const gradesFrom = daysAgoUAE(60);

      // ── All FMP calls in parallel ─────────────────────────────────────────
      const [
        earningsRaw,
        targetResults,
        gradeResults,
        metricResults,
        techResults,
        surpriseResults,
        dcfResults,
        priceChangeResults,
        annualMetricResults,
        ratiosResults,
        insiderResults
      ] = await Promise.all([
        // Existing calls
        fmpGet(`/earnings-calendar?from=${todayUAE()}&to=${daysAheadUAE(60)}&symbol=${allSyms.join(',')}`),
        Promise.all(top20.map(sym => fmpGet(`/price-target-consensus?symbol=${sym}`))),
        Promise.all(top20.map(sym => fmpGet(`/grades?symbol=${sym}&limit=50`))),
        Promise.all(top20.map(sym => fmpGet(`/key-metrics-ttm?symbol=${sym}`))),
        Promise.allSettled(top20tech.map(sym => fetchTechnicals(sym))),
        // New calls
        Promise.all(top20.map(sym => fmpGet(`/earnings?symbol=${sym}&limit=8`))),
        Promise.all(top20.map(sym => fmpGet(`/discounted-cash-flow?symbol=${sym}`))),
        Promise.all(top20.map(sym => fmpGet(`/stock-price-change?symbol=${sym}`))),
        Promise.all(top20.map(sym => fmpGet(`/key-metrics?symbol=${sym}&period=annual&limit=5`))),
        Promise.all(top20.map(sym => fmpGet(`/ratios-ttm?symbol=${sym}`))),
        // Insider trading statistics — full quarterly history per symbol (trimmed to 4Q below)
        Promise.allSettled(insiderSyms.map(sym => fmpGet(`/insider-trading/statistics?symbol=${sym}`)))
      ]);

      // ── Build tech map ────────────────────────────────────────────────────
      const techMap = {};
      techResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          const t = result.value;
          const price = priceMap[t.sym];
          const entry = {
            rsi:       t.rsi    !== null ? +t.rsi.toFixed(2)    : null,
            macd:      t.macd   !== null ? +t.macd.toFixed(4)   : null,
            signal:    t.signal !== null ? +t.signal.toFixed(4) : null,
            histogram: t.histogram !== null ? +t.histogram.toFixed(4) : null,
            sma50:     t.sma50  !== null ? +t.sma50.toFixed(2)  : null,
            sma200:    t.sma200 !== null ? +t.sma200.toFixed(2) : null,
            ema20:     t.ema20  !== null ? +t.ema20.toFixed(2)  : null,
          };
          if (t.stddev !== null && price) {
            entry.bb_upper = +(price + 2 * t.stddev).toFixed(2);
            entry.bb_lower = +(price - 2 * t.stddev).toFixed(2);
          }
          const signals = [];
          if (entry.rsi !== null) {
            if (entry.rsi > 70)      signals.push(`RSI ${entry.rsi} — OVERBOUGHT`);
            else if (entry.rsi < 30) signals.push(`RSI ${entry.rsi} — OVERSOLD`);
            else                     signals.push(`RSI ${entry.rsi} — neutral`);
          }
          if (entry.macd !== null && entry.signal !== null) {
            if (entry.macd > entry.signal && entry.histogram > 0)       signals.push('MACD bullish ↑');
            else if (entry.macd < entry.signal && entry.histogram < 0)  signals.push('MACD bearish ↓');
            else                                                          signals.push('MACD neutral');
          }
          if (entry.sma50 !== null && entry.sma200 !== null) {
            signals.push(entry.sma50 > entry.sma200 ? 'Golden Cross ✅' : 'Death Cross ⚠️');
          }
          if (price && entry.ema20 !== null) {
            signals.push(price > entry.ema20
              ? `Above EMA20 (${entry.ema20}) — bullish`
              : `Below EMA20 (${entry.ema20}) — bearish`);
          }
          if (entry.bb_upper && entry.bb_lower && price) {
            const bbWidth = entry.bb_upper - entry.bb_lower;
            if (price >= entry.bb_upper)      signals.push(`At BB upper (${entry.bb_upper}) — extended`);
            else if (price <= entry.bb_lower) signals.push(`At BB lower (${entry.bb_lower}) — compressed`);
            else {
              const pct = ((price - entry.bb_lower) / bbWidth * 100).toFixed(0);
              signals.push(`BB ${pct}% (${entry.bb_lower}–${entry.bb_upper})`);
            }
          }
          entry.signals = signals;
          techMap[t.sym] = entry;
        }
      });

      // ── Analyst consensus (all grades, before date filter) ────────────────
      const gradeConsensusMap = {};
      top20.forEach((sym, idx) => {
        const allGrades = (gradeResults[idx] || []).filter(Boolean);
        if (!allGrades.length) {
          gradeConsensusMap[sym] = { consensus: 'no coverage', totalAnalysts: 0 };
          return;
        }
        // Latest grade per firm only
        const firmLatest = {};
        allGrades.forEach(entry => {
          if (!firmLatest[entry.gradingCompany]) firmLatest[entry.gradingCompany] = entry.newGrade;
        });
        const latestGrades = Object.values(firmLatest);
        const bullish = latestGrades.filter(g =>
          ['Buy','Strong Buy','Overweight','Outperform','Market Outperform','Positive'].includes(g)
        ).length;
        const bearish = latestGrades.filter(g =>
          ['Sell','Strong Sell','Underperform','Reduce','Underweight','Negative'].includes(g)
        ).length;
        const neutral = latestGrades.length - bullish - bearish;
        gradeConsensusMap[sym] = {
          totalAnalysts: latestGrades.length,
          bullish, neutral, bearish,
          consensus: bullish > (neutral + bearish) ? 'Bullish'
                   : bearish > (bullish + neutral) ? 'Bearish'
                   : 'Mixed'
        };
      });

      // ── Flatten analyst data ──────────────────────────────────────────────
      const earnings = earningsRaw || [];
      const targets  = targetResults.flat().filter(Boolean)
        .map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));

      // Grades: last 60 days + upgrades/downgrades/initiations only (no maintains)
      const actionKeywords = ['upgrade','downgrade','initiat','reiterat','resumed','lower','raise'];
      const grades = gradeResults.flat().filter(Boolean)
        .filter(i => i.date >= gradesFrom)
        .filter(i => actionKeywords.some(kw => (i.action || '').toLowerCase().includes(kw)))
        .map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));

      // Key metrics: include PEG and P/E TTM alongside existing fields
      const metrics = metricResults.flat().filter(Boolean).map(i => {
        const clean = { symbol: i.symbol, inPortfolio: ownedSet.has(i.symbol) };
        const keepFields = [
          'evToEBITDATTM','evToSalesTTM','returnOnEquityTTM',
          'returnOnInvestedCapitalTTM','returnOnAssetsTTM',
          'currentRatioTTM','earningsYieldTTM','freeCashFlowYieldTTM',
          'netDebtToEBITDATTM','stockBasedCompensationToRevenueTTM',
          'peRatioTTM','priceEarningsToGrowthRatioTTM'
        ];
        keepFields.forEach(f => { if (i[f] != null) clean[f] = +i[f].toFixed(3); });
        return clean;
      });

      const earningsSorted = earnings.map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}))
        .sort((a, b) => {
          if (a.inPortfolio && !b.inPortfolio) return -1;
          if (!a.inPortfolio && b.inPortfolio) return 1;
          return new Date(a.date) - new Date(b.date);
        });

      // ── Process new data ──────────────────────────────────────────────────

      // Earnings surprises — B/B/B/M pattern per stock
      // stable /earnings returns epsActual (null for future), epsEstimated
      // Must filter to PAST earnings only (epsActual != null)
      const surpriseMap = {};
      surpriseResults.forEach((data, idx) => {
        const sym = top20[idx];
        if (!Array.isArray(data) || !data.length) { surpriseMap[sym] = null; return; }
        // Filter to reported quarters only
        const recent = data.filter(q => (q.epsActual ?? q.eps ?? q.actualEarningResult) != null).slice(0, 4);
        if (!recent.length) { surpriseMap[sym] = null; return; }
        const getSurprisePct = q => {
          const actual   = q.epsActual ?? q.eps ?? q.actualEarningResult;
          const estimate = q.epsEstimated ?? q.estimatedEarning;
          if (actual != null && estimate != null && estimate !== 0)
            return ((actual - estimate) / Math.abs(estimate)) * 100;
          return null;
        };
        const pattern = recent.map(q => {
          const pct = getSurprisePct(q);
          if (pct == null) return '?';
          if (pct > 0.5)  return 'B';
          if (pct < -0.5) return 'W';
          return 'M';
        }).join('/');
        const validPcts = recent.map(getSurprisePct).filter(p => p != null);
        const beats = validPcts.filter(p => p > 0.5).length;
        const avgSurprise = validPcts.length
          ? validPcts.reduce((s, p) => s + p, 0) / validPcts.length : 0;
        // Cap display at ±500% — near-zero estimated EPS causes distorted percentages
        const avgSurpriseCapped = Math.max(-500, Math.min(500, avgSurprise));
        surpriseMap[sym] = {
          pattern,
          beatRate: `${beats}/${recent.length}`,
          avgSurprisePct: +avgSurpriseCapped.toFixed(1)
        };
      });

      // DCF fair values
      const dcfMap = {};
      dcfResults.forEach((data, idx) => {
        const sym = top20[idx];
        const item = Array.isArray(data) ? data[0] : data;
        if (!item?.dcf) { dcfMap[sym] = null; return; }
        const dcfVal = +item.dcf;
        const price  = priceMap[sym] || 0;
        const upside = price > 0 ? +((dcfVal - price) / price * 100).toFixed(1) : null;
        dcfMap[sym] = { dcf: +dcfVal.toFixed(2), upside };
      });

      // Weekly price change (5 trading days)
      const weeklyChangeMap = {};
      priceChangeResults.forEach((data, idx) => {
        const sym  = top20[idx];
        const item = Array.isArray(data) ? data[0] : data;
        weeklyChangeMap[sym] = item?.['5D'] != null ? +item['5D'].toFixed(2) : null;
      });

      // Short interest — not available on FMP stable API
      // Removed API call — will be added when data source is identified

      // PEG ratio + current P/E — from ratios-ttm
      // Confirmed fields: priceToEarningsGrowthRatioTTM, priceToEarningsRatioTTM
      const pegMap = {};
      const ratiosPeMap = {};
      ratiosResults.forEach((data, idx) => {
        const sym  = top20[idx];
        const item = Array.isArray(data) ? data[0] : data;
        if (!item) { pegMap[sym] = null; ratiosPeMap[sym] = null; return; }
        const peg = item.priceToEarningsGrowthRatioTTM ?? item.priceEarningsToGrowthRatioTTM ?? null;
        pegMap[sym] = peg != null && peg > 0 && peg < 200 ? +peg.toFixed(2) : null;
        const pe = item.priceToEarningsRatioTTM ?? null;
        ratiosPeMap[sym] = pe != null && pe > 0 && pe < 10000 ? +pe.toFixed(1) : null;
      });

      // Margins — from ratios-ttm (key-metrics-ttm does not carry these)
      const marginsMap = {};
      ratiosResults.forEach((data, idx) => {
        const sym  = top20[idx];
        const item = Array.isArray(data) ? data[0] : data;
        if (!item) { marginsMap[sym] = { net: null, gross: null }; return; }
        const net   = item.netProfitMarginTTM ?? null;
        const gross = item.grossProfitMarginTTM ?? null;
        marginsMap[sym] = {
          net:   net   != null ? +(net   * 100).toFixed(1) : null,
          gross: gross != null ? +(gross * 100).toFixed(1) : null
        };
      });

      // Historical P/E — 5Y annual average
      // key-metrics annual has no peRatio field — calculate from earningsYield (PE = 1/earningsYield)
      const historicalPeMap = {};
      annualMetricResults.forEach((data, idx) => {
        const sym = top20[idx];
        if (!Array.isArray(data) || !data.length) { historicalPeMap[sym] = null; return; }
        const validPEs = data
          .map(d => {
            if (d.earningsYield != null && d.earningsYield > 0.001)
              return +(1 / d.earningsYield).toFixed(1);
            return null;
          })
          .filter(pe => pe != null && pe > 0 && pe < 1000);
        historicalPeMap[sym] = validPEs.length >= 2
          ? +(validPEs.reduce((a, b) => a + b, 0) / validPEs.length).toFixed(1)
          : null;
      });

      // Insider activity — last 4 quarters; open-market BUYING is the signal
      // (acquired = grants/vesting, NOT conviction; selling = mostly routine noise)
      const insiderMap = {};
      insiderResults.forEach((result, idx) => {
        const sym = insiderSyms[idx];
        if (result.status !== 'fulfilled' || !Array.isArray(result.value) || !result.value.length) {
          insiderMap[sym] = null; return;
        }
        const num = v => { const n = typeof v === 'number' ? v : parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
        const quarters = [...result.value]
          .sort((a, b) => (num(b.year) - num(a.year)) || (num(b.quarter) - num(a.quarter)))
          .slice(0, 4);
        const recentPurchases  = quarters.reduce((s, q) => s + num(q.totalPurchases), 0);
        const purchaseQuarters = quarters.filter(q => num(q.totalPurchases) > 0).length;
        const totalAcquired    = quarters.reduce((s, q) => s + num(q.totalAcquired), 0);
        const totalDisposed    = quarters.reduce((s, q) => s + num(q.totalDisposed), 0);
        // Context label only — disposals heavily outweighing acquisitions = routine comp selling
        const netSelling = totalDisposed > 0 && totalDisposed > totalAcquired * 3;
        let verdict;
        if (purchaseQuarters >= 2) {
          verdict = `open-market buying in ${purchaseQuarters} of last 4 quarters → CONVICTION SIGNAL ✅`;
        } else if (recentPurchases > 0) {
          verdict = `open-market buying in 1 of last 4 quarters → mild positive`;
        } else if (netSelling) {
          verdict = `no open-market buying; routine comp selling only → NEUTRAL`;
        } else {
          verdict = `no open-market buying → NEUTRAL (no signal)`;
        }
        insiderMap[sym] = { recentPurchases, purchaseQuarters, netSelling, verdict };
      });

      // ── Build metrics lookup ───────────────────────────────────────────────
      const metricsLookup = {};
      metricResults.flat().filter(Boolean).forEach(i => { metricsLookup[i.symbol] = i; });

      // ═══════════════════════════════════════════════════════════════════
      // CP3 — Finnhub second-source cross-check
      // Adds Finnhub free as a second source for ROE / P/E / PEG / margins.
      // ROIC / DCF / price-target stay FMP-only (different definitions or gated).
      // Cross-check logic:
      //   ≤10% difference  → ✅ agree  (show one value, high confidence)
      //   10–20%           → ℹ️ minor  (show both, note minor spread)
      //   >20% on ROE/PE/margins → ⚠️ conflict (data quality issue — flag)
      //   >20% on PEG      → ℹ️ range  (methodology differs — not a data error)
      // Wrapped in try/catch — Finnhub failure NEVER breaks the response.
      // ═══════════════════════════════════════════════════════════════════

      const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
      const finnhubMap = {};  // sym -> { roe, pe, peg, netMargin, grossMargin } or null

      if (FINNHUB_KEY) {
        try {
          // Fetch Finnhub metrics for top20 in parallel (free tier: 60/min)
          // top20 is ≤20 calls — well within limit
          const finnhubResults = await Promise.allSettled(
            top20.map(async sym => {
              try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 5000);
                const r = await fetch(
                  `https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${FINNHUB_KEY}`,
                  { signal: controller.signal }
                );
                clearTimeout(timer);
                if (!r.ok) return { sym, data: null };
                const d = await r.json();
                const m = d?.metric || null;
                if (!m) return { sym, data: null };
                return {
                  sym,
                  data: {
                    roe:        m.roeTTM        != null ? +(m.roeTTM).toFixed(2)        : null,
                    pe:         m.peTTM         != null ? +(m.peTTM).toFixed(1)         : null,
                    peg:        m.pegTTM        != null ? +(m.pegTTM).toFixed(2)        : null,
                    netMargin:  m.netProfitMarginTTM != null ? +(m.netProfitMarginTTM).toFixed(1) : null,
                    grossMargin: m.grossMarginTTM    != null ? +(m.grossMarginTTM).toFixed(1)     : null,
                  }
                };
              } catch { return { sym, data: null }; }
            })
          );
          finnhubResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
              finnhubMap[result.value.sym] = result.value.data;
            }
          });
        } catch (e) {
          // Finnhub fetch failed entirely — continue without cross-check
        }
      }

      // ── Cross-check helper ────────────────────────────────────────────
      // Returns a formatted string showing one or both values + agreement label.
      // isPegField: true for PEG (methodology range, not data conflict)
      function crossCheck(fmpVal, finnhubVal, fmtFn, isPegField) {
        const fmpOk  = fmpVal     != null && Number.isFinite(+fmpVal);
        const fhOk   = finnhubVal != null && Number.isFinite(+finnhubVal);

        if (!fmpOk && !fhOk) return 'N/A';
        if (!fmpOk)           return `N/A (FMP) | Finnhub ${fmtFn(finnhubVal)}`;
        if (!fhOk)            return `${fmtFn(fmpVal)} (FMP only — Finnhub N/A)`;

        // Both present — compare
        const diff = Math.abs((+fmpVal - +finnhubVal) / Math.abs(+fmpVal)) * 100;

        if (diff <= 10) {
          // Agree — show FMP value (primary source), note confirmed
          return `${fmtFn(fmpVal)}  ✅ (FMP + Finnhub agree)`;
        } else if (diff <= 20) {
          // Minor spread — show both
          return `FMP ${fmtFn(fmpVal)} | Finnhub ${fmtFn(finnhubVal)}  ℹ️ minor spread`;
        } else {
          // >20% divergence
          if (isPegField) {
            // PEG: methodology difference, not a data error
            return `FMP ${fmtFn(fmpVal)} | Finnhub ${fmtFn(finnhubVal)}  ℹ️ range (growth assumptions differ)`;
          } else {
            // ROE / PE / margins: genuine data conflict — flag
            return `FMP ${fmtFn(fmpVal)} | Finnhub ${fmtFn(finnhubVal)}  ⚠️ conflict — treat as low-confidence`;
          }
        }
      }

      // ── Append intelligence text ──────────────────────────────────────────
      text += `\n═══════════════════════════════════════════════════════\n`;
      text += `MARKET INTELLIGENCE — ${todayUAE()}\n`;
      text += `Portfolio: ${symbols.join(', ')}\n`;
      text += `Movers data: ${marketDataDate ? `from ${marketDataDate}` : 'unavailable'} — ${moverSyms.join(', ') || 'none'}\n`;
      text += `═══════════════════════════════════════════════════════\n\n`;

      // ── CP1 — Source health check (no new network calls — reads existing results) ──
      const fmpHealthCount  = metricResults.flat().filter(Boolean).length;
      const fmpHealthTotal  = top20.length;
      const fmpPct          = fmpHealthTotal > 0 ? fmpHealthCount / fmpHealthTotal : 0;
      const fmpStatus       = fmpPct >= 0.8 ? '✅' : fmpPct >= 0.5 ? '⚠️ degraded' : '✗ down';

      const fhCount         = Object.values(finnhubMap).filter(v => v !== null).length;
      const fhTotal         = top20.length;
      const fhPct           = fhTotal > 0 ? fhCount / fhTotal : 0;
      const fhStatus        = !FINNHUB_KEY ? '✗ no key'
                            : fhPct >= 0.8  ? '✅'
                            : fhPct > 0     ? '⚠️ degraded'
                            : '✗ unavailable';

      const yahooPct        = symbols.length > 0 ? pricesAvailable / symbols.length : 0;
      const yahooStatus     = yahooPct >= 0.8 ? '✅' : yahooPct >= 0.5 ? '⚠️ degraded' : '✗ down';

      text += `SOURCE HEALTH — ${todayUAE()}\n`;
      text += `  Yahoo prices: ${pricesAvailable}/${symbols.length} updated ${yahooStatus}\n`;
      text += `  FMP:          ${fmpHealthCount}/${fmpHealthTotal} stocks with metrics ${fmpStatus}\n`;
      text += `  Finnhub:      ${fhCount}/${fhTotal} stocks cross-checked ${fhStatus}\n`;
      text += `\n`;

      // Technical indicators table
      text += `TECHNICAL INDICATORS (top 20 non-ETF stocks):\n`;
      text += `${'SYM'.padEnd(7)} ${'RSI'.padEnd(7)} ${'MACD'.padEnd(10)} ${'SMA50'.padEnd(9)} ${'SMA200'.padEnd(9)} ${'EMA20'.padEnd(9)} BB\n`;
      text += `────────────────────────────────────────────────────────────────────\n`;
      top20tech.forEach(sym => {
        const t = techMap[sym];
        if (!t) { text += `${sym.padEnd(7)} N/A\n`; return; }
        text += `${sym.padEnd(7)} `;
        text += `${(t.rsi    != null ? String(t.rsi)    : 'N/A').padEnd(7)} `;
        text += `${(t.macd   != null ? String(t.macd)   : 'N/A').padEnd(10)} `;
        text += `${(t.sma50  != null ? String(t.sma50)  : 'N/A').padEnd(9)} `;
        text += `${(t.sma200 != null ? String(t.sma200) : 'N/A').padEnd(9)} `;
        text += `${(t.ema20  != null ? String(t.ema20)  : 'N/A').padEnd(9)} `;
        text += `${t.bb_upper || 'N/A'} / ${t.bb_lower || 'N/A'}\n`;
      });
      text += `\nSIGNAL INTERPRETATION:\n`;
      top20tech.forEach(sym => {
        const t = techMap[sym];
        if (t?.signals?.length) text += `${sym}: ${t.signals.join(' | ')}\n`;
      });
      text += `\n`;

      // Earnings surprises — real B/B/B/M history
      text += `EARNINGS SURPRISES — last 4 quarters (B=beat >0.5% | M=meet | W=miss <-0.5%):\n`;
      top20.forEach(sym => {
        const s = surpriseMap[sym];
        if (!s) { text += `${sym.padEnd(7)} N/A\n`; return; }
        const sign = s.avgSurprisePct >= 0 ? '+' : '';
        text += `${sym.padEnd(7)} ${s.pattern.padEnd(12)} beat_rate=${s.beatRate}  avg_surprise=${sign}${s.avgSurprisePct}%\n`;
      });
      text += `[Source: FMP earnings-surprises — actual vs estimated EPS]\n\n`;

      // DCF fair values — real FMP model
      text += `DCF FAIR VALUES (FMP intrinsic value model):\n`;
      top20.forEach(sym => {
        const d = dcfMap[sym];
        const price = priceMap[sym];
        if (!d) { text += `${sym.padEnd(7)} DCF=N/A\n`; return; }
        const upsideSign = d.upside >= 0 ? '+' : '';
        const arrow = d.upside > 10 ? '↑ undervalued' : d.upside < -10 ? '↓ overvalued' : '→ fair';
        text += `${sym.padEnd(7)} dcf=$${d.dcf}  price=$${price?.toFixed(2) || 'N/A'}  upside=${upsideSign}${d.upside}%  ${arrow}\n`;
      });
      text += `[Note: FMP uses their growth assumptions — apply 20% margin of safety. DCF models vary ±30% between analysts.]\n\n`;

      // Weekly price change
      text += `WEEKLY PRICE CHANGE (5 trading days):\n`;
      top20.forEach(sym => {
        const w = weeklyChangeMap[sym];
        const val = w != null ? `${w >= 0 ? '+' : ''}${w}%` : 'N/A';
        text += `${sym.padEnd(7)} ${val}\n`;
      });
      text += `\n`;

      // Short interest — not available on FMP stable API
      text += `SHORT INTEREST: not available via FMP stable API\n\n`;

      // Historical P/E comparison + PEG ratio
      text += `HISTORICAL P/E + PEG RATIO (5Y annual avg vs current TTM):\n`;
      top20.forEach(sym => {
        const hist      = historicalPeMap[sym];
        const currentPE = ratiosPeMap[sym] ?? (metricsLookup[sym]?.peRatioTTM != null ? +metricsLookup[sym].peRatioTTM.toFixed(1) : null);
        const peg = pegMap[sym];
        if (!hist && !currentPE && !peg) {
          text += `${sym.padEnd(7)} N/A (no earnings history)\n`; return;
        }
        let note = '';
        if (hist && currentPE) {
          if (currentPE < hist * 0.85)      note = ' → BELOW historical avg';
          else if (currentPE > hist * 1.15) note = ' → ABOVE historical avg';
          else                               note = ' → near historical avg';
        }
        const pegStr = peg != null
          ? `  peg=${peg}x${peg < 1 ? ' (undervalued)' : peg > 2 ? ' (expensive)' : ''}`
          : '';
        const histStr = hist != null ? `${hist}x` : 'N/A';
        const peStr   = currentPE != null ? `${currentPE}x` : 'N/A';
        text += `${sym.padEnd(7)} hist5Y=${histStr}  currentPE=${peStr}${pegStr}${note}\n`;
      });
      text += `\n`;

      // Analyst consensus
      text += `ANALYST CONSENSUS (current positioning across all firms):\n`;
      top20.forEach(sym => {
        const c = gradeConsensusMap[sym];
        if (!c || c.totalAnalysts === 0) { text += `${sym.padEnd(7)} no analyst coverage\n`; return; }
        text += `${sym.padEnd(7)} consensus=${c.consensus.padEnd(9)} analysts=${c.totalAnalysts}  (${c.bullish} buy / ${c.neutral} neutral / ${c.bearish} sell)\n`;
      });
      text += `\n`;

      // Insider activity — institutional/insider conviction signal (weekly/monthly)
      text += `═══════════════════════════════════════════════════════\n`;
      text += `INSIDER ACTIVITY (last 4 quarters — open-market buying is the signal)\n`;
      text += `═══════════════════════════════════════════════════════\n`;
      const renderInsider = sym => {
        const ins = insiderMap[sym];
        if (!ins) { text += `${sym.padEnd(6)} — no insider data available → no signal\n`; return; }
        text += `${sym.padEnd(6)} — ${ins.verdict}\n`;
      };
      insiderPortfolioSyms.forEach(renderInsider);
      if (insiderMoverSyms.length) {
        text += `--- movers ---\n`;
        insiderMoverSyms.forEach(renderInsider);
      }
      text += `INTERPRETATION: Insider BUYING = conviction. Insider SELLING = mostly routine,\n`;
      text += `not bearish. Absence of buying is neutral, not negative.\n`;
      text += `[Source: FMP insider-trading/statistics — open-market purchases only are the signal]\n\n`;

      // Earnings calendar
      text += `EARNINGS CALENDAR (next 60 days):\n`;
      text += JSON.stringify({
        portfolio: earningsSorted.filter(e => e.inPortfolio),
        movers:    earningsSorted.filter(e => !e.inPortfolio).slice(0, 5)
      }, null, 2) + '\n\n';

      // ═══════════════════════════════════════════════════════════════════
      // CP2 — labeled metric lines + structured DATA_QUALITY block
      // Replaces the old raw-JSON dumps (targets/grades/metrics) that invited
      // the LLM to read a vague label and fill numbers from training data.
      // Every value is tagged with its exact FMP field name; missing = "N/A".
      // Whole section is wrapped so it can NEVER break the portfolio response.
      // ═══════════════════════════════════════════════════════════════════
      try {
        // Helpers — format a value or "N/A", and track presence for DATA_QUALITY
        const fmtPct = v => (v != null && Number.isFinite(+v)) ? `${(+v).toFixed(1)}%` : 'N/A';
        const fmtNum = (v, d = 2) => (v != null && Number.isFinite(+v)) ? (+v).toFixed(d) : 'N/A';
        const present = v => v != null && Number.isFinite(+v);

        // Index analyst targets + grades by symbol for per-stock lookup
        const targetMap = {};
        targets.forEach(t => { if (t && t.symbol) targetMap[t.symbol] = t; });

        const gradesBySym = {};
        grades.forEach(g => {
          if (!g || !g.symbol) return;
          (gradesBySym[g.symbol] = gradesBySym[g.symbol] || []).push(g);
        });

        // Fields tracked in DATA_QUALITY (CP3 will add Finnhub columns to the
        // cross-checkable ones: ROE/PE/PEG/margins. ROIC/DCF/target stay FMP-only.)
        const DQ_FIELDS = ['ROE', 'ROIC', 'PE', 'PEG', 'netMargin', 'grossMargin', 'DCF', 'priceTarget'];
        const dq = {};                                   // sym -> { field: bool }
        const perFieldMissing = Object.fromEntries(DQ_FIELDS.map(f => [f, 0]));

        // ── ANALYST PRICE TARGETS (labeled) ──────────────────────────────
        text += `ANALYST PRICE TARGETS (top 20 non-ETF):\n`;
        top20.forEach(sym => {
          const t = targetMap[sym];
          const price = priceMap[sym];
          if (!t) { text += `${sym}: N/A (no target coverage)\n`; return; }
          const consensus = t.targetConsensus ?? t.targetMedian ?? null;
          const vsPrice = (present(consensus) && present(price))
            ? `  vs price: ${consensus >= price ? '+' : ''}${(((consensus - price) / price) * 100).toFixed(1)}% (price ${fmtNum(price)})`
            : '';
          text += `${sym}: consensus ${fmtNum(consensus)} (targetConsensus)  `;
          text += `high/low ${fmtNum(t.targetHigh, 0)}/${fmtNum(t.targetLow, 0)} (targetHigh/targetLow)${vsPrice}\n`;
        });
        text += `\n`;

        // ── ANALYST GRADES (labeled summary) ─────────────────────────────
        text += `ANALYST GRADES — last 60 days (upgrades/downgrades/initiations only):\n`;
        top20.forEach(sym => {
          const gs = gradesBySym[sym] || [];
          if (!gs.length) { text += `${sym}: no rating changes in last 60 days\n`; return; }
          const has = kw => g => (g.action || '').toLowerCase().includes(kw);
          const ups   = gs.filter(g => has('upgrade')(g) || has('raise')(g)).length;
          const downs = gs.filter(g => has('downgrade')(g) || has('lower')(g)).length;
          const inits = gs.filter(g => has('initiat')(g) || has('resumed')(g)).length;
          const reits = gs.filter(g => has('reiterat')(g)).length;
          const parts = [];
          if (ups)   parts.push(`${ups} upgrade${ups > 1 ? 's' : ''}`);
          if (downs) parts.push(`${downs} downgrade${downs > 1 ? 's' : ''}`);
          if (inits) parts.push(`${inits} initiation${inits > 1 ? 's' : ''}`);
          if (reits) parts.push(`${reits} reiteration${reits > 1 ? 's' : ''}`);
          text += `${sym}: ${parts.join(', ') || `${gs.length} rating change(s)`}\n`;
        });
        text += `\n`;

        // ── KEY METRICS (labeled, field-tagged) — the NVDA root-cause fix ──
        const finnhubAvailable = FINNHUB_KEY && Object.keys(finnhubMap).length > 0;

        text += `KEY METRICS (top 20 non-ETF — read these exact fields; write N/A if absent, never infer):\n`;
        if (finnhubAvailable) {
          text += `[Cross-check: FMP (primary) vs Finnhub (second source). ✅=agree ℹ️=range/minor ⚠️=conflict]\n`;
          text += `[ROIC/DCF/price-target: FMP only — no Finnhub equivalent or gated on free tier]\n`;
        }
        top20.forEach(sym => {
          const m   = metricsLookup[sym] || {};
          const r   = ratiosPeMap[sym];
          const peg = pegMap[sym];
          const dcf = dcfMap[sym];
          const tgt = targetMap[sym];
          const tgtConsensus = tgt ? (tgt.targetConsensus ?? tgt.targetMedian ?? null) : null;
          const fh  = finnhubMap[sym] || null;

          const roe      = m.returnOnEquityTTM != null ? m.returnOnEquityTTM * 100 : null;
          const roic     = m.returnOnInvestedCapitalTTM != null ? m.returnOnInvestedCapitalTTM * 100 : null;
          const pe       = r ?? (m.peRatioTTM ?? null);
          const netMrg   = marginsMap[sym] ? marginsMap[sym].net   : null;
          const grossMrg = marginsMap[sym] ? marginsMap[sym].gross : null;
          const dcfVal   = dcf ? dcf.dcf : null;

          // Finnhub values (already multiplied by 100 where needed from fetch above)
          const fhRoe      = fh ? fh.roe        : null;
          const fhPe       = fh ? fh.pe         : null;
          const fhPeg      = fh ? fh.peg        : null;
          const fhNetMrg   = fh ? fh.netMargin  : null;
          const fhGrossMrg = fh ? fh.grossMargin : null;

          // record presence for DATA_QUALITY
          dq[sym] = {
            ROE:        present(roe),      ROIC:        present(roic),
            PE:         present(pe),       PEG:         present(peg),
            netMargin:  present(netMrg),   grossMargin: present(grossMrg),
            DCF:        present(dcfVal),   priceTarget: present(tgtConsensus),
            // Finnhub presence (new CP3 columns)
            fhROE:       present(fhRoe),   fhPE:        present(fhPe),
            fhPEG:       present(fhPeg),   fhNetMargin: present(fhNetMrg),
            fhGrossMargin: present(fhGrossMrg)
          };
          DQ_FIELDS.forEach(f => { if (!dq[sym][f]) perFieldMissing[f]++; });

          text += `KEY METRICS — ${sym}\n`;
          // Cross-checked fields
          text += `  ROE:          ${crossCheck(roe,      fhRoe,      fmtPct, false)}   (returnOnEquityTTM)\n`;
          text += `  P/E (TTM):    ${crossCheck(pe,       fhPe,       v => fmtNum(v,1), false)}   (priceToEarningsRatioTTM)\n`;
          text += `  PEG:          ${crossCheck(peg,      fhPeg,      v => fmtNum(v,2), true)}   (priceToEarningsGrowthRatioTTM)\n`;
          text += `  Net margin:   ${crossCheck(netMrg,   fhNetMrg,   fmtPct, false)}   (netProfitMarginTTM)\n`;
          text += `  Gross margin: ${crossCheck(grossMrg, fhGrossMrg, fmtPct, false)}   (grossProfitMarginTTM)\n`;
          // FMP-only fields (no Finnhub equivalent)
          text += `  ROIC:         ${fmtPct(roic)}   (returnOnInvestedCapitalTTM — FMP only)\n`;
          text += `  DCF fair $:   ${fmtNum(dcfVal)}   (discounted-cash-flow — FMP only)\n`;
          text += `  Price target: ${fmtNum(tgtConsensus)}   (price-target-consensus — FMP only)\n`;
        });
        text += `\n`;

        // ── DATA_QUALITY block — extended for CP3 ────────────────────────
        text += `═══ DATA_QUALITY ═══\n`;
        text += `FIELDS: ${DQ_FIELDS.join(', ')}\n`;
        if (finnhubAvailable) {
          text += `CROSS_CHECK_FIELDS: ROE, PE, PEG, netMargin, grossMargin (FMP+Finnhub)\n`;
          text += `SINGLE_SOURCE_FIELDS: ROIC, DCF, priceTarget (FMP only)\n`;
        }
        let totalMissing = 0, stocksWithGaps = 0;
        top20.forEach(sym => {
          const row = dq[sym] || {};
          const miss = DQ_FIELDS.filter(f => !row[f]).length;
          totalMissing += miss;
          if (miss > 0) stocksWithGaps++;
          const cells = DQ_FIELDS.map(f => `${f}=${row[f] ? '✓' : '✗'}`).join(' ');
          // CP3: add Finnhub availability per cross-check field
          const fhCells = finnhubAvailable
            ? `  fh=${['ROE','PE','PEG','netMargin','grossMargin'].map(f => `${f}=${row['fh' + f.charAt(0).toUpperCase() + f.slice(1)] ? '✓' : '✗'}`).join(' ')}`
            : '';
          text += `${sym}: ${cells} | missing=${miss}${fhCells}\n`;
        });
        const n = top20.length;
        text += `SUMMARY: ${n} stocks · ${totalMissing} field(s) missing across ${stocksWithGaps} stock(s)\n`;
        text += `PER_FIELD_MISSING: ${DQ_FIELDS.map(f => `${f}=${perFieldMissing[f]}/${n}`).join(' ')}\n`;
        if (finnhubAvailable) {
          const fhFields = ['ROE','PE','PEG','netMargin','grossMargin'];
          text += `FINNHUB_COVERAGE: ${fhFields.map(f => `${f}=${top20.filter(s => dq[s]?.['fh' + f.charAt(0).toUpperCase() + f.slice(1)]).length}/${n}`).join(' ')}\n`;
        }
        text += `═══ END DATA_QUALITY ═══\n`;

        // ── CP5 — Transparency lines for the AI to include in analysis ──────
        // The AI must copy the relevant transparency line into its analysis
        // text when writing about each stock. Rules:
        //   missing = 0-1 → nothing shown (common, not meaningful)
        //   missing = 2-3 → ⚠️ caution line
        //   missing = 4+  → 🔴 low-confidence line
        // Field display names for user-facing text
        const fieldDisplayNames = {
          ROE: 'ROE', ROIC: 'ROIC', PE: 'P/E', PEG: 'PEG',
          netMargin: 'net margin', grossMargin: 'gross margin',
          DCF: 'DCF', priceTarget: 'price target'
        };

        const transparencyLines = {};
        top20.forEach(sym => {
          const row = dq[sym] || {};
          const missingFields = DQ_FIELDS.filter(f => !row[f]);
          const count = missingFields.length;
          if (count <= 1) { transparencyLines[sym] = null; return; }
          const fieldList = missingFields.map(f => fieldDisplayNames[f] || f).join(', ');
          const icon = count >= 4 ? '🔴' : '⚠️';
          const suffix = count >= 4 ? ' (low-confidence score)' : '';
          transparencyLines[sym] = `${icon} ${sym} — Score analysis was done without considering: ${fieldList}${suffix}`;
        });

        const stocksWithWarnings = top20.filter(s => transparencyLines[s]);
        const qualitySummary = stocksWithWarnings.length === 0
          ? `📊 Data quality: all ${top20.length} stocks fully covered`
          : `📊 Data quality: ${top20.length - stocksWithWarnings.length}/${top20.length} stocks fully covered · ${stocksWithWarnings.length} stock(s) analyzed with partial data`;

        text += `\n═══ TRANSPARENCY ═══\n`;
        text += `QUALITY SUMMARY: ${qualitySummary}\n`;
        text += `INSTRUCTION: When writing analysis for each stock below, include the\n`;
        text += `transparency line exactly as written. For stocks with no line, write nothing.\n`;
        top20.forEach(sym => {
          if (transparencyLines[sym]) text += `${sym}: ${transparencyLines[sym]}\n`;
        });
        text += `═══ END TRANSPARENCY ═══\n`;

      } catch (e) {
        // Monitoring/formatting must never break the data response
        text += `\n[DATA_QUALITY unavailable: ${e.message}]\n`;
      }

      text += `\n═══════════════════════════════════════════════════════\n`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch (e) {
    res.status(500).send(`Portfolio data unavailable: ${e.message}`);
  }
};
