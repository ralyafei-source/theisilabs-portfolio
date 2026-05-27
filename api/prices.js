// api/prices.js — uses FMP (already working API key)
const API_KEY = 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';

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
    const url = `https://financialmodelingprep.com/api/v3/quote/${symbols.join(',')}?apikey=${API_KEY}`;
    const response = await fetch(url);

    if (!response.ok) throw new Error(`FMP error: ${response.status}`);

    const quotes = await response.json();

    if (!Array.isArray(quotes)) throw new Error('Invalid FMP response');

    const prices = {};
    quotes.forEach(q => {
      if (q.price) {
        prices[q.symbol] = {
          price: q.price,
          change: q.change || 0,
          changePct: q.changesPercentage || 0,
          name: q.name || q.symbol
        };
      }
    });

    res.json({
      prices,
      count: Object.keys(prices).length,
      updated: new Date().toISOString(),
      source: 'FMP'
    });

  } catch (e) {
    res.status(500).json({ error: e.message, prices: {}, updated: new Date().toISOString() });
  }
};
