// api/prices.js — Save this file as: api/prices.js in your GitHub repo
// Fetches live prices for all 44 portfolio stocks from Yahoo Finance
// Free, no API key needed, runs server-side (no CORS issues)

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const symbols = [
    'NVDA','AMZN','MU','OKTA','MSFT','CRM','PANW','CRWD','AAPL','GOOGL',
    'FTNT','QQQ','VOO','SPY','IVV','SMH','VGT','SPUS','XLP','QQQM',
    'IBIT','DUOL','BTBT','ATYR','MVST','MSTR','PONY','WOLF','NTLA','ONTO',
    'NOW','SIMO','SEZL','APH','IOT','IONQ','SERV','SMMT','PATH','ZETA',
    'CRDO','NEM','B','CLS','PLTR'
  ];

  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}&lang=en&region=US&corsDomain=finance.yahoo.com`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://finance.yahoo.com',
        'Referer': 'https://finance.yahoo.com/'
      }
    });

    if (!response.ok) throw new Error(`Yahoo API error: ${response.status}`);

    const data = await response.json();
    const quotes = data.quoteResponse?.result || [];

    const prices = {};
    quotes.forEach(q => {
      if (q.regularMarketPrice) {
        prices[q.symbol] = {
          price: q.regularMarketPrice,
          change: q.regularMarketChange || 0,
          changePct: q.regularMarketChangePercent || 0,
          name: q.longName || q.shortName || q.symbol,
          marketState: q.marketState || 'REGULAR'
        };
      }
    });

    // Cache for 5 minutes
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.json({
      prices,
      count: Object.keys(prices).length,
      updated: new Date().toISOString()
    });

  } catch (e) {
    res.status(500).json({ error: e.message, prices: {}, updated: new Date().toISOString() });
  }
};
