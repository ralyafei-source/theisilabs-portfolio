// api/portfolio-for-ai.js
// Returns portfolio as formatted plain text for Claude
// Supports ?nickname=ahmed for per-user portfolios
// Supports ?include=intelligence for smart FMP data (earnings, targets, grades, metrics, technicals)

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

function todayUAE() {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysAheadUAE(n) {
  return new Date(Date.now() + 4 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);
}

// Returns date N days AGO in UAE timezone
function daysAgoUAE(n) {
  return new Date(Date.now() + 4 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
}

function latest(arr, field) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[0]?.[field] ?? null;
}

// ─── Fetch latest available market data file (today or most recent past day) ─
async function fetchLatestMarketData() {
  // Try today first, then walk back up to 7 days
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

// ─── Fetch technicals for one symbol — all 5 indicators in parallel ──────────
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

    if (!isGenericUser) {
      text += `INVESTOR RULES:\n`;
      text += `- UAE investor — ZERO capital gains tax\n`;
      text += `- Cannot short sell or trade options (Wio Invest)\n`;
      text += `- SPUS = Sharia ETF — never recommend selling\n`;
      text += `- US market opens 5:30pm UAE time\n`;
      text += `- Long-term growth investor, high risk tolerance\n`;
    } else {
      text += `INVESTOR: ${investorName}, UAE — long-term growth focus\n`;
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

      // ── Fetch latest available market data (today or most recent past day) ─
      const { date: marketDataDate, syms: moverSyms } = await fetchLatestMarketData();

      // Top 10 non-ETF for analyst calls
      const top10 = enriched.filter(h => h.sector !== 'etf').slice(0, 10).map(h => h.sym);

      // Top 20 non-ETF for technicals
      const top20tech = enriched.filter(h => h.sector !== 'etf').slice(0, 20).map(h => h.sym);

      const allSyms = [...new Set([...symbols, ...moverSyms])];

      // Grades: last 60 days only to avoid returning years of history
      const gradesFrom = daysAgoUAE(60);

      // ── All FMP calls in parallel ─────────────────────────────────────────
      const [
        earningsRaw,
        targetResults,
        gradeResults,
        metricResults,
        techResults
      ] = await Promise.all([
        fmpGet(`/earnings-calendar?from=${todayUAE()}&to=${daysAheadUAE(60)}&symbol=${allSyms.join(',')}`),
        Promise.all(top10.map(sym => fmpGet(`/price-target-consensus?symbol=${sym}`))),
        // Grades: limit to last 60 days + max 5 per stock to prevent token bloat
        Promise.all(top10.map(sym => fmpGet(`/grades?symbol=${sym}&limit=50`))),
        Promise.all(top10.map(sym => fmpGet(`/key-metrics-ttm?symbol=${sym}`))),
        Promise.allSettled(top20tech.map(sym => fetchTechnicals(sym)))
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

      // ── Flatten analyst data ──────────────────────────────────────────────
      const earnings = earningsRaw || [];
      const targets  = targetResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));
      const grades   = gradeResults.flat().filter(Boolean)
  .filter(i => i.date >= gradesFrom)
  .map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));

      // Key metrics: strip out null/zero fields to reduce token size
      const metrics = metricResults.flat().filter(Boolean).map(i => {
        const clean = { symbol: i.symbol, inPortfolio: ownedSet.has(i.symbol) };
        const keepFields = [
  'evToEBITDATTM','evToSalesTTM','returnOnEquityTTM',
  'returnOnInvestedCapitalTTM','returnOnAssetsTTM',
  'currentRatioTTM','earningsYieldTTM','freeCashFlowYieldTTM',
  'netDebtToEBITDATTM','stockBasedCompensationToRevenueTTM'
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

      // ── Append to text ────────────────────────────────────────────────────
      text += `\n═══════════════════════════════════════════════════════\n`;
      text += `MARKET INTELLIGENCE — ${todayUAE()}\n`;
      text += `Portfolio: ${symbols.join(', ')}\n`;
      text += `Movers data: ${marketDataDate ? `from ${marketDataDate}` : 'unavailable'} — ${moverSyms.join(', ') || 'none'}\n`;
      text += `═══════════════════════════════════════════════════════\n\n`;

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

      text += `EARNINGS CALENDAR (next 60 days):\n`;
      text += JSON.stringify({
        portfolio: earningsSorted.filter(e => e.inPortfolio),
        movers:    earningsSorted.filter(e => !e.inPortfolio).slice(0, 5)
      }, null, 2) + '\n\n';

      text += `ANALYST PRICE TARGETS:\n`;
      text += JSON.stringify(targets, null, 2) + '\n\n';

      text += `ANALYST GRADES (last 60 days):\n`;
      text += JSON.stringify(grades, null, 2) + '\n\n';

      text += `KEY METRICS TTM:\n`;
      text += JSON.stringify(metrics, null, 2) + '\n';

      text += `\n═══════════════════════════════════════════════════════\n`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch (e) {
    res.status(500).send(`Portfolio data unavailable: ${e.message}`);
  }
};
