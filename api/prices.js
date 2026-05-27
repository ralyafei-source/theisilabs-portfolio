// api/prices.js — uses yahoo-finance2 npm package (handles auth automatically)
const yahooFinance = require('yahoo-finance2').default;

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

  try {
    const quotes = await yahooFinance.quote(symbols);
    const list = Array.isArray(quotes) ? quotes : [quotes];

    const prices = {};
    list.forEach(q => {
      if (q && q.symbol && q.regularMarketPrice) {
        prices[q.symbol] = {
          price: q.regularMarketPrice,
          change: q.regularMarketChange || 0,
          changePct: q.regularMarketChangePercent || 0,
          name: q.shortName || q.symbol
        };
      }
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
