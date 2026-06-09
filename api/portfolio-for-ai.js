// api/portfolio-for-ai.js
// v9 — Session 25 (2026-06-09)
// Added on top of v8:
//   - fetchTechnicals: +ATR(14), ADX(14), Aroon(14), OBV, Stoch(14,3), 52W price change
//   - Pattern detection: ⚡ RECOVERY CANDIDATE, 🚀 BREAKOUT SETUP, 🔴 DISTRIBUTION WARNING
//   - Dynamic weight context block (profile-driven + per-stock modifiers)
// v8 already had: insider activity, DCF, historical P/E, earnings surprises,
//   analyst consensus, cash flow, MACD (self-calc), Finnhub cross-check

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

// ─── Fetch latest available market data file ─────────────────────────────────
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
  const [rsiRaw, ema12Raw, ema26Raw, sma50Raw, sma200Raw, ema20Raw, bbRaw,
         atrRaw, adxRaw, aroonRaw, obvRaw, stochRaw, priceChangeRaw] = await Promise.all([
    fmpGet(`/technical-indicators/rsi?symbol=${sym}&periodLength=14&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/ema?symbol=${sym}&periodLength=12&timeframe=1day&limit=30`),
    fmpGet(`/technical-indicators/ema?symbol=${sym}&periodLength=26&timeframe=1day&limit=30`),
    fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=50&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=200&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/ema?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/standardDeviation?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/atr?symbol=${sym}&periodLength=14&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/adx?symbol=${sym}&periodLength=14&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/aroon?symbol=${sym}&periodLength=14&timeframe=1day&limit=2`),
    fmpGet(`/technical-indicators/obv?symbol=${sym}&timeframe=1day&limit=2`),
    fmpGet(`/technical-indicators/stoch?symbol=${sym}&periodLength=14&smoothingPeriod=3&timeframe=1day&limit=1`),
    fmpGet(`/stock-price-change?symbol=${sym}`)
  ]);

  let macd = null, signal = null, histogram = null;
  if (Array.isArray(ema12Raw) && Array.isArray(ema26Raw) && ema12Raw.length && ema26Raw.length) {
    const ema26Map = {};
    ema26Raw.forEach(d => { if (d.date && d.ema != null) ema26Map[d.date] = d.ema; });
    const macdSeries = ema12Raw
      .filter(d => d.date && d.ema != null && ema26Map[d.date] != null)
      .map(d => d.ema - ema26Map[d.date]);
    if (macdSeries.length > 0) {
      macd = +macdSeries[0].toFixed(4);
      if (macdSeries.length >= 9) {
        const reversed = [...macdSeries].reverse();
        const k = 2 / 10;
        let sig = reversed[0];
        for (let i = 1; i < reversed.length; i++) sig = reversed[i] * k + sig * (1 - k);
        signal    = +sig.toFixed(4);
        histogram = +(macd - signal).toFixed(4);
      }
    }
  }

  // OBV direction: rising if latest > previous
  let obvDir = null;
  if (Array.isArray(obvRaw) && obvRaw.length >= 2) {
    obvDir = obvRaw[0].obv > obvRaw[1].obv ? 'rising' : 'falling';
  }

  // Aroon trend freshness
  const aroonUp   = Array.isArray(aroonRaw) && aroonRaw[0] ? aroonRaw[0].aroonUp   ?? null : null;
  const aroonDown = Array.isArray(aroonRaw) && aroonRaw[0] ? aroonRaw[0].aroonDown ?? null : null;

  // 52W price change
  const priceChangePct = Array.isArray(priceChangeRaw) && priceChangeRaw[0]
    ? priceChangeRaw[0]['1Y'] ?? null : null;

  return {
    sym,
    rsi:       latest(rsiRaw,   'rsi'),
    macd,
    signal,
    histogram,
    sma50:     latest(sma50Raw,  'sma'),
    sma200:    latest(sma200Raw, 'sma'),
    ema20:     latest(ema20Raw,  'ema'),
    stddev:    latest(bbRaw,     'standardDeviation'),
    atr:       latest(atrRaw,    'atr'),
    adx:       latest(adxRaw,    'adx'),
    aroonUp,
    aroonDown,
    obvDir,
    stochK:    latest(stochRaw,  'stochK') ?? latest(stochRaw, 'k'),
    priceChange1Y: priceChangePct
  };
}

// ─── Lookup: financial history (last 3 fiscal years, oldest→newest) ──────────
async function fetchFinancials(sym) {
  const [incomeRaw, cashRaw] = await Promise.all([
    fmpGet(`/income-statement?symbol=${sym}&period=annual&limit=3`),
    fmpGet(`/cash-flow-statement?symbol=${sym}&period=annual&limit=3`)
  ]);
  if (!Array.isArray(incomeRaw) || incomeRaw.length === 0) return [];
  // FMP returns newest→oldest; reverse to oldest→newest
  const income = [...incomeRaw].reverse();
  // Map FCF by fiscal year for matching
  const fcfByYear = {};
  if (Array.isArray(cashRaw)) {
    cashRaw.forEach(c => {
      const yr = c.fiscalYear ?? c.calendarYear ?? (c.date ? c.date.slice(0, 4) : null);
      if (yr != null) fcfByYear[String(yr)] = c.freeCashFlow ?? null;
    });
  }
  return income.map(r => {
    const year = r.fiscalYear ?? r.calendarYear ?? (r.date ? r.date.slice(0, 4) : null);
    const revenue = r.revenue ?? null;
    const netIncome = r.netIncome ?? null;
    const netMargin = (revenue && netIncome != null) ? +((netIncome / revenue) * 100).toFixed(1) : null;
    return {
      label: year ? `FY${year}` : String(r.date||'').slice(0,4),
      year,
      revenue,
      netIncome,
      netMargin,
      freeCashFlow: fcfByYear[String(year)] ?? null
    };
  });
}

// ─── Lookup: 1yr daily price history, downsampled to ~52 weekly points ───────
async function fetchPriceHistory(sym) {
  const raw = await fmpGet(`/historical-price-eod/light?symbol=${sym}&from=${daysAgoUAE(365)}&to=${todayUAE()}`);
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // FMP returns newest→oldest; reverse to oldest→newest
  const series = [...raw].reverse();
  // Downsample to ~52 weekly points
  const step = Math.max(1, Math.floor(series.length / 52));
  const sampled = [];
  for (let i = 0; i < series.length; i += step) sampled.push(series[i]);
  const last = series[series.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled.map(p => ({ date: p.date, price: p.price ?? p.close ?? null })).filter(p => p.price != null);
}

// ─── Lookup: company profile (name + beta) ───────────────────────────────────
async function fetchProfile(sym) {
  const raw = await fmpGet(`/profile?symbol=${sym}`);
  const p = Array.isArray(raw) ? raw[0] : (raw || null);
  return {
    companyName: p?.companyName || null,
    beta: p?.beta ?? null,
    sector: p?.sector || null,
    description: p?.description || null,
    website: p?.website || null
  };
}

// ─── main ────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ', '').trim();

 // ── STOCK LOOKUP MODE — no API key required ───────────────────────────────
if (req.query.mode === 'lookup') {
  const sym = (req.query.sym || '').toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: 'sym required' });

  let quoteRaw, metrics, targets, grades, dcf, ratios, growth;
  try {
    [quoteRaw, metrics, targets, grades, dcf, ratios, growth] = await Promise.all([
      fmpGet(`/quote?symbol=${sym}`),
      fmpGet(`/key-metrics-ttm?symbol=${sym}`),
      fmpGet(`/price-target-consensus?symbol=${sym}`),
      fmpGet(`/grades-latest?symbol=${sym}&limit=5`),
      fmpGet(`/discounted-cash-flow?symbol=${sym}`),
      fmpGet(`/ratios-ttm?symbol=${sym}`),
      fmpGet(`/income-statement-growth?symbol=${sym}&limit=1`)
    ]);
  } catch(e) {
    return res.status(500).json({ error: 'Fetch error: ' + e.message });
  }

  const lq = Array.isArray(quoteRaw) ? quoteRaw[0] : (quoteRaw || null);
const livePrice = lq?.price ?? null;
const changePct = lq?.changesPercentage ?? null;
  const lm = Array.isArray(metrics) ? metrics[0] : (metrics || null);
  const lt = Array.isArray(targets) ? targets[0] : (targets || null);
  const ld = Array.isArray(dcf) ? dcf[0] : (dcf || null);
  const lr = Array.isArray(ratios) ? ratios[0] : (ratios || null);
  const lg = Array.isArray(growth) ? growth[0] : (growth || null);

  const data = {
    symbol: sym,
    price: livePrice,
    changePct: changePct,
    marketCap: lm?.marketCap ?? null,
    pe: lr?.priceToEarningsRatioTTM ? +lr.priceToEarningsRatioTTM.toFixed(1) : null,
    peg: lr?.priceToEarningsGrowthRatioTTM ? +lr.priceToEarningsGrowthRatioTTM.toFixed(2) : null,
    roe: lm?.returnOnEquityTTM ? +(lm.returnOnEquityTTM).toFixed(1) : null,
    revenueGrowth: lg?.growthRevenue != null ? +lg.growthRevenue.toFixed(4) : null,
    targetMean: lt?.targetConsensus ?? lt?.targetMedian ?? null,
    targetHigh: lt?.targetHigh ?? null,
    targetLow: lt?.targetLow ?? null,
    analystConsensus: !lt ? null : (((lt?.analystRatingsStrongBuy||0)+(lt?.analystRatingsBuy||0)) === 0 && ((lt?.analystRatingsSell||0)+(lt?.analystRatingsStrongSell||0)) === 0) ? null : ((lt?.analystRatingsStrongBuy||0)+(lt?.analystRatingsBuy||0)) > ((lt?.analystRatingsSell||0)+(lt?.analystRatingsStrongSell||0)) ? 'Bullish 📈' : 'Bearish 📉',
    dcfValue: ld?.dcf ?? null,
    grades: Array.isArray(grades) ? grades.slice(0,5) : []
  };

  // ── New data sources: financial history, price history, profile ───────────
  try {
    const [financials, priceHistory, profileInfo] = await Promise.all([
      fetchFinancials(sym),
      fetchPriceHistory(sym),
      fetchProfile(sym)
    ]);
    data.financials  = financials;
    data.priceHistory = priceHistory;
    data.companyName = profileInfo.companyName;
    data.beta        = profileInfo.beta;
    data.sector      = profileInfo.sector;
    data.description = profileInfo.description;
    data.website     = profileInfo.website;
  } catch (e) {
    data.financials  = [];
    data.priceHistory = [];
    data.companyName = null;
    data.beta        = null;
    data.sector      = null;
    data.description = null;
    data.website     = null;
  }

  let analysis = '';
  try {
    const prompt = `أنت محلل مالي متخصص في السوق الأمريكي. قدم تحليلاً شاملاً بالعربية للسهم التالي:

الرمز: ${sym}
السعر: $${data.price ?? '—'}
التغير اليوم: ${data.changePct != null ? data.changePct.toFixed(2) : '—'}%
P/E: ${data.pe ?? '—'}
PEG: ${data.peg ?? '—'}
ROE: ${data.roe != null ? data.roe+'%' : '—'}
هدف المحللين: $${data.targetMean ?? '—'}
DCF: $${data.dcfValue != null ? data.dcfValue.toFixed(0) : '—'}
توجه المحللين: ${data.analystConsensus ?? 'لا تغطية'}
القطاع: ${data.sector ?? '—'}
نمو الإيرادات: ${data.revenueGrowth != null ? (data.revenueGrowth*100).toFixed(1)+'%' : '—'}
بيتا: ${data.beta ?? '—'}

قدم التحليل في هذا الشكل:

## ملخص السهم
[سطر واحد فقط عن ما تفعله الشركة — موجز جداً]

## التقييم
[هل السهم رخيص أم غالٍ؟ مقارنة السعر بالهدف والـ DCF]

## نقاط القوة
[أبرز نقاط القوة الحقيقية — حتى 3 نقاط فقط إن وُجدت، لا تختلق نقاطاً]

## نقاط الضعف / المخاطر
[أبرز المخاطر الحقيقية — حتى 3 مخاطر فقط إن وُجدت، لا تختلق مخاطر]

## الحكم النهائي
[شراء قوي / شراء / احتفظ / خفف / بيع] مع سبب موجز

## الاستثمارية
[3-4 أسطر تربط بين جودة الشركة والتقييم الحالي ومستوى المخاطرة وتوقيت الدخول — اربط الأرقام ببعضها واشرح ما تعنيه معاً للمستثمر. لا تكرر الأرقام فقط، بل فسّر ما تعنيه.]

⚠️ هذا تحليل معلوماتي وليس توصية مالية.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const aiData = await aiRes.json();
    analysis = aiData.content?.[0]?.text || '';
    if (!analysis) analysis = 'خطأ: ' + JSON.stringify(aiData);
  } catch(e) {
    analysis = 'تعذر توليد التحليل: ' + e.message;
  }

  return res.status(200).json({ data, analysis });
}
// ── END STOCK LOOKUP ──────────────────────────────────────────────────────

  // Normal mode — require API key
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { nickname, include } = req.query;
  const wantIntelligence = include === 'intelligence';

  try {
    let holdings = [];
    let cash = {};
    let investorName = 'Rashed';
    let isGenericUser = false;
    let profile = {};

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

    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price = priceMap[h.sym] || h.cost;
      const value = Math.round(h.shares * price);
      const glPct = ((price - h.cost) / h.cost * 100);
      totalValue += value;
      return { ...h, livePrice: price, value, glPct };
    });
    enriched.sort((a, b) => b.value - a.value);

    const sectors = {
      tech:   { label: 'TECHNOLOGY',  items: [] },
      spec:   { label: 'SPECULATIVE', items: [] },
      bio:    { label: 'BIOTECH',     items: [] },
      mining: { label: 'MINING',      items: [] },
      etf:    { label: 'ETFs',        items: [] },
      other:  { label: 'OTHER',       items: [] },
    };
    enriched.forEach(h => { (sectors[h.sector] || sectors.other).items.push(h); });

    const pricesAvailable = Object.values(priceMap).filter(Boolean).length;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    let text = '';
    text += `═══════════════════════════════════════════════════════\n`;
    text += `${investorName.toUpperCase()}'S PORTFOLIO — Live as of ${timestamp}\n`;
    text += `Total Value: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
    text += `Live prices: ${pricesAvailable}/${symbols.length} stocks updated\n`;
    text += `═══════════════════════════════════════════════════════\n`;
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

    const riskTolerance    = profile.riskTolerance || 'low';
    const timeHorizon      = profile.timeHorizon   || 'long';
    const riskIsDefault    = !profile.riskTolerance;
    const horizonIsDefault = !profile.timeHorizon;
    const horizonLabel = { short: 'SHORT-TERM', medium: 'MEDIUM-TERM', long: 'LONG-TERM' }[timeHorizon]
                         || String(timeHorizon).toUpperCase();

    text += `\n═══════════════════════════════════════════════════════\n`;
    text += `INVESTOR PROFILE\n`;
    text += `═══════════════════════════════════════════════════════\n`;
    text += `Risk tolerance: ${riskTolerance.toUpperCase()}${riskIsDefault ? ' (default)' : ''}\n`;
    text += `Time horizon: ${horizonLabel}${horizonIsDefault ? ' (default)' : ''}\n`;
    if (profile.cashToInvest != null && Number.isFinite(+profile.cashToInvest)) {
      text += `Cash available to invest: $${(+profile.cashToInvest).toLocaleString()}\n`;
    }
    if (profile.goals)       text += `Goals: ${profile.goals}\n`;
    if (profile.constraints) text += `Constraints: ${profile.constraints}\n`;
    if (profile.notes)       text += `Notes: ${profile.notes}\n`;

    if (wantIntelligence) {

      const { date: marketDataDate, syms: moverSyms } = await fetchLatestMarketData();
      const top20     = enriched.filter(h => h.sector !== 'etf').slice(0, 20).map(h => h.sym);
      const top20tech = enriched.filter(h => h.sector !== 'etf').slice(0, 20).map(h => h.sym);
      const allSyms = [...new Set([...symbols, ...moverSyms])];
      const etfSyms = new Set(enriched.filter(h => h.sector === 'etf').map(h => h.sym));
      const insiderPortfolioSyms = enriched.filter(h => h.sector !== 'etf').map(h => h.sym);
      const insiderMoverSyms = moverSyms.filter(s => !ownedSet.has(s) && !etfSyms.has(s));
      const insiderSyms = [...new Set([...insiderPortfolioSyms, ...insiderMoverSyms])];
      const gradesFrom = daysAgoUAE(60);

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
        fmpGet(`/earnings-calendar?from=${todayUAE()}&to=${daysAheadUAE(60)}&symbol=${allSyms.join(',')}`),
        Promise.all(top20.map(sym => fmpGet(`/price-target-consensus?symbol=${sym}`))),
        Promise.all(top20.map(sym => fmpGet(`/grades?symbol=${sym}&limit=50`))),
        Promise.all(top20.map(sym => fmpGet(`/key-metrics-ttm?symbol=${sym}`))),
        Promise.allSettled(top20tech.map(sym => fetchTechnicals(sym))),
        Promise.all(top20.map(sym => fmpGet(`/earnings?symbol=${sym}&limit=8`))),
        Promise.all(top20.map(sym => fmpGet(`/discounted-cash-flow?symbol=${sym}`))),
        Promise.all(top20.map(sym => fmpGet(`/stock-price-change?symbol=${sym}`))),
        Promise.all(top20.map(sym => fmpGet(`/key-metrics?symbol=${sym}&period=annual&limit=5`))),
        Promise.all(top20.map(sym => fmpGet(`/ratios-ttm?symbol=${sym}`))),
        Promise.allSettled(insiderSyms.map(sym => fmpGet(`/insider-trading/statistics?symbol=${sym}`)))
      ]);

      const techMap = {};
      techResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          const t = result.value;
          const price = priceMap[t.sym];
          const entry = {
            rsi: t.rsi !== null ? +t.rsi.toFixed(2) : null,
            macd: t.macd !== null ? +t.macd.toFixed(4) : null,
            signal: t.signal !== null ? +t.signal.toFixed(4) : null,
            histogram: t.histogram !== null ? +t.histogram.toFixed(4) : null,
            sma50: t.sma50 !== null ? +t.sma50.toFixed(2) : null,
            sma200: t.sma200 !== null ? +t.sma200.toFixed(2) : null,
            ema20: t.ema20 !== null ? +t.ema20.toFixed(2) : null,
            atr:   t.atr  !== null ? +t.atr.toFixed(2)  : null,
            adx:   t.adx  !== null ? +t.adx.toFixed(1)  : null,
            aroonUp:   t.aroonUp   !== null ? +t.aroonUp.toFixed(0)   : null,
            aroonDown: t.aroonDown !== null ? +t.aroonDown.toFixed(0) : null,
            obvDir: t.obvDir || null,
            stochK: t.stochK !== null ? +t.stochK.toFixed(1) : null,
            priceChange1Y: t.priceChange1Y !== null ? +t.priceChange1Y.toFixed(1) : null
          };
          if (t.stddev !== null && price) {
            entry.bb_upper = +(price + 2 * t.stddev).toFixed(2);
            entry.bb_lower = +(price - 2 * t.stddev).toFixed(2);
          }
          const signals = [];
          if (entry.rsi !== null) {
            if (entry.rsi > 70) signals.push(`RSI ${entry.rsi} — OVERBOUGHT`);
            else if (entry.rsi < 30) signals.push(`RSI ${entry.rsi} — OVERSOLD`);
            else signals.push(`RSI ${entry.rsi} — neutral`);
          }
          if (entry.macd !== null && entry.signal !== null) {
            if (entry.macd > entry.signal && entry.histogram > 0) signals.push('MACD bullish ↑');
            else if (entry.macd < entry.signal && entry.histogram < 0) signals.push('MACD bearish ↓');
            else signals.push('MACD neutral');
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
            if (price >= entry.bb_upper) signals.push(`At BB upper (${entry.bb_upper}) — extended`);
            else if (price <= entry.bb_lower) signals.push(`At BB lower (${entry.bb_lower}) — compressed`);
            else {
              const pct = ((price - entry.bb_lower) / bbWidth * 100).toFixed(0);
              signals.push(`BB ${pct}% (${entry.bb_lower}–${entry.bb_upper})`);
            }
          }
          // New Session 25 indicators
          if (entry.adx !== null) {
            if (entry.adx >= 25) signals.push(`ADX ${entry.adx} — strong trend`);
            else signals.push(`ADX ${entry.adx} — weak/no trend`);
          }
          if (entry.aroonUp !== null && entry.aroonDown !== null) {
            if (entry.aroonUp > 70 && entry.aroonDown < 30)  signals.push(`Aroon bullish (up=${entry.aroonUp} dn=${entry.aroonDown})`);
            if (entry.aroonDown > 70 && entry.aroonUp < 30)  signals.push(`Aroon bearish (up=${entry.aroonUp} dn=${entry.aroonDown})`);
            if (entry.aroonUp > entry.aroonDown && entry.aroonUp > 50) signals.push(`Aroon turning up ↑`);
          }
          if (entry.obvDir) signals.push(`OBV ${entry.obvDir}`);
          if (entry.stochK !== null) {
            if (entry.stochK > 80) signals.push(`Stoch ${entry.stochK} — overbought`);
            else if (entry.stochK < 20) signals.push(`Stoch ${entry.stochK} — oversold`);
          }
          if (entry.priceChange1Y !== null) {
            signals.push(`52W change: ${entry.priceChange1Y >= 0 ? '+' : ''}${entry.priceChange1Y}%`);
          }
          if (entry.atr !== null && price) {
            const atrPct = (entry.atr / price * 100).toFixed(1);
            signals.push(`ATR $${entry.atr} (${atrPct}% daily range)`);
          }

          // Pattern detection
          const patterns = [];
          const isDown30 = entry.priceChange1Y !== null && entry.priceChange1Y < -30;
          const aroonTurning = entry.aroonUp !== null && entry.aroonDown !== null && entry.aroonUp > entry.aroonDown && entry.aroonUp > 50;
          const obvAccum = entry.obvDir === 'rising';
          const adxStrong = entry.adx !== null && entry.adx >= 25;
          const rsiMid = entry.rsi !== null && entry.rsi >= 50 && entry.rsi <= 68;
          const rsiOverbought = entry.rsi !== null && entry.rsi > 70;
          const obvFalling = entry.obvDir === 'falling';
          const adxWeak = entry.adx !== null && entry.adx < 20;

          if (isDown30 && aroonTurning && obvAccum) patterns.push('⚡ RECOVERY CANDIDATE');
          if (adxStrong && rsiMid && obvAccum)       patterns.push('🚀 BREAKOUT SETUP');
          if (rsiOverbought && obvFalling && adxWeak) patterns.push('🔴 DISTRIBUTION WARNING');

          entry.patterns = patterns;
          entry.signals = signals;
          techMap[t.sym] = entry;
        }
      });

      const gradeConsensusMap = {};
      top20.forEach((sym, idx) => {
        const allGrades = (gradeResults[idx] || []).filter(Boolean);
        if (!allGrades.length) { gradeConsensusMap[sym] = { consensus: 'no coverage', totalAnalysts: 0 }; return; }
        const firmLatest = {};
        allGrades.forEach(entry => { if (!firmLatest[entry.gradingCompany]) firmLatest[entry.gradingCompany] = entry.newGrade; });
        const latestGrades = Object.values(firmLatest);
        const bullish = latestGrades.filter(g => ['Buy','Strong Buy','Overweight','Outperform','Market Outperform','Positive'].includes(g)).length;
        const bearish = latestGrades.filter(g => ['Sell','Strong Sell','Underperform','Reduce','Underweight','Negative'].includes(g)).length;
        const neutral = latestGrades.length - bullish - bearish;
        gradeConsensusMap[sym] = {
          totalAnalysts: latestGrades.length, bullish, neutral, bearish,
          consensus: bullish > (neutral + bearish) ? 'Bullish' : bearish > (bullish + neutral) ? 'Bearish' : 'Mixed'
        };
      });

      const earnings = earningsRaw || [];
      const targets  = targetResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));
      const actionKeywords = ['upgrade','downgrade','initiat','reiterat','resumed','lower','raise'];
      const grades = gradeResults.flat().filter(Boolean)
        .filter(i => i.date >= gradesFrom)
        .filter(i => actionKeywords.some(kw => (i.action || '').toLowerCase().includes(kw)))
        .map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));
      const metrics = metricResults.flat().filter(Boolean).map(i => {
        const clean = { symbol: i.symbol, inPortfolio: ownedSet.has(i.symbol) };
        const keepFields = ['evToEBITDATTM','evToSalesTTM','returnOnEquityTTM','returnOnInvestedCapitalTTM','returnOnAssetsTTM','currentRatioTTM','earningsYieldTTM','freeCashFlowYieldTTM','netDebtToEBITDATTM','stockBasedCompensationToRevenueTTM','peRatioTTM','priceEarningsToGrowthRatioTTM'];
        keepFields.forEach(f => { if (i[f] != null) clean[f] = +i[f].toFixed(3); });
        return clean;
      });
      const earningsSorted = earnings.map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}))
        .sort((a, b) => { if (a.inPortfolio && !b.inPortfolio) return -1; if (!a.inPortfolio && b.inPortfolio) return 1; return new Date(a.date) - new Date(b.date); });

      const surpriseMap = {};
      surpriseResults.forEach((data, idx) => {
        const sym = top20[idx];
        if (!Array.isArray(data) || !data.length) { surpriseMap[sym] = null; return; }
        const recent = data.filter(q => (q.epsActual ?? q.eps ?? q.actualEarningResult) != null).slice(0, 4);
        if (!recent.length) { surpriseMap[sym] = null; return; }
        const getSurprisePct = q => {
          const actual = q.epsActual ?? q.eps ?? q.actualEarningResult;
          const estimate = q.epsEstimated ?? q.estimatedEarning;
          if (actual != null && estimate != null && estimate !== 0) return ((actual - estimate) / Math.abs(estimate)) * 100;
          return null;
        };
        const pattern = recent.map(q => { const pct = getSurprisePct(q); if (pct == null) return '?'; if (pct > 0.5) return 'B'; if (pct < -0.5) return 'W'; return 'M'; }).join('/');
        const validPcts = recent.map(getSurprisePct).filter(p => p != null);
        const beats = validPcts.filter(p => p > 0.5).length;
        const avgSurprise = validPcts.length ? validPcts.reduce((s, p) => s + p, 0) / validPcts.length : 0;
        const avgSurpriseCapped = Math.max(-500, Math.min(500, avgSurprise));
        surpriseMap[sym] = { pattern, beatRate: `${beats}/${recent.length}`, avgSurprisePct: +avgSurpriseCapped.toFixed(1) };
      });

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

      const weeklyChangeMap = {};
      priceChangeResults.forEach((data, idx) => {
        const sym  = top20[idx];
        const item = Array.isArray(data) ? data[0] : data;
        weeklyChangeMap[sym] = item?.['5D'] != null ? +item['5D'].toFixed(2) : null;
      });

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

      const marginsMap = {};
      ratiosResults.forEach((data, idx) => {
        const sym  = top20[idx];
        const item = Array.isArray(data) ? data[0] : data;
        if (!item) { marginsMap[sym] = { net: null, gross: null }; return; }
        marginsMap[sym] = {
          net:   item.netProfitMarginTTM   != null ? +(item.netProfitMarginTTM   * 100).toFixed(1) : null,
          gross: item.grossProfitMarginTTM != null ? +(item.grossProfitMarginTTM * 100).toFixed(1) : null
        };
      });

      const historicalPeMap = {};
      annualMetricResults.forEach((data, idx) => {
        const sym = top20[idx];
        if (!Array.isArray(data) || !data.length) { historicalPeMap[sym] = null; return; }
        const validPEs = data.map(d => { if (d.earningsYield != null && d.earningsYield > 0.001) return +(1 / d.earningsYield).toFixed(1); return null; }).filter(pe => pe != null && pe > 0 && pe < 1000);
        historicalPeMap[sym] = validPEs.length >= 2 ? +(validPEs.reduce((a, b) => a + b, 0) / validPEs.length).toFixed(1) : null;
      });

      const insiderMap = {};
      insiderResults.forEach((result, idx) => {
        const sym = insiderSyms[idx];
        if (result.status !== 'fulfilled' || !Array.isArray(result.value) || !result.value.length) { insiderMap[sym] = null; return; }
        const num = v => { const n = typeof v === 'number' ? v : parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
        const quarters = [...result.value].sort((a, b) => (num(b.year) - num(a.year)) || (num(b.quarter) - num(a.quarter))).slice(0, 4);
        const recentPurchases  = quarters.reduce((s, q) => s + num(q.totalPurchases), 0);
        const purchaseQuarters = quarters.filter(q => num(q.totalPurchases) > 0).length;
        const totalAcquired    = quarters.reduce((s, q) => s + num(q.totalAcquired), 0);
        const totalDisposed    = quarters.reduce((s, q) => s + num(q.totalDisposed), 0);
        const netSelling = totalDisposed > 0 && totalDisposed > totalAcquired * 3;
        let verdict;
        if (purchaseQuarters >= 2) verdict = `open-market buying in ${purchaseQuarters} of last 4 quarters → CONVICTION SIGNAL ✅`;
        else if (recentPurchases > 0) verdict = `open-market buying in 1 of last 4 quarters → mild positive`;
        else if (netSelling) verdict = `no open-market buying; routine comp selling only → NEUTRAL`;
        else verdict = `no open-market buying → NEUTRAL (no signal)`;
        insiderMap[sym] = { recentPurchases, purchaseQuarters, netSelling, verdict };
      });

      const metricsLookup = {};
      metricResults.flat().filter(Boolean).forEach(i => { metricsLookup[i.symbol] = i; });

      const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
      const finnhubMap = {};
      if (FINNHUB_KEY) {
        try {
          const finnhubResults = await Promise.allSettled(
            top20.map(async sym => {
              try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 5000);
                const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${FINNHUB_KEY}`, { signal: controller.signal });
                clearTimeout(timer);
                if (!r.ok) return { sym, data: null };
                const d = await r.json();
                const m = d?.metric || null;
                if (!m) return { sym, data: null };
                return { sym, data: { roe: m.roeTTM != null ? +(m.roeTTM).toFixed(2) : null, pe: m.peTTM != null ? +(m.peTTM).toFixed(1) : null, peg: m.pegTTM != null ? +(m.pegTTM).toFixed(2) : null, netMargin: m.netProfitMarginTTM != null ? +(m.netProfitMarginTTM).toFixed(1) : null, grossMargin: m.grossMarginTTM != null ? +(m.grossMarginTTM).toFixed(1) : null } };
              } catch { return { sym, data: null }; }
            })
          );
          finnhubResults.forEach(result => { if (result.status === 'fulfilled' && result.value) finnhubMap[result.value.sym] = result.value.data; });
        } catch (e) { /* continue without Finnhub */ }
      }

      function crossCheck(fmpVal, finnhubVal, fmtFn, isPegField) {
        const fmpOk = fmpVal != null && Number.isFinite(+fmpVal);
        const fhOk  = finnhubVal != null && Number.isFinite(+finnhubVal);
        if (!fmpOk && !fhOk) return 'N/A';
        if (!fmpOk) return `N/A (FMP) | Finnhub ${fmtFn(finnhubVal)}`;
        if (!fhOk)  return `${fmtFn(fmpVal)} (FMP only — Finnhub N/A)`;
        const diff = Math.abs((+fmpVal - +finnhubVal) / Math.abs(+fmpVal)) * 100;
        if (diff <= 10) return `${fmtFn(fmpVal)}  ✅ (FMP + Finnhub agree)`;
        else if (diff <= 20) return `FMP ${fmtFn(fmpVal)} | Finnhub ${fmtFn(finnhubVal)}  ℹ️ minor spread`;
        else if (isPegField) return `FMP ${fmtFn(fmpVal)} | Finnhub ${fmtFn(finnhubVal)}  ℹ️ range (growth assumptions differ)`;
        else return `FMP ${fmtFn(fmpVal)} | Finnhub ${fmtFn(finnhubVal)}  ⚠️ conflict — treat as low-confidence`;
      }

      const fmpHealthCount = metricResults.flat().filter(Boolean).length;
      const fmpPct = fmpHealthCount / top20.length;
      const fmpStatus = fmpPct >= 0.8 ? '✅' : fmpPct >= 0.5 ? '⚠️ degraded' : '✗ down';
      const fhCount = Object.values(finnhubMap).filter(v => v !== null).length;
      const fhPct = fhCount / top20.length;
      const fhStatus = !FINNHUB_KEY ? '✗ no key' : fhPct >= 0.8 ? '✅' : fhPct > 0 ? '⚠️ degraded' : '✗ unavailable';
      const yahooPct = symbols.length > 0 ? pricesAvailable / symbols.length : 0;
      const yahooStatus = yahooPct >= 0.8 ? '✅' : yahooPct >= 0.5 ? '⚠️ degraded' : '✗ down';

      text += `\n═══════════════════════════════════════════════════════\n`;
      text += `MARKET INTELLIGENCE — ${todayUAE()}\n`;
      text += `Portfolio: ${symbols.join(', ')}\n`;
      text += `Movers data: ${marketDataDate ? `from ${marketDataDate}` : 'unavailable'} — ${moverSyms.join(', ') || 'none'}\n`;
      text += `═══════════════════════════════════════════════════════\n\n`;
      text += `SOURCE HEALTH — ${todayUAE()}\n`;
      text += `  Yahoo prices: ${pricesAvailable}/${symbols.length} updated ${yahooStatus}\n`;
      text += `  FMP:          ${fmpHealthCount}/${top20.length} stocks with metrics ${fmpStatus}\n`;
      text += `  Finnhub:      ${fhCount}/${top20.length} stocks cross-checked ${fhStatus}\n\n`;

      text += `TECHNICAL INDICATORS (top 20 non-ETF stocks):\n`;
      text += `${'SYM'.padEnd(7)} ${'RSI'.padEnd(7)} ${'MACD'.padEnd(10)} ${'SMA50'.padEnd(9)} ${'SMA200'.padEnd(9)} ${'EMA20'.padEnd(9)} BB\n`;
      text += `────────────────────────────────────────────────────────────────────\n`;
      top20tech.forEach(sym => {
        const t = techMap[sym];
        if (!t) { text += `${sym.padEnd(7)} N/A\n`; return; }
        text += `${sym.padEnd(7)} ${(t.rsi != null ? String(t.rsi) : 'N/A').padEnd(7)} ${(t.macd != null ? String(t.macd) : 'N/A').padEnd(10)} ${(t.sma50 != null ? String(t.sma50) : 'N/A').padEnd(9)} ${(t.sma200 != null ? String(t.sma200) : 'N/A').padEnd(9)} ${(t.ema20 != null ? String(t.ema20) : 'N/A').padEnd(9)} ${t.bb_upper || 'N/A'} / ${t.bb_lower || 'N/A'}\n`;
      });
      text += `\nSIGNAL INTERPRETATION:\n`;
      top20tech.forEach(sym => { const t = techMap[sym]; if (t?.signals?.length) text += `${sym}: ${t.signals.join(' | ')}\n`; });
      text += `\n`;

      // Pattern detection output
      const patternsFound = top20tech.filter(sym => techMap[sym]?.patterns?.length);
      if (patternsFound.length) {
        text += `PATTERN DETECTION:\n`;
        patternsFound.forEach(sym => {
          const t = techMap[sym];
          text += `${sym.padEnd(7)} ${t.patterns.join(' + ')}\n`;
        });
        text += `\n`;
      }

      // Dynamic weight context block
      text += `DYNAMIC WEIGHT CONTEXT (scoring modifiers this run):\n`;
      text += `Base weights: L1=15% (macro) · L2=25% (fundamentals) · L3=30% (technicals) · L4=20% (sentiment) · L5=10% (risk)\n`;
      text += `Profile: risk=${profile?.riskTolerance || 'low'} · horizon=${profile?.timeHorizon || 'long'}\n`;
      // Profile-driven modifiers
      const risk = (profile?.riskTolerance || 'low').toLowerCase();
      const horizon = (profile?.timeHorizon || 'long').toLowerCase();
      if (horizon === 'long' && risk === 'low')   text += `Profile modifier: L2+3% L3-3% (value over timing — long/low)\n`;
      else if (risk === 'high' && horizon !== 'long') text += `Profile modifier: L3+7% L2-5% L4-2% (technicals dominate — high risk)\n`;
      else text += `Profile modifier: base weights (medium profile)\n`;
      // Per-stock context modifiers
      const totalVal = enriched.reduce((s, h) => s + h.value, 0);
      top20tech.forEach(sym => {
        const h = enriched.find(x => x.sym === sym);
        const t = techMap[sym];
        if (!h || !t) return;
        const mods = [];
        if (t.patterns?.includes('⚡ RECOVERY CANDIDATE'))          mods.push('L3+5% L2-3% (recovery pattern)');
        if (totalVal > 0 && (h.value / totalVal) > 0.08)           mods.push('L1+5% L3-3% (overweight >8%)');
        if (t.priceChange1Y !== null && t.priceChange1Y > 20 && t.rsi !== null && t.rsi > 60) mods.push('L2+3% L3-3% (near 52W high)');
        if (mods.length) text += `  ${sym.padEnd(7)} ${mods.join(' | ')}\n`;
      });
      text += `\n`;

      text += `EARNINGS SURPRISES — last 4 quarters:\n`;
      top20.forEach(sym => {
        const s = surpriseMap[sym];
        if (!s) { text += `${sym.padEnd(7)} N/A\n`; return; }
        text += `${sym.padEnd(7)} ${s.pattern.padEnd(12)} beat_rate=${s.beatRate}  avg_surprise=${s.avgSurprisePct >= 0 ? '+' : ''}${s.avgSurprisePct}%\n`;
      });
      text += `\n`;

      text += `DCF FAIR VALUES:\n`;
      top20.forEach(sym => {
        const d = dcfMap[sym];
        const price = priceMap[sym];
        if (!d) { text += `${sym.padEnd(7)} DCF=N/A\n`; return; }
        const arrow = d.upside > 10 ? '↑ undervalued' : d.upside < -10 ? '↓ overvalued' : '→ fair';
        text += `${sym.padEnd(7)} dcf=$${d.dcf}  price=$${price?.toFixed(2) || 'N/A'}  upside=${d.upside >= 0 ? '+' : ''}${d.upside}%  ${arrow}\n`;
      });
      text += `\n`;

      text += `WEEKLY PRICE CHANGE:\n`;
      top20.forEach(sym => { const w = weeklyChangeMap[sym]; text += `${sym.padEnd(7)} ${w != null ? `${w >= 0 ? '+' : ''}${w}%` : 'N/A'}\n`; });
      text += `\n`;

      text += `HISTORICAL P/E + PEG:\n`;
      top20.forEach(sym => {
        const hist = historicalPeMap[sym];
        const currentPE = ratiosPeMap[sym] ?? (metricsLookup[sym]?.peRatioTTM != null ? +metricsLookup[sym].peRatioTTM.toFixed(1) : null);
        const peg = pegMap[sym];
        if (!hist && !currentPE && !peg) { text += `${sym.padEnd(7)} N/A\n`; return; }
        let note = '';
        if (hist && currentPE) { if (currentPE < hist * 0.85) note = ' → BELOW historical avg'; else if (currentPE > hist * 1.15) note = ' → ABOVE historical avg'; else note = ' → near historical avg'; }
        text += `${sym.padEnd(7)} hist5Y=${hist != null ? hist+'x' : 'N/A'}  currentPE=${currentPE != null ? currentPE+'x' : 'N/A'}${peg != null ? `  peg=${peg}x${peg < 1 ? ' (undervalued)' : peg > 2 ? ' (expensive)' : ''}` : ''}${note}\n`;
      });
      text += `\n`;

      text += `ANALYST CONSENSUS:\n`;
      top20.forEach(sym => {
        const c = gradeConsensusMap[sym];
        if (!c || c.totalAnalysts === 0) { text += `${sym.padEnd(7)} no analyst coverage\n`; return; }
        text += `${sym.padEnd(7)} consensus=${c.consensus.padEnd(9)} analysts=${c.totalAnalysts}  (${c.bullish} buy / ${c.neutral} neutral / ${c.bearish} sell)\n`;
      });
      text += `\n`;

      text += `═══════════════════════════════════════════════════════\n`;
      text += `INSIDER ACTIVITY (last 4 quarters)\n`;
      text += `═══════════════════════════════════════════════════════\n`;
      const renderInsider = sym => { const ins = insiderMap[sym]; if (!ins) { text += `${sym.padEnd(6)} — no insider data\n`; return; } text += `${sym.padEnd(6)} — ${ins.verdict}\n`; };
      insiderPortfolioSyms.forEach(renderInsider);
      if (insiderMoverSyms.length) { text += `--- movers ---\n`; insiderMoverSyms.forEach(renderInsider); }
      text += `\n`;

      text += `EARNINGS CALENDAR (next 60 days):\n`;
      text += JSON.stringify({ portfolio: earningsSorted.filter(e => e.inPortfolio), movers: earningsSorted.filter(e => !e.inPortfolio).slice(0, 5) }, null, 2) + '\n\n';

      try {
        const fmtPct = v => (v != null && Number.isFinite(+v)) ? `${(+v).toFixed(1)}%` : 'N/A';
        const fmtNum = (v, d = 2) => (v != null && Number.isFinite(+v)) ? (+v).toFixed(d) : 'N/A';
        const present = v => v != null && Number.isFinite(+v);
        const targetMap = {};
        targets.forEach(t => { if (t && t.symbol) targetMap[t.symbol] = t; });
        const gradesBySym = {};
        grades.forEach(g => { if (!g || !g.symbol) return; (gradesBySym[g.symbol] = gradesBySym[g.symbol] || []).push(g); });
        const DQ_FIELDS = ['ROE', 'ROIC', 'PE', 'PEG', 'netMargin', 'grossMargin', 'DCF', 'priceTarget'];
        const dq = {};
        const perFieldMissing = Object.fromEntries(DQ_FIELDS.map(f => [f, 0]));
        const finnhubAvailable = FINNHUB_KEY && Object.keys(finnhubMap).length > 0;

        text += `ANALYST PRICE TARGETS:\n`;
        top20.forEach(sym => {
          const t = targetMap[sym];
          const price = priceMap[sym];
          if (!t) { text += `${sym}: N/A\n`; return; }
          const consensus = t.targetConsensus ?? t.targetMedian ?? null;
          const vsPrice = (present(consensus) && present(price)) ? `  vs price: ${consensus >= price ? '+' : ''}${(((consensus - price) / price) * 100).toFixed(1)}%` : '';
          text += `${sym}: consensus ${fmtNum(consensus)}  high/low ${fmtNum(t.targetHigh, 0)}/${fmtNum(t.targetLow, 0)}${vsPrice}\n`;
        });
        text += `\n`;

        text += `ANALYST GRADES — last 60 days:\n`;
        top20.forEach(sym => {
          const gs = gradesBySym[sym] || [];
          if (!gs.length) { text += `${sym}: no rating changes\n`; return; }
          const ups = gs.filter(g => (g.action||'').toLowerCase().includes('upgrade') || (g.action||'').toLowerCase().includes('raise')).length;
          const downs = gs.filter(g => (g.action||'').toLowerCase().includes('downgrade') || (g.action||'').toLowerCase().includes('lower')).length;
          const inits = gs.filter(g => (g.action||'').toLowerCase().includes('initiat') || (g.action||'').toLowerCase().includes('resumed')).length;
          const parts = [];
          if (ups) parts.push(`${ups} upgrade${ups > 1 ? 's' : ''}`);
          if (downs) parts.push(`${downs} downgrade${downs > 1 ? 's' : ''}`);
          if (inits) parts.push(`${inits} initiation${inits > 1 ? 's' : ''}`);
          text += `${sym}: ${parts.join(', ') || `${gs.length} rating change(s)`}\n`;
        });
        text += `\n`;

        text += `KEY METRICS (top 20 non-ETF):\n`;
        top20.forEach(sym => {
          const m = metricsLookup[sym] || {};
          const r = ratiosPeMap[sym];
          const peg = pegMap[sym];
          const dcf = dcfMap[sym];
          const tgt = targetMap[sym];
          const tgtConsensus = tgt ? (tgt.targetConsensus ?? tgt.targetMedian ?? null) : null;
          const fh = finnhubMap[sym] || null;
          const roe = m.returnOnEquityTTM != null ? m.returnOnEquityTTM * 100 : null;
          const roic = m.returnOnInvestedCapitalTTM != null ? m.returnOnInvestedCapitalTTM * 100 : null;
          const pe = r ?? (m.peRatioTTM ?? null);
          const netMrg = marginsMap[sym] ? marginsMap[sym].net : null;
          const grossMrg = marginsMap[sym] ? marginsMap[sym].gross : null;
          const dcfVal = dcf ? dcf.dcf : null;
          dq[sym] = { ROE: present(roe), ROIC: present(roic), PE: present(pe), PEG: present(peg), netMargin: present(netMrg), grossMargin: present(grossMrg), DCF: present(dcfVal), priceTarget: present(tgtConsensus) };
          DQ_FIELDS.forEach(f => { if (!dq[sym][f]) perFieldMissing[f]++; });
          text += `KEY METRICS — ${sym}\n`;
          text += `  ROE:          ${crossCheck(roe, fh?.roe, fmtPct, false)}\n`;
          text += `  P/E (TTM):    ${crossCheck(pe, fh?.pe, v => fmtNum(v,1), false)}\n`;
          text += `  PEG:          ${crossCheck(peg, fh?.peg, v => fmtNum(v,2), true)}\n`;
          text += `  Net margin:   ${crossCheck(netMrg, fh?.netMargin, fmtPct, false)}\n`;
          text += `  Gross margin: ${crossCheck(grossMrg, fh?.grossMargin, fmtPct, false)}\n`;
          text += `  ROIC:         ${fmtPct(roic)}\n`;
          text += `  DCF fair $:   ${fmtNum(dcfVal)}\n`;
          text += `  Price target: ${fmtNum(tgtConsensus)}\n`;
        });
        text += `\n`;

        text += `═══ DATA_QUALITY ═══\n`;
        let totalMissing = 0, stocksWithGaps = 0;
        top20.forEach(sym => {
          const row = dq[sym] || {};
          const miss = DQ_FIELDS.filter(f => !row[f]).length;
          totalMissing += miss;
          if (miss > 0) stocksWithGaps++;
          text += `${sym}: ${DQ_FIELDS.map(f => `${f}=${row[f] ? '✓' : '✗'}`).join(' ')} | missing=${miss}\n`;
        });
        text += `SUMMARY: ${top20.length} stocks · ${totalMissing} field(s) missing across ${stocksWithGaps} stock(s)\n`;
        text += `═══ END DATA_QUALITY ═══\n`;

        const fieldDisplayNames = { ROE: 'ROE', ROIC: 'ROIC', PE: 'P/E', PEG: 'PEG', netMargin: 'net margin', grossMargin: 'gross margin', DCF: 'DCF', priceTarget: 'price target' };
        const transparencyLines = {};
        top20.forEach(sym => {
          const row = dq[sym] || {};
          const missingFields = DQ_FIELDS.filter(f => !row[f]);
          if (missingFields.length <= 1) { transparencyLines[sym] = null; return; }
          const fieldList = missingFields.map(f => fieldDisplayNames[f] || f).join(', ');
          const icon = missingFields.length >= 4 ? '🔴' : '⚠️';
          transparencyLines[sym] = `${icon} ${sym} — Score analysis was done without: ${fieldList}${missingFields.length >= 4 ? ' (low-confidence score)' : ''}`;
        });
        const stocksWithWarnings = top20.filter(s => transparencyLines[s]);
        text += `\n═══ TRANSPARENCY ═══\n`;
        text += `QUALITY SUMMARY: ${stocksWithWarnings.length === 0 ? `all ${top20.length} stocks fully covered` : `${top20.length - stocksWithWarnings.length}/${top20.length} fully covered`}\n`;
        top20.forEach(sym => { if (transparencyLines[sym]) text += `${sym}: ${transparencyLines[sym]}\n`; });
        text += `═══ END TRANSPARENCY ═══\n`;

      } catch (e) {
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
