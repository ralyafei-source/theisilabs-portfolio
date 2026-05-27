// api/prices.js — FMP stable endpoint (same as gainers/losers)
const FMP_KEY = 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const symbols = [
    'NVDA','AMZN','MU','OKTA','MSFT','CRM','PANW','CRWD','AAPL','GOOGL',
    'FTNT','QQQ','VOO','SPY','IVV','SMH','VGT','SPUS','XLP','QQQM',
    'IBIT','DUOL','BTBT','ATYR','MVST','MSTR','PONY','WOLF','NTLA','ONTO',
    'NOW','SIMO','SEZL','APH','IOT','IONQ','SERV','SMMT','PATH','ZETA',
    'CRDO','NEM','B','CLS','PLTR'
  ];

  const debug = [];
  const prices = {};

  try {
    // FMP stable endpoint — same one used for gainers/losers in Make.com
    // Supports comma-separated symbols
    const url = `https://financialmodelingprep.com/stable/quote?symbol=${symbols.join(',')}&apikey=${FMP_KEY}`;

    const r = await fetch(url);
    const text = await r.text();
    debug.push(`Status: ${r.status}`);
    debug.push(`Response preview: ${text.slice(0, 200)}`);

    let data;
    try { data = JSON.parse(text); } catch(e) {
      throw new Error(`Parse error: ${text.slice(0, 100)}`);
    }

    if (!Array.isArray(data)) {
      throw new Error(`Not array: ${JSON.stringify(data).slice(0, 150)}`);
    }

    data.forEach(q => {
      if (q.symbol && q.price) {
        prices[q.symbol] = {
          price: q.price,
          change: q.change || 0,
          changePct: q.changesPercentage || 0,
          name: q.name || q.symbol
        };
      }
    });

    debug.push(`Got ${data.length} quotes, ${Object.keys(prices).length} with prices`);

    res.json({
      prices,
      count: Object.keys(prices).length,
      updated: new Date().toISOString(),
      source: 'FMP stable',
      debug
    });

  } catch (e) {
    res.status(500).json({ error: e.message, debug, prices: {} });
  }
};
