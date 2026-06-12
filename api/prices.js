// api/prices.js — reads symbols from portfolio.json, fetches prices with timeout

const REPO = 'ralyafei-source/theisilabs-portfolio';
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

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
  // Used by 922 Data Collector so baselines cover every user's stocks (spec v1.1 Fix 2).
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

  // Fetch each price with 4 second timeout
  async function fetchOne(symbol) {
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

  // Run all fetches in parallel — return whatever completes within time
  const results = await Promise.all(symbols.map(fetchOne));

  const prices = {};
  results.forEach(q => {
    if (q) prices[q.symbol] = {
      price:     q.price,
      change:    q.change,
      changePct: q.changePct,
      name:      q.name
    };
  });

  res.json({
    prices,
    count:   Object.keys(prices).length,
    total:   symbols.length,
    updated: new Date().toISOString(),
    source:  'Yahoo Finance'
  });
};
