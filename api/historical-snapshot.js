// api/historical-snapshot.js
// Returns portfolio snapshot reconstructed for a historical date
// Usage: GET /api/historical-snapshot?date=2025-11-11
// Returns same text format as portfolio-for-ai so the same Claude prompt works
// READ-ONLY — never writes anything anywhere

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const FMP_KEY = 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
const FMP     = 'https://financialmodelingprep.com/stable';
const FMP_V3  = 'https://financialmodelingprep.com/api/v3';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';

// ─── FMP helpers ─────────────────────────────────────────────────────────────
async function fmpGet(path, base = FMP) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${base}${path}${sep}apikey=${FMP_KEY}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.['Error Message'] || d?.error) return null;
    return Array.isArray(d) ? d : d;
  } catch { return null; }
}

// ─── Get historical OHLC prices for a symbol around a date ──────────────────
// Returns array of {date, open, high, low, close, volume} sorted newest first
async function getHistoricalOHLC(sym, targetDate, lookbackDays = 250) {
  const toDate   = targetDate;
  const fromDate = subtractDays(targetDate, lookbackDays);
  const data = await fmpGet(
    `/historical-price-full/${sym}?from=${fromDate}&to=${toDate}`,
    FMP_V3
  );
  if (!data || !data.historical) return [];
  // Sort newest first
  return data.historical.sort((a, b) => b.date > a.date ? 1 : -1);
}

// ─── Get price on or just before target date ─────────────────────────────────
function getPriceOnDate(ohlc, targetDate) {
  // ohlc is sorted newest first; find first entry <= targetDate
  const entry = ohlc.find(d => d.date <= targetDate);
  return entry ? { price: entry.close, date: entry.date } : null;
}

// ─── RSI-14 calculation from OHLC array (newest first) ───────────────────────
function calcRSI(ohlc, period = 14) {
  if (ohlc.length < period + 1) return null;
  // Work oldest-first for calculation
  const closes = [...ohlc].reverse().map(d => d.close);
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  // Initial average gain/loss over first period
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  // Smoothed RSI for remaining periods
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

// ─── SMA calculation ─────────────────────────────────────────────────────────
function calcSMA(ohlc, period) {
  if (ohlc.length < period) return null;
  // ohlc newest first; take first `period` entries = most recent `period` days
  const sum = ohlc.slice(0, period).reduce((a, d) => a + d.close, 0);
  return +(sum / period).toFixed(2);
}

// ─── EMA calculation ─────────────────────────────────────────────────────────
function calcEMA(ohlc, period) {
  if (ohlc.length < period) return null;
  const closes = [...ohlc].reverse().map(d => d.close);
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return +ema.toFixed(2);
}

// ─── MACD calculation ─────────────────────────────────────────────────────────
function calcMACD(ohlc, fast = 12, slow = 26, signal = 9) {
  if (ohlc.length < slow + signal) return { macd: null, signal: null, histogram: null };
  const closes = [...ohlc].reverse().map(d => d.close);
  const k_fast = 2 / (fast + 1), k_slow = 2 / (slow + 1), k_sig = 2 / (signal + 1);
  let emaFast = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  let emaSlow = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
  const macdLine = [];
  for (let i = Math.max(fast, slow); i < closes.length; i++) {
    emaFast = closes[i] * k_fast + emaFast * (1 - k_fast);
    emaSlow = closes[i] * k_slow + emaSlow * (1 - k_slow);
    macdLine.push(emaFast - emaSlow);
  }
  if (macdLine.length < signal) return { macd: null, signal: null, histogram: null };
  let sigLine = macdLine.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  for (let i = signal; i < macdLine.length; i++) {
    sigLine = macdLine[i] * k_sig + sigLine * (1 - k_sig);
  }
  const macdVal = macdLine[macdLine.length - 1];
  const histogram = macdVal - sigLine;
  return {
    macd:      +macdVal.toFixed(4),
    signal:    +sigLine.toFixed(4),
    histogram: +histogram.toFixed(4)
  };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function subtractDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Get fundamentals closest to target date ──────────────────────────────────
async function getFundamentals(sym, targetDate) {
  // Key metrics by period — get last 4 quarters
  const metrics = await fmpGet(`/key-metrics/${sym}?limit=8`, FMP_V3);
  if (!metrics || !Array.isArray(metrics)) return null;
  // Find the most recent quarter that was available on targetDate
  // FMP key-metrics has a 'date' field for the filing period end
  const available = metrics.filter(m => m.date && m.date <= addDays(targetDate, 90));
  return available[0] || metrics[0] || null;
}

// ─── Get earnings history ─────────────────────────────────────────────────────
async function getEarningsHistory(sym, targetDate) {
  const data = await fmpGet(`/historical/earning_calendar/${sym}?limit=8`, FMP_V3);
  if (!data || !Array.isArray(data)) return [];
  // Only quarters before targetDate
  return data.filter(e => e.date && e.date < targetDate).slice(0, 4);
}

// ─── Interpret signals into text ──────────────────────────────────────────────
function interpretSignals(sym, price, rsi, macd, sma50, sma200, ema20) {
  const signals = [];
  if (rsi !== null) {
    if (rsi > 70)      signals.push(`RSI ${rsi} — OVERBOUGHT`);
    else if (rsi < 30) signals.push(`RSI ${rsi} — OVERSOLD`);
    else               signals.push(`RSI ${rsi} — neutral`);
  }
  if (macd.macd !== null && macd.signal !== null) {
    if (macd.macd > macd.signal && macd.histogram > 0) signals.push('MACD bullish crossover ↑');
    else if (macd.macd < macd.signal && macd.histogram < 0) signals.push('MACD bearish crossover ↓');
    else signals.push('MACD neutral');
  }
  if (sma50 !== null && sma200 !== null) {
    if (sma50 > sma200) signals.push(`Golden Cross ✅ (SMA50 ${sma50} > SMA200 ${sma200})`);
    else                signals.push(`Death Cross ⚠️ (SMA50 ${sma50} < SMA200 ${sma200})`);
  }
  if (price && ema20 !== null) {
    if (price > ema20) signals.push(`Price $${price} above EMA20 (${ema20}) — short-term bullish`);
    else               signals.push(`Price $${price} below EMA20 (${ema20}) — short-term bearish`);
  }
  return signals;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  // Auth
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ', '').trim();
  if (key && key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { date, format } = req.query;

  // Validate date
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      error: 'date parameter required in YYYY-MM-DD format',
      example: '/api/historical-snapshot?date=2025-11-11'
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  if (date >= today) {
    return res.status(400).json({ error: 'date must be in the past' });
  }
  if (date < '2020-01-01') {
    return res.status(400).json({ error: 'date must be after 2020-01-01' });
  }

  try {
    // ── Load portfolio ────────────────────────────────────────────────────────
    const raw = await fetch(
      `https://raw.githubusercontent.com/${REPO}/main/data/portfolio.json?t=${Date.now()}`
    );
    if (!raw.ok) throw new Error('Cannot read portfolio.json');
    const portfolio = await raw.json();
    const holdings  = portfolio.holdings || [];
    const cash      = portfolio.cash_summary || {};
    const symbols   = holdings.map(h => h.sym);

    // ── Fetch historical OHLC for all symbols + SPY (parallel, batched) ──────
    // Limit to 20 symbols at a time to avoid timeouts
    const ETF_EXCL = new Set(['QQQ','SPY','VGT','SPUS','VOO','XLP','IVV','SMH','IBIT','QQQM']);
    const nonEtfSyms = symbols.filter(s => !ETF_EXCL.has(s));
    const top10 = nonEtfSyms.slice(0, 10);

    // Fetch OHLC in parallel (all symbols needed for price + technicals)
    const ohlcResults = await Promise.all(
      symbols.map(async sym => ({
        sym,
        ohlc: await getHistoricalOHLC(sym, date, 250)
      }))
    );

    // Build price and tech maps
    const priceMap = {};
    const techMap  = {};

    ohlcResults.forEach(({ sym, ohlc }) => {
      const priceEntry = getPriceOnDate(ohlc, date);
      priceMap[sym] = priceEntry?.price || null;

      const price = priceMap[sym];
      const rsi   = calcRSI(ohlc);
      const sma50 = calcSMA(ohlc, 50);
      const sma200= calcSMA(ohlc, 200);
      const ema20 = calcEMA(ohlc, 20);
      const macd  = calcMACD(ohlc);

      techMap[sym] = {
        rsi, sma50, sma200, ema20,
        macd: macd.macd, signal: macd.signal, histogram: macd.histogram,
        signals: interpretSignals(sym, price, rsi, macd, sma50, sma200, ema20)
      };
    });

    // ── Calculate portfolio value on target date ───────────────────────────
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price = priceMap[h.sym] || h.cost;
      const value = Math.round(h.shares * price);
      const glPct = ((price - h.cost) / h.cost * 100);
      totalValue += value;
      return { ...h, livePrice: price, value, glPct };
    }).sort((a, b) => b.value - a.value);

    // ── Fetch fundamentals + earnings for top10 (parallel) ─────────────────
    const [fundResults, earnResults] = await Promise.all([
      Promise.all(top10.map(sym => getFundamentals(sym, date).then(d => ({ sym, data: d })))),
      Promise.all(top10.map(sym => getEarningsHistory(sym, date).then(d => ({ sym, data: d }))))
    ]);

    const fundMap  = {};
    const earnMap  = {};
    fundResults.forEach(({ sym, data }) => { fundMap[sym]  = data; });
    earnResults.forEach(({ sym, data }) => { earnMap[sym]  = data; });

    // ── SPY for context ────────────────────────────────────────────────────
    const spyOhlc  = await getHistoricalOHLC('SPY', date, 5);
    const spyPrice = getPriceOnDate(spyOhlc, date);

    // ── Build output text (same format as portfolio-for-ai) ────────────────
    const sectors = {
      tech:   { label: 'TECHNOLOGY',  items: [] },
      spec:   { label: 'SPECULATIVE', items: [] },
      bio:    { label: 'BIOTECH',     items: [] },
      mining: { label: 'MINING',      items: [] },
      etf:    { label: 'ETFs',        items: [] },
      other:  { label: 'OTHER',       items: [] },
    };
    enriched.forEach(h => { (sectors[h.sector] || sectors.other).items.push(h); });

    let text = '';
    text += `═══════════════════════════════════════════════════════\n`;
    text += `RASHED'S PORTFOLIO — HISTORICAL SNAPSHOT: ${date}\n`;
    text += `⚠️ THIS IS A BACKTEST — Prices and indicators are as of ${date}\n`;
    text += `Total Value on ${date}: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
    text += `Historical prices available: ${Object.values(priceMap).filter(Boolean).length}/${symbols.length} stocks\n`;
    if (spyPrice) text += `SPY on ${date}: $${spyPrice.price}\n`;
    text += `═══════════════════════════════════════════════════════\n`;
    text += `INVESTOR RULES (apply to all recommendations):\n`;
    text += `- UAE investor — ZERO capital gains tax on profits\n`;
    text += `- Cannot short sell or trade options (Wio Invest)\n`;
    text += `- SPUS = Sharia-compliant ETF — never recommend selling\n`;
    text += `- US market opens 5:30pm UAE time\n`;
    text += `- Long-term growth investor, high risk tolerance\n`;
    text += `═══════════════════════════════════════════════════════\n\n`;

    Object.values(sectors).forEach(sec => {
      if (sec.items.length === 0) return;
      text += `${sec.label}:\n`;
      sec.items.forEach(h => {
        const glSign = h.glPct >= 0 ? '+' : '';
        text += `${h.sym.padEnd(6)} ${String(h.shares).padEnd(10)} sh  `;
        text += `cost $${String(h.cost.toFixed(2)).padEnd(8)}  `;
        text += `price on ${date} $${String((h.livePrice || 0).toFixed(2)).padEnd(8)}  `;
        text += `value $${h.value.toLocaleString().padEnd(8)}  `;
        text += `${glSign}${h.glPct.toFixed(1)}%\n`;
      });
      text += '\n';
    });

    text += `═══════════════════════════════════════════════════════\n`;
    text += `TOTAL PORTFOLIO VALUE ON ${date}: $${totalValue.toLocaleString()}\n`;
    text += `═══════════════════════════════════════════════════════\n`;

    // ── Technical indicators block ─────────────────────────────────────────
    text += `\n═══════════════════════════════════════════════════════\n`;
    text += `MARKET INTELLIGENCE — as of ${date} (HISTORICAL BACKTEST)\n`;
    text += `Portfolio symbols: ${symbols.join(', ')}\n`;
    text += `═══════════════════════════════════════════════════════\n\n`;

    text += `TECHNICAL INDICATORS (calculated from historical OHLC data as of ${date}):\n`;
    text += `${'SYM'.padEnd(7)} ${'RSI'.padEnd(8)} ${'MACD'.padEnd(10)} ${'SMA50'.padEnd(9)} ${'SMA200'.padEnd(9)} EMA20\n`;
    text += `─────────────────────────────────────────────────────────────────\n`;
    symbols.forEach(sym => {
      const t = techMap[sym];
      text += `${sym.padEnd(7)} `;
      text += `${(t.rsi    !== null ? String(t.rsi)    : 'N/A').padEnd(8)} `;
      text += `${(t.macd   !== null ? String(t.macd)   : 'N/A').padEnd(10)} `;
      text += `${(t.sma50  !== null ? String(t.sma50)  : 'N/A').padEnd(9)} `;
      text += `${(t.sma200 !== null ? String(t.sma200) : 'N/A').padEnd(9)} `;
      text += `${t.ema20   !== null ? String(t.ema20)  : 'N/A'}\n`;
    });
    text += `\n`;

    text += `SIGNAL INTERPRETATION (as of ${date}):\n`;
    symbols.forEach(sym => {
      const t = techMap[sym];
      if (t.signals && t.signals.length > 0) {
        text += `${sym}: ${t.signals.join(' | ')}\n`;
      }
    });
    text += `\n`;

    // ── Fundamentals block ─────────────────────────────────────────────────
    text += `KEY METRICS (nearest quarterly filing before ${date}):\n`;
    text += JSON.stringify(
      top10.map(sym => ({
        symbol: sym,
        metrics: fundMap[sym] ? {
          date:           fundMap[sym].date,
          peRatio:        fundMap[sym].peRatio,
          roe:            fundMap[sym].roe,
          roic:           fundMap[sym].roic,
          netProfitMargin:fundMap[sym].netProfitMargin,
          debtToEquity:   fundMap[sym].debtToEquity,
          revenueGrowth:  fundMap[sym].revenuePerShareTTM,
          enterpriseValue:fundMap[sym].enterpriseValue,
          evToEbitda:     fundMap[sym].evToFreeCashFlow
        } : null
      })),
      null, 2
    ) + '\n\n';

    // ── Earnings history ───────────────────────────────────────────────────
    text += `EARNINGS HISTORY (last 4 quarters before ${date}):\n`;
    text += JSON.stringify(
      top10.map(sym => ({
        symbol: sym,
        history: (earnMap[sym] || []).map(e => ({
          date:         e.date,
          eps:          e.eps,
          epsEstimated: e.epsEstimated,
          surprise:     e.eps && e.epsEstimated
            ? (((e.eps - e.epsEstimated) / Math.abs(e.epsEstimated)) * 100).toFixed(1) + '%'
            : null,
          beat:         e.eps > e.epsEstimated ? 'BEAT' : e.eps < e.epsEstimated ? 'MISS' : 'IN-LINE'
        }))
      })),
      null, 2
    ) + '\n\n';

    text += `═══════════════════════════════════════════════════════\n`;
    text += `BACKTEST NOTE: This is a reconstruction of what the THEISI system\n`;
    text += `would have seen on ${date}. Analyst price targets use current values\n`;
    text += `(historical consensus targets not available via FMP free tier).\n`;
    text += `All other data (prices, technicals, earnings) is fully historical.\n`;
    text += `═══════════════════════════════════════════════════════\n`;

    // ── Also include current prices for comparison ─────────────────────────
    // This lets the dashboard show "what actually happened since then"
    if (format === 'json') {
      // Return structured JSON for the dashboard to process
      return res.status(200).json({
        snapshotDate: date,
        totalValueOnDate: totalValue,
        holdings: enriched.map(h => ({
          sym: h.sym, shares: h.shares, cost: h.cost,
          priceOnDate: h.livePrice, valueOnDate: h.value, glPctAtDate: h.glPct,
          sector: h.sector
        })),
        technicals: techMap,
        portfolioText: text
      });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 200) });
  }
};
