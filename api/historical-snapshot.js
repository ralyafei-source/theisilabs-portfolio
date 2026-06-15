// api/historical-snapshot.js  v5
// KEY CHANGE: reads historical OHLC from data/historical-ohlc.json (pre-downloaded)
// instead of fetching Yahoo Finance live for each backtest date.
// This drops each week from ~70s to ~5s (no Yahoo calls for historical data).
// Current prices (for comparison) still fetched live via FMP+Yahoo fallback.
// Falls back to live Yahoo if local OHLC file is missing or symbol not found.

const REPO         = 'ralyafei-source/theisilabs-portfolio';
const FMP_KEY      = process.env.FMP_API_KEY;
const FMP          = 'https://financialmodelingprep.com/stable';
const UA           = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY      = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ─── Local OHLC cache (loaded once per cold start) ───────────────────────────
let _ohlcCache     = null;
let _ohlcCacheTime = 0;
const CACHE_TTL    = 3600000; // 1 hour — re-fetch if Vercel keeps instance warm

async function getLocalOHLC() {
  const now = Date.now();
  if (_ohlcCache && (now - _ohlcCacheTime) < CACHE_TTL) return _ohlcCache;
  try {
    // Read directly from GitHub raw (faster than API, no auth needed for public content)
    const url = `https://raw.githubusercontent.com/${REPO}/main/data/historical-ohlc.json?t=${now}`;
    const r   = await fetch(url, { headers: { 'User-Agent': 'theisilabs/1.0' } });
    if (!r.ok) return null;
    _ohlcCache     = await r.json();
    _ohlcCacheTime = now;
    return _ohlcCache;
  } catch { return null; }
}

// ─── Get OHLC bars for a symbol from local cache ─────────────────────────────
// Returns array of { d, o, h, l, c, v } sorted oldest first
// Filtered to only bars on or before targetDate with lookback
async function getLocalBars(sym, targetDate, lookbackDays = 300) {
  const ohlc = await getLocalOHLC();
  if (!ohlc?.data?.[sym]) return null; // null = not in local file, caller should fallback

  const cutoff  = targetDate;
  const fromStr = new Date(new Date(targetDate + 'T00:00:00Z') - lookbackDays * 86400000)
    .toISOString().slice(0, 10);

  const bars = (ohlc.data[sym] || [])
    .filter(b => b.d >= fromStr && b.d <= cutoff)
    .map(b => ({ date: b.d, close: b.c, open: b.o, high: b.h, low: b.l, volume: b.v }));

  return bars; // already sorted oldest first from downloader
}

// ─── Yahoo Finance fallback (used only if local file missing or symbol absent) ─
async function getYahooHistorical(sym, targetDate, lookbackDays = 300) {
  try {
    const toTs   = Math.floor(new Date(targetDate + 'T23:59:59Z').getTime() / 1000);
    const fromTs = toTs - lookbackDays * 86400;
    const url    = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${fromTs}&period2=${toTs}`;
    const r      = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const d      = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return [];
    const timestamps = result.timestamp || [];
    const closes     = result.indicators?.quote?.[0]?.close || [];
    const prices     = [];
    timestamps.forEach((ts, i) => {
      if (closes[i] == null) return;
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      if (date <= targetDate) prices.push({ date, close: closes[i] });
    });
    return prices.sort((a, b) => a.date > b.date ? 1 : -1);
  } catch { return []; }
}

// ─── Get bars: local first, Yahoo fallback ────────────────────────────────────
async function getBars(sym, targetDate, lookbackDays = 300) {
  const local = await getLocalBars(sym, targetDate, lookbackDays);
  if (local !== null) return local; // found in local file (even if empty for this date range)
  return getYahooHistorical(sym, targetDate, lookbackDays); // fallback
}

// ─── Technical indicator calculations ────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const ch = []; for (let i = 1; i < closes.length; i++) ch.push(closes[i] - closes[i - 1]);
  let g = 0, l = 0;
  for (let i = 0; i < period; i++) { if (ch[i] > 0) g += ch[i]; else l += Math.abs(ch[i]); }
  g /= period; l /= period;
  for (let i = period; i < ch.length; i++) {
    g = (g * (period - 1) + (ch[i] > 0 ? ch[i] : 0)) / period;
    l = (l * (period - 1) + (ch[i] < 0 ? Math.abs(ch[i]) : 0)) / period;
  }
  return l === 0 ? 100 : +(100 - 100 / (1 + g / l)).toFixed(2);
}
function calcSMA(closes, p) {
  if (closes.length < p) return null;
  return +(closes.slice(-p).reduce((a, b) => a + b, 0) / p).toFixed(2);
}
function calcEMA(closes, p) {
  if (closes.length < p) return null;
  const k = 2 / (p + 1);
  let e = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return +e.toFixed(2);
}
function calcMACD(closes, f = 12, s = 26, sp = 9) {
  if (closes.length < s + sp) return { macd: null, signal: null, histogram: null };
  const kf = 2/(f+1), ks = 2/(s+1), ksp = 2/(sp+1);
  let ef = closes.slice(0,f).reduce((a,b)=>a+b)/f;
  let es = closes.slice(0,s).reduce((a,b)=>a+b)/s;
  const ml = [];
  for (let i = s; i < closes.length; i++) {
    ef = closes[i]*kf+ef*(1-kf);
    es = closes[i]*ks+es*(1-ks);
    ml.push(ef-es);
  }
  if (ml.length < sp) return { macd: null, signal: null, histogram: null };
  let sig = ml.slice(0,sp).reduce((a,b)=>a+b)/sp;
  for (let i = sp; i < ml.length; i++) sig = ml[i]*ksp+sig*(1-ksp);
  const mv = ml[ml.length-1];
  return { macd: +mv.toFixed(4), signal: +sig.toFixed(4), histogram: +(mv-sig).toFixed(4) };
}
function buildSignals(sym, price, rsi, macd, sma50, sma200, ema20) {
  const s = [];
  if (rsi != null) {
    if (rsi > 70)      s.push(`RSI ${rsi} — OVERBOUGHT`);
    else if (rsi < 30) s.push(`RSI ${rsi} — OVERSOLD`);
    else               s.push(`RSI ${rsi} — neutral`);
  }
  if (macd?.macd != null && macd?.signal != null) {
    if (macd.macd > macd.signal && macd.histogram > 0)      s.push('MACD bullish ↑');
    else if (macd.macd < macd.signal && macd.histogram < 0) s.push('MACD bearish ↓');
    else                                                     s.push('MACD neutral');
  }
  if (sma50 != null && sma200 != null) {
    if (sma50 > sma200) s.push(`Golden Cross ✅ (SMA50 ${sma50} > SMA200 ${sma200})`);
    else                s.push(`Death Cross ⚠️ (SMA50 ${sma50} < SMA200 ${sma200})`);
  }
  if (price && ema20 != null) {
    if (price > ema20) s.push(`Above EMA20 (${ema20}) — bullish`);
    else               s.push(`Below EMA20 (${ema20}) — bearish`);
  }
  return s;
}

// ─── Current prices: FMP batch → Yahoo fallback ───────────────────────────────
async function getCurrentPrices(symbols) {
  const prices  = {};
  const missing = new Set(symbols);
  try {
    const url = `${FMP}/batch-request-end-of-day-prices?symbols=${symbols.join(',')}&apikey=${FMP_KEY}`;
    const r   = await fetch(url, { headers: { 'User-Agent': 'theisilabs/1.0' } });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data)) {
        data.forEach(q => { if (q.symbol && q.price) { prices[q.symbol] = q.price; missing.delete(q.symbol); } });
      }
    }
  } catch (e) { console.error('FMP batch error:', e); }

  if (missing.size > 0) {
    const missArr = [...missing];
    for (let i = 0; i < missArr.length; i += 8) {
      const batch = missArr.slice(i, i + 8);
      const results = await Promise.all(batch.map(async sym => {
        try {
          const r = await fetch(
            `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
            { headers: { 'User-Agent': UA } }
          );
          if (!r.ok) return { sym, price: null };
          const d = await r.json();
          return { sym, price: d?.chart?.result?.[0]?.meta?.regularMarketPrice || null };
        } catch { return { sym, price: null }; }
      }));
      results.forEach(({ sym, price }) => { if (price) prices[sym] = price; });
      if (i + 8 < missArr.length) await new Promise(r => setTimeout(r, 200));
    }
  }
  return prices;
}

// ─── Build snapshot for one date ─────────────────────────────────────────────
async function buildSnapshot(date, holdings) {
  const symbols = holdings.map(h => h.sym);

  // ── Fetch bars: local OHLC file first, Yahoo fallback ──────────────────────
  // All symbols in parallel — local reads are instant, only fallbacks hit network
  const barResults = await Promise.all(
    symbols.map(async sym => ({ sym, bars: await getBars(sym, date, 300) }))
  );
  const allBars = {};
  barResults.forEach(({ sym, bars }) => { allBars[sym] = bars || []; });

  // ── SPY for context ────────────────────────────────────────────────────────
  const spyBars = await getBars('SPY', date, 5);
  const spyEntry = [...(spyBars || [])].reverse().find(b => (b.date || b.d) <= date);

  // ── Current prices (always live — can't be pre-stored) ────────────────────
  const currentPrices = await getCurrentPrices(symbols);

  // ── Calculate technicals ──────────────────────────────────────────────────
  const priceMap = {}, techMap = {};
  symbols.forEach(sym => {
    const bars   = allBars[sym] || [];
    const entry  = [...bars].reverse().find(b => (b.date || b.d) <= date);
    const close  = entry?.close || entry?.c || null;
    priceMap[sym] = close;

    const closes = bars.map(b => b.close || b.c).filter(Boolean);
    const price  = priceMap[sym];
    const rsi    = calcRSI(closes);
    const sma50  = calcSMA(closes, 50);
    const sma200 = calcSMA(closes, 200);
    const ema20  = calcEMA(closes, 20);
    const macd   = calcMACD(closes);
    techMap[sym] = {
      rsi, sma50, sma200, ema20,
      macd: macd.macd, signal: macd.signal, histogram: macd.histogram,
      signals: buildSignals(sym, price, rsi, macd, sma50, sma200, ema20)
    };
  });

  // ── Build portfolio text ──────────────────────────────────────────────────
  let totalValue = 0;
  const enriched = holdings.map(h => {
    const price = priceMap[h.sym] || h.cost;
    const value = Math.round(h.shares * price);
    const glPct = (price - h.cost) / h.cost * 100;
    totalValue += value;
    return { ...h, livePrice: price, value, glPct };
  }).sort((a, b) => b.value - a.value);

  const sectors = {
    tech:   { label: 'TECHNOLOGY',  items: [] },
    spec:   { label: 'SPECULATIVE', items: [] },
    bio:    { label: 'BIOTECH',     items: [] },
    mining: { label: 'MINING',      items: [] },
    etf:    { label: 'ETFs',        items: [] },
    other:  { label: 'OTHER',       items: [] }
  };
  enriched.forEach(h => { (sectors[h.sector] || sectors.other).items.push(h); });

  let text = `═══════════════════════════════════════════════════════\n`;
  text += `RASHED'S PORTFOLIO — HISTORICAL SNAPSHOT: ${date}\n`;
  text += `⚠️ BACKTEST MODE — prices & technicals reconstructed from ${date}\n`;
  text += `Portfolio Value on ${date}: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
  text += `Prices found: ${Object.values(priceMap).filter(Boolean).length}/${symbols.length}\n`;
  if (spyEntry) text += `SPY on ${date}: $${(spyEntry.close || spyEntry.c || 0).toFixed(2)}\n`;
  text += `Data source: local OHLC file (2020-present)\n`;
  text += `═══════════════════════════════════════════════════════\n`;
  text += `INVESTOR RULES:\n- UAE investor — ZERO capital gains tax\n- Cannot short/options\n- Long-term growth, high risk tolerance\n`;
  text += `═══════════════════════════════════════════════════════\n\n`;

  Object.values(sectors).forEach(sec => {
    if (!sec.items.length) return;
    text += `${sec.label}:\n`;
    sec.items.forEach(h => {
      const gl = h.glPct >= 0 ? '+' : '';
      text += `${h.sym.padEnd(6)} ${String(h.shares).padEnd(8)} sh  cost $${h.cost.toFixed(2).padEnd(8)} price $${(h.livePrice||0).toFixed(2).padEnd(8)} ${gl}${h.glPct.toFixed(1)}%\n`;
    });
    text += '\n';
  });
  text += `TOTAL ON ${date}: $${totalValue.toLocaleString()}\n\n`;

  text += `═══ TECHNICAL INDICATORS — ${date} ═══\n`;
  text += `${'SYM'.padEnd(7)} ${'RSI'.padEnd(8)} ${'MACD'.padEnd(10)} ${'SMA50'.padEnd(9)} ${'SMA200'.padEnd(9)} EMA20\n`;
  text += `─────────────────────────────────────────────────────\n`;
  symbols.forEach(sym => {
    const t = techMap[sym];
    text += `${sym.padEnd(7)} ${(t.rsi!=null?String(t.rsi):'N/A').padEnd(8)} ${(t.macd!=null?String(t.macd):'N/A').padEnd(10)} ${(t.sma50!=null?String(t.sma50):'N/A').padEnd(9)} ${(t.sma200!=null?String(t.sma200):'N/A').padEnd(9)} ${t.ema20!=null?t.ema20:'N/A'}\n`;
  });
  text += '\nSIGNALS:\n';
  symbols.forEach(sym => {
    const t = techMap[sym];
    if (t.signals?.length) text += `${sym}: ${t.signals.join(' | ')}\n`;
  });
  text += `\n═══ END HISTORICAL SNAPSHOT ═══\n`;

  return {
    portfolioText:    text,
    totalValueOnDate: totalValue,
    holdings: enriched.map(h => ({
      sym:          h.sym,
      shares:       h.shares,
      cost:         h.cost,
      priceOnDate:  h.livePrice,
      currentPrice: currentPrices[h.sym] || null,
      sector:       h.sector
    }))
  };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ', '').trim();
  if (key && key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { date, format } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'date required: YYYY-MM-DD' });
  const today = new Date().toISOString().slice(0, 10);
  if (date >= today) return res.status(400).json({ error: 'date must be in the past' });
  if (date < '2018-01-01') return res.status(400).json({ error: 'date must be after 2018-01-01' });

  res.setHeader('Cache-Control', 's-maxage=7200,stale-while-revalidate=14400');

  try {
    const raw = await fetch(
      `https://raw.githubusercontent.com/${REPO}/main/data/portfolio.json?t=${Date.now()}`
    );
    if (!raw.ok) throw new Error('Cannot read portfolio.json');
    const portfolio = await raw.json();
    const holdings  = portfolio.holdings || [];
    const snap      = await buildSnapshot(date, holdings);

    if (format === 'json') {
      return res.status(200).json({
        snapshotDate:     date,
        totalValueOnDate: snap.totalValueOnDate,
        holdings:         snap.holdings,
        portfolioText:    snap.portfolioText
      });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(snap.portfolioText);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
