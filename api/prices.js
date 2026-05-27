// api/prices.js — FMP with batching + debug info
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
    // Split into batches of 10 to avoid FMP limits
    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const url = `https://financialmodelingprep.com/api/v3/quote/${batch.join(',')}?apikey=${FMP_KEY}`;

      const r = await fetch(url);
      const text = await r.text();

      let data;
      try { data = JSON.parse(text); } catch(e) {
        debug.push(`Batch ${i}: parse error — ${text.slice(0,100)}`);
        continue;
      }

      if (!Array.isArray(data)) {
        debug.push(`Batch ${i}: not array — ${JSON.stringify(data).slice(0,150)}`);
        continue;
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

      debug.push(`Batch ${i}: got ${data.length} quotes, ${data.filter(q=>q.price).length} with prices`);
    }

    res.json({
      prices,
      count: Object.keys(prices).length,
      updated: new Date().toISOString(),
      source: 'FMP',
      debug
    });

  } catch (e) {
    res.status(500).json({ error: e.message, debug, prices: {} });
  }
};
