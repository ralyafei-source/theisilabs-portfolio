// api/portfolio-for-ai.js
// Returns portfolio as formatted plain text for Claude
// Supports ?nickname=ahmed for per-user portfolios
// Supports ?include=intelligence for smart FMP data (earnings, targets, grades, metrics, technicals)
// Supports ?symbols=AVGO,META,LLY for opportunity deep fetch (Stage B2)
// Default (no nickname, no symbols): reads Rashed's portfolio.json

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const FMP_KEY = process.env.FMP_API_KEY || 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
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

// ─── Fetch full FMP intelligence for a list of symbols ───────────────────────
// Used by both portfolio mode and ?symbols= mode
async function fetchIntelligence(symbols) {
  const ETF_LIST = new Set(['QQQ','SPY','VGT','SPUS','VOO','XLP','IVV','SMH','IBIT','QQQM']);
  const nonEtfs  = symbols.filter(s => !ETF_LIST.has(s));
  const top10    = nonEtfs.slice(0, 10);

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
    fmpGet(`/earnings-calendar?from=${todayUAE()}&to=${daysAheadUAE(60)}&symbol=${symbols.join(',')}`),
    Promise.all(top10.map(sym => fmpGet(`/price-target-consensus?symbol=${sym}`))),
    Promise.all(top10.map(sym => fmpGet(`/grades?symbol=${sym}&limit=3`))),
    Promise.all(top10.map(sym => fmpGet(`/key-metrics-ttm?symbol=${sym}`))),
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

  // Build techMap
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
    if (techMap[sym] && stddev !== null) {
      techMap[sym].bb_stddev = +stddev.toFixed(4);
    }
  });

  const targets = targetResults.flat().filter(Boolean);
  const grades  = gradeResults.flat().filter(Boolean);
  const metrics = metricResults.flat().filter(Boolean);
  const earnings = (earningsRaw || []).map(e => ({
    ...e,
    inPortfolio: symbols.includes(e.symbol)
  })).sort((a, b) => {
    if (a.inPortfolio && !b.inPortfolio) return -1;
    if (!a.inPortfolio && b.inPortfolio) return 1;
    return new Date(a.date) - new Date(b.date);
  });

  return { techMap, targets, grades, metrics, earnings };
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

  const { nickname, include, symbols: symbolsParam } = req.query;
  const wantIntelligence = include === 'intelligence';

  // ── NEW: ?symbols= mode — deep fetch for opportunity stocks ─────────────────
  if (symbolsParam) {
    const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length === 0) {
      return res.status(400).json({ error: 'No symbols provided' });
    }
    if (symbols.length > 150) {
      return res.status(400).json({ error: 'Maximum 150 symbols per request' });
    }

    try {
      // Fetch Yahoo prices for all symbols
      const priceMap = {};
      const priceResults = await Promise.all(
        symbols.map(async sym => {
          try {
            const r = await fetch(
              `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`,
              { headers: { 'User-Agent': UA } }
            );
            if (!r.ok) return { sym, price: null, change5d: null };
            const d = await r.json();
            const result = d?.chart?.result?.[0];
            const price  = result?.meta?.regularMarketPrice || null;
            // 5-day change
            const closes = result?.indicators?.quote?.[0]?.close || [];
            const validCloses = closes.filter(Boolean);
            const change5d = validCloses.length >= 2
              ? +((validCloses[validCloses.length - 1] - validCloses[0]) / validCloses[0] * 100).toFixed(2)
              : null;
            return { sym, price, change5d };
          } catch { return { sym, price: null, change5d: null }; }
        })
      );
      priceResults.forEach(({ sym, price, change5d }) => {
        priceMap[sym] = { price, change5d };
      });

      // Fetch FMP intelligence for all symbols
      const { techMap, targets, grades, metrics, earnings } = await fetchIntelligence(symbols);

      // Build structured JSON output keyed by symbol
      const result = {};
      symbols.forEach(sym => {
        const t = techMap[sym] || {};
        const p = priceMap[sym] || {};
        const m = metrics.find(x => x.symbol === sym) || {};
        const tgt = targets.find(x => x.symbol === sym) || {};
        const gr = grades.filter(x => x.symbol === sym);
        const earn = earnings.filter(e => e.symbol === sym);

        result[sym] = {
          symbol: sym,
          price: p.price || null,
          change5d: p.change5d || null,
          // Technical
          rsi:       t.rsi    || null,
          macd:      t.macd   || null,
          macd_signal: t.signal || null,
          macd_histogram: t.histogram || null,
          sma50:     t.sma50  || null,
          sma200:    t.sma200 || null,
          ema20:     t.ema20  || null,
          bb_stddev: t.bb_stddev || null,
          // Derived signals
          above_sma50:  t.sma50  && p.price ? p.price > t.sma50  : null,
          above_sma200: t.sma200 && p.price ? p.price > t.sma200 : null,
          golden_cross: t.sma50 && t.sma200 ? t.sma50 > t.sma200 : null,
          macd_bullish: t.macd && t.signal ? t.macd > t.signal : null,
          // Fundamentals
          pe_ratio:        m.peRatio           || null,
          forward_pe:      m.forwardPE          || null,
          peg:             m.pegRatio           || null,
          roe:             m.roe                || null,
          roic:            m.roic               || null,
          fcf_yield:       m.freeCashFlowYield  || null,
          ev_ebitda:       m.evToEbitda         || null,
          net_margin:      m.netProfitMargin    || null,
          gross_margin:    m.grossProfitMargin  || null,
          debt_to_equity:  m.debtToEquity       || null,
          revenue_growth:  m.revenueGrowth      || null,
          // Analyst
          analyst_target:  tgt.targetConsensus  || null,
          analyst_high:    tgt.targetHigh       || null,
          analyst_low:     tgt.targetLow        || null,
          analyst_consensus: tgt.targetConsensus || null,
          recent_grades:   gr.slice(0, 3),
          // Earnings
          upcoming_earnings: earn.slice(0, 2),
          // Sharia indicators (from fundamentals)
          debt_to_equity_ratio: m.debtToEquity || null,
          interest_coverage:    m.interestCoverage || null,
        };
      });

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).json({
        mode: 'symbols',
        date: todayUAE(),
        symbols_requested: symbols.length,
        symbols_with_data: Object.values(result).filter(s => s.price !== null).length,
        data: result
      });

    } catch (e) {
      return res.status(500).json({ error: `Symbols fetch failed: ${e.message}` });
    }
  }

  // ── Original portfolio mode ──────────────────────────────────────────────
  try {
    let holdings = [];
    let cash = {};
    let investorName = 'Rashed';
    let isGenericUser = false;

    if (nickname && nickname !== 'rashed') {
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

    // Live prices (Yahoo Finance)
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

    // Calculate totals
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price = priceMap[h.sym] || h.cost;
      const value = Math.round(h.shares * price);
      const glPct = ((price - h.cost) / h.cost * 100);
      totalValue += value;
      return { ...h, livePrice: price, value, glPct };
    });
    enriched.sort((a, b) => b.value - a.value);

    // Group by sector
    const sectors = {
      tech:   { label: 'TECHNOLOGY',  items: [] },
      spec:   { label: 'SPECULATIVE', items: [] },
      bio:    { label: 'BIOTECH',     items: [] },
      mining: { label: 'MINING',      items: [] },
      etf:    { label: 'ETFs',        items: [] },
      other:  { label: 'OTHER',       items: [] },
    };
    enriched.forEach(h => { (sectors[h.sector] || sectors.other).items.push(h); });

    // Format portfolio text
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

    // Intelligence block
    if (wantIntelligence) {
      let moverSyms = [];
      try {
        const mdr = await fetch(
          `https://raw.githubusercontent.com/${REPO}/main/data/market-data-${todayUAE()}.json?t=${Date.now()}`
        );
        if (mdr.ok) {
          const md  = await mdr.json();
          const str = typeof md === 'string' ? md : JSON.stringify(md);
          const matches = str.match(/"ticker"\s*:\s*"([A-Z]{1,6})"/g) || [];
          moverSyms = [...new Set(
            matches.map(m => m.match(/"([A-Z]{1,6})"/)?.[1]).filter(Boolean)
          )].slice(0, 20);
        }
      } catch { /* market data not yet available — skip */ }

      const allSyms = [...new Set([...symbols, ...moverSyms])];
      const { techMap, targets, grades, metrics, earnings } = await fetchIntelligence(allSyms);

      // Add BB bands using price
      Object.entries(techMap).forEach(([sym, t]) => {
        if (t.bb_stddev !== null && priceMap[sym]) {
          t.bb_upper = +(priceMap[sym] + 2 * t.bb_stddev).toFixed(2);
          t.bb_lower = +(priceMap[sym] - 2 * t.bb_stddev).toFixed(2);
        }
      });

      // Signal interpretation
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

      text += `\n═══════════════════════════════════════════════════════\n`;
      text += `MARKET INTELLIGENCE — ${todayUAE()}\n`;
      text += `Portfolio symbols: ${symbols.join(', ')}\n`;
      text += `Market movers tracked: ${moverSyms.join(', ') || 'none yet'}\n`;
      text += `═══════════════════════════════════════════════════════\n\n`;

      text += `TECHNICAL INDICATORS (all ${symbols.length} portfolio stocks):\n`;
      text += `${'SYM'.padEnd(7)} ${'RSI'.padEnd(8)} ${'MACD'.padEnd(10)} ${'SMA50'.padEnd(9)} ${'SMA200'.padEnd(9)} ${'EMA20'.padEnd(9)} BB_UPPER / BB_LOWER\n`;
      text += `─────────────────────────────────────────────────────────────────────────────\n`;
      symbols.forEach(sym => {
        const t = techMap[sym] || {};
        text += `${sym.padEnd(7)} `;
        text += `${(t.rsi    !== null ? String(t.rsi)    : 'N/A').padEnd(8)} `;
        text += `${(t.macd   !== null ? String(t.macd)   : 'N/A').padEnd(10)} `;
        text += `${(t.sma50  !== null ? String(t.sma50)  : 'N/A').padEnd(9)} `;
        text += `${(t.sma200 !== null ? String(t.sma200) : 'N/A').padEnd(9)} `;
        text += `${(t.ema20  !== null ? String(t.ema20)  : 'N/A').padEnd(9)} `;
        text += `${t.bb_upper || 'N/A'} / ${t.bb_lower || 'N/A'}\n`;
      });
      text += `\n`;

      text += `SIGNAL INTERPRETATION:\n`;
      symbols.forEach(sym => {
        const t = techMap[sym] || {};
        if (t.signals && t.signals.length > 0) {
          text += `${sym}: ${t.signals.join(' | ')}\n`;
        }
      });
      text += `\n`;

      text += `EARNINGS CALENDAR (next 60 days — portfolio stocks first):\n`;
      text += JSON.stringify({
        portfolio: earnings.filter(e => ownedSet.has(e.symbol)),
        movers:    earnings.filter(e => !ownedSet.has(e.symbol)).slice(0, 10)
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
