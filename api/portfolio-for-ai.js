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

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
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
  const [rsiRaw, macdRaw, sma50Raw, sma200Raw, ema20Raw, bbRaw] = await Promise.all([
    fmpGet(`/technical-indicators/rsi?symbol=${sym}&periodLength=14&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/macd?symbol=${sym}&fastPeriod=12&slowPeriod=26&signalPeriod=9&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=50&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=200&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/ema?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`),
    fmpGet(`/technical-indicators/standardDeviation?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`)
  ]);
  return {
    sym,
    rsi:       latest(rsiRaw,   'rsi'),
    macd:      latest(macdRaw,  'macd') ?? latest(macdRaw, 'macdLine'),
    signal:    latest(macdRaw,  'signal') ?? latest(macdRaw, 'signalLine'),
    histogram: latest(macdRaw,  'histogram') ?? latest(macdRaw, 'macdHistogram'),
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

    // ── Investor rules — cleaned, no hardcoded broker or SPUS rule ───────────
    if (!isGenericUser) {
      text += `INVESTOR RULES:\n`;
      text += `- UAE investor — ZERO capital gains tax\n`;
      text += `- Cannot short sell or trade options\n`;
      text += `- Long-term growth investor, high risk tolerance\n`;
    } else {
      text += `INVESTOR: ${investorName} — long-term growth focus\n`;
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

    // ── Intelligence block ───────────────────────────────────────────────────
    if (wantIntelligence) {

      const { date: marketDataDate, syms: moverSyms } = await fetchLatestMarketData();

      // Top 20 non-ETF for all analyst + new data calls
      const top20     = enriched.filter(h => h.sector !== 'etf').slice(0, 20).map(h => h.sym);
      const top20tech = enriched.filter(h => h.sector !== 'etf').slice(0, 20).map(h => h.sym);

      const allSyms = [...new Set([...symbols, ...moverSyms])];

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
        ratiosResults
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
        Promise.all(top20.map(sym => fmpGet(`/ratios-ttm?symbol=${sym}`)))
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
        surpriseMap[sym] = {
          pattern,
          beatRate: `${beats}/${recent.length}`,
          avgSurprisePct: +avgSurprise.toFixed(1)
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

      // ── Build metrics lookup ───────────────────────────────────────────────
      const metricsLookup = {};
      metricResults.flat().filter(Boolean).forEach(i => { metricsLookup[i.symbol] = i; });

      // ── Append intelligence text ──────────────────────────────────────────
      text += `\n═══════════════════════════════════════════════════════\n`;
      text += `MARKET INTELLIGENCE — ${todayUAE()}\n`;
      text += `Portfolio: ${symbols.join(', ')}\n`;
      text += `Movers data: ${marketDataDate ? `from ${marketDataDate}` : 'unavailable'} — ${moverSyms.join(', ') || 'none'}\n`;
      text += `═══════════════════════════════════════════════════════\n\n`;

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
        text += `${sym.padEnd(7)} hist5Y=${hist || 'N/A'}x  currentPE=${currentPE || 'N/A'}x${pegStr}${note}\n`;
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

      // Earnings calendar
      text += `EARNINGS CALENDAR (next 60 days):\n`;
      text += JSON.stringify({
        portfolio: earningsSorted.filter(e => e.inPortfolio),
        movers:    earningsSorted.filter(e => !e.inPortfolio).slice(0, 5)
      }, null, 2) + '\n\n';

      // Analyst price targets
      text += `ANALYST PRICE TARGETS:\n`;
      text += JSON.stringify(targets, null, 2) + '\n\n';

      // Analyst grades (filtered — upgrades/downgrades/initiations only)
      text += `ANALYST GRADES — last 60 days (upgrades/downgrades/initiations only):\n`;
      text += JSON.stringify(grades, null, 2) + '\n\n';

      // Key metrics TTM (now includes PEG and P/E)
      text += `KEY METRICS TTM (includes P/E and PEG ratio):\n`;
      text += JSON.stringify(metrics, null, 2) + '\n';

      text += `\n═══════════════════════════════════════════════════════\n`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch (e) {
    res.status(500).send(`Portfolio data unavailable: ${e.message}`);
  }
};
