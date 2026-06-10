// api/portfolio-for-ai.js
// Returns portfolio as formatted plain text for Claude
// Supports ?nickname=ahmed for per-user portfolios
// Supports ?include=intelligence for smart FMP data (earnings, targets, grades, metrics, technicals)
// Supports ?mode=build-universe (POST) — universe dedup/filter for scenario 922
// Default (no nickname): reads Rashed's portfolio.json

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const FMP_KEY = 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
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

  // ── MODE: build-universe ──────────────────────────────────────────────────
  // Called by Make.com scenario 922 (POST ?mode=build-universe)
  // Vercel fetches the 3 FMP screeners directly — no data transfer from Make.com
  // Build Spec v1.1 §2.1-2.3 · Session 28 · 2026-06-10
  if (req.method === 'POST' && req.query.mode === 'build-universe') {
    try {
      const { date } = req.body || {};
      const today = date || todayUAE();

      const MIN_DOLLAR_VOLUME = 5_000_000;
      const MAX_UNIVERSE      = 800;
      const BASE = `&exchange=NASDAQ,NYSE&country=US&priceMoreThan=5&betaLowerThan=5&isEtf=false&isFund=false&isActivelyTrading=true`;

      // Fetch 3 screeners in parallel directly from FMP
      const [large, mid, momentum] = await Promise.all([
        fmpGet(`/company-screener?marketCapMoreThan=10000000000&volumeMoreThan=500000&limit=1000${BASE}`),
        fmpGet(`/company-screener?marketCapMoreThan=2000000000&marketCapLowerThan=10000000000&volumeMoreThan=500000&limit=1000${BASE}`),
        fmpGet(`/company-screener?marketCapMoreThan=2000000000&isAboveSma50=true&isAboveSma200=true&rsiMoreThan=50&rsiLessThan=70&volumeMoreThan=1000000&limit=1000${BASE}`)
      ]);

      const safeArr = v => Array.isArray(v) ? v : [];
      const L = safeArr(large);
      const M = safeArr(mid);
      const Mo = safeArr(momentum);

      console.log(`build-universe: fetched large=${L.length} mid=${M.length} momentum=${Mo.length}`);

      // Step 1: Union
      const all = [...L, ...M, ...Mo];

      // Step 2: Dedupe by symbol — drop foreign listings, keep higher-volume
      const bySymbol = {};
      for (const stock of all) {
        const sym = stock.symbol;
        if (!sym || sym.includes('.')) continue;
        const existing = bySymbol[sym];
        if (!existing || (stock.volume || 0) > (existing.volume || 0)) {
          bySymbol[sym] = stock;
        }
      }
      const afterDedup = Object.values(bySymbol);
      console.log(`build-universe: after dedupe=${afterDedup.length}`);

      // Step 3: Dollar-volume floor ($5M/day)
      const filtered = afterDedup.filter(s =>
        (s.price || 0) * (s.volume || 0) >= MIN_DOLLAR_VOLUME
      );
      console.log(`build-universe: after dollar-vol=${filtered.length}`);

      // Step 4: Fail loud if oversized
      if (filtered.length > MAX_UNIVERSE) {
        console.error(`build-universe OVERSIZED: ${filtered.length} — gate too loose?`);
      }

      // Step 5: Sort stable — marketCap desc, ties A→Z
      filtered.sort((a, b) => {
        const d = (b.marketCap || 0) - (a.marketCap || 0);
        return d !== 0 ? d : (a.symbol || '').localeCompare(b.symbol || '');
      });

      // Step 6: Clean output
      const universe = filtered.slice(0, MAX_UNIVERSE).map(s => ({
        symbol:      s.symbol,
        companyName: s.companyName || '',
        marketCap:   s.marketCap   || 0,
        price:       s.price       || 0,
        volume:      s.volume      || 0,
        sector:      s.sector      || '',
        industry:    s.industry    || '',
        beta:        s.beta        || 0,
        exchange:    s.exchange    || ''
      }));

      return res.status(200).json({
        date:  today,
        count: universe.length,
        source_counts: {
          large: L.length, mid: M.length, momentum: Mo.length,
          raw_union: all.length, after_dedup: afterDedup.length,
          after_dollar_vol: filtered.length
        },
        universe
      });

    } catch (err) {
      console.error('build-universe FATAL:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────



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
      text += `Fresh cash available: $${cash.fresh_cash_deposited?.toLocaleString() || 0}\n`;
      text += `Investable cash: $${cash.investable_cash?.toLocaleString() || 0}\n`;
    }
    text += `═══════════════════════════════════════════════════════\n`;

    // ── Intelligence block ───────────────────────────────────────────────────
    if (wantIntelligence) {
      const allSyms  = symbols;
      const moverSyms = [];
      const top10    = symbols.slice(0, 10);

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
