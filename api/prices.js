// api/prices.js
// Reads symbols from portfolio.json dynamically — no hardcoded list
// Add/remove stocks via dashboard and this updates automatically

const REPO = 'ralyafei-source/theisilabs-portfolio';
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    // Step 1 — Read symbols from portfolio.json (always up to date)
    const pfRes = await fetch(
      `https://raw.githubusercontent.com/${REPO}/main/data/portfolio.json?t=${Date.now()}`
    );
    if (!pfRes.ok) throw new Error('Cannot read portfolio.json');
    const portfolio = await pfRes.json();
    const symbols = (portfolio.holdings || []).map(h => h.sym);

    if (symbols.length === 0) throw new Error('No holdings in portfolio.json');

    // Step 2 — Fetch live prices for all symbols in parallel
    async function fetchOne(symbol) {
      try {
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
        const r = await fetch(url, { headers: { 'User-Agent': UA } });
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

  } catch (e) {
    res.status(500).json({ error: e.message, prices: {} });
  }
};
