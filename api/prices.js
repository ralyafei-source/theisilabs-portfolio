// api/prices.js — FMP primary + Yahoo fallback, chunked for reliability

const REPO        = 'ralyafei-source/theisilabs-portfolio';
const UA          = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FMP_API_KEY = process.env.FMP_API_KEY;

// Fetch with timeout helper
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  // Fallback symbol list — used if portfolio.json read fails
  const fallbackSymbols = [
    'NVDA','AMZN','MU','OKTA','MSFT','CRM','PANW','CRWD','AAPL','GOOGL',
    'FTNT','ADBE','ONTO','NOW','SIMO','APH','IOT','IONQ','PATH','ZETA',
    'CRDO','VISN','TIGO','DY','CLS','PLTR','DUOL','BTBT','MVST','MSTR',
    'PONY','WOLF','SERV','SOFI','SEZL','ATYR','NTLA','SMMT','COR','NVO',
    'NEM','B','QQQ','VOO','SPY','IVV','SMH','VGT','SPUS','XLP','QQQM','IBIT'
  ];

  let symbols = fallbackSymbols;

  // ?list=symbols — return the UNION of ALL users' holdings (no prices).
  if (req.query.list === 'symbols') {
    const set = new Set();
    try {
      const uRes = await fetchWithTimeout(
        `https://raw.githubusercontent.com/${REPO}/main/data/users.json?t=${Date.now()}`, {}, 3000
      );
      const users = uRes.ok ? await uRes.json() : [];
      const userList = Array.isArray(users) ? users : (users.users || []);
      const files = ['data/portfolio.json'];
      userList.forEach(u => { if (u.portfolioFile) files.push(u.portfolioFile); });
      await Promise.all([...new Set(files)].map(async f => {
        try {
          const r = await fetchWithTimeout(
            `https://raw.githubusercontent.com/${REPO}/main/${f}?t=${Date.now()}`, {}, 3000
          );
          if (!r.ok) return;
          const d = await r.json();
          (d.holdings || d.stocks || d.portfolio?.stocks || []).forEach(h => {
            if (h && h.sym) set.add(String(h.sym).toUpperCase());
          });
        } catch (e) {}
      }));
    } catch (e) {}
    if (set.size === 0) fallbackSymbols.forEach(s => set.add(s));
    return res.json({ symbols: [...set].sort(), count: set.size, updated: new Date().toISOString() });
  }

  // If symbols passed as query param, use those directly
  if (req.query.symbols) {
    const requested = req.query.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (requested.length > 0) symbols = requested;
  } else {
    // Try to read symbols from portfolio.json (3 second timeout)
    try {
      const pfRes = await fetchWithTimeout(
        `https://raw.githubusercontent.com/${REPO}/main/data/portfolio.json?t=${Date.now()}`,
        {}, 3000
      );
      if (pfRes.ok) {
        const portfolio = await pfRes.json();
        const dynamic = (portfolio.holdings || []).map(h => h.sym).filter(Boolean);
        if (dynamic.length > 0) symbols = dynamic;
      }
    } catch (e) {
      // portfolio.json read failed — use fallback list
    }
  }

  // ── STEP 1: FMP batch call — one request for all symbols ─────────────────
  let results = [];
  const fmpFailed = new Set(symbols); // tracks which symbols still need prices

  try {
    const fmpUrl = `https://financialmodelingprep.com/stable/batch-request-end-of-day-prices?symbols=${symbols.join(',')}&apikey=${FMP_API_KEY}`;
    const fmpRes = await fetchWithTimeout(fmpUrl, { headers: { 'User-Agent': 'theisilabs/1.0' } }, 8000);
    if (fmpRes.ok) {
      const fmpData = await fmpRes.json();
      if (Array.isArray(fmpData)) {
        fmpData.forEach(q => {
          if (q.symbol && q.price) {
            results.push({
              symbol:    q.symbol,
              price:     q.price,
              change:    q.change || 0,
              changePct: q.changesPercentage || 0,
              name:      q.name || q.symbol
            });
            fmpFailed.delete(q.symbol); // FMP got this one — remove from fallback list
          }
        });
      }
    }
  } catch (e) {
    console.error('FMP batch error:', e);
    // fmpFailed stays as full set — Yahoo will handle everything
  }

  // ── STEP 2: Yahoo fallback — only for symbols FMP missed ─────────────────
  if (fmpFailed.size > 0) {
    console.log(`FMP missed ${fmpFailed.size} symbols, falling back to Yahoo:`, [...fmpFailed]);

    async function fetchOneYahoo(symbol) {
      try {
        const r = await fetchWithTimeout(
          `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
          { headers: { 'User-Agent': UA } },
          4000
        );
        if (!r.ok) return null;
        const d = await r.json();
        const meta = d?.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) return null;
        return {
          symbol,
          price:     meta.regularMarketPrice,
          change:    meta.regularMarketPrice - (meta.chartPreviousClose || meta.regularMarketPrice),
          changePct: meta.chartPreviousClose
            ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100
            : 0,
          name: symbol
        };
      } catch {
        return null;
      }
    }

    // Missing symbols are few — safe to run in parallel without chunking
    const yahooResults = await Promise.all([...fmpFailed].map(fetchOneYahoo));
    yahooResults.forEach(q => { if (q) results.push(q); });
  }

  // ── STEP 3: Build response ────────────────────────────────────────────────
  const prices = {};
  results.forEach(q => {
    if (q) prices[q.symbol] = {
      price:     q.price,
      change:    q.change,
      changePct: q.changePct,
      name:      q.name
    };
  });

  const fmpCount   = symbols.length - fmpFailed.size;
  const yahooCount = results.length - fmpCount;

  res.json({
    prices,
    count:   Object.keys(prices).length,
    total:   symbols.length,
    updated: new Date().toISOString(),
    source:  `FMP(${fmpCount}) + Yahoo(${yahooCount})`
  });
};
