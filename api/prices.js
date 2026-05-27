// api/prices.js — Yahoo Finance v8/chart, individual requests in parallel
// v8/chart works without authentication, confirmed working 2025/2026

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const symbols = [
    'NVDA','AMZN','MU','OKTA','MSFT','CRM','PANW','CRWD','AAPL','GOOGL',
    'FTNT','QQQ','VOO','SPY','IVV','SMH','VGT','SPUS','XLP','QQQM',
    'IBIT','DUOL','BTBT','ATYR','MVST','MSTR','PONY','WOLF','NTLA','ONTO',
    'NOW','SIMO','SEZL','APH','IOT','IONQ','SERV','SMMT','PATH','ZETA',
    'CRDO','NEM','B','CLS','PLTR'
  ];

  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

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
        price: meta.regularMarketPrice,
        change: meta.regularMarketPrice - meta.chartPreviousClose,
        changePct: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
        name: symbol
      };
    } catch (e) {
      return null;
    }
  }

  try {
    // Fetch all 44 stocks in parallel
    const results = await Promise.all(symbols.map(fetchOne));

    const prices = {};
    results.forEach(q => {
      if (q) prices[q.symbol] = {
        price: q.price,
        change: q.change,
        changePct: q.changePct,
        name: q.name
      };
    });

    res.json({
      prices,
      count: Object.keys(prices).length,
      updated: new Date().toISOString(),
      source: 'Yahoo Finance'
    });

  } catch (e) {
    res.status(500).json({ error: e.message, prices: {} });
  }
};
