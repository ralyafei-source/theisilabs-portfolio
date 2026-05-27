// api/prices.js — Yahoo Finance with cookie+crumb authentication
// This bypasses Yahoo Finance's datacenter IP blocking

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

  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    // Step 1 — Get session cookie from Yahoo Finance
    const cookieRes = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA },
      redirect: 'follow'
    });
    const rawCookie = cookieRes.headers.get('set-cookie') || '';
    // Extract the A3 cookie which is the important one
    const cookie = rawCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');

    // Step 2 — Get crumb token (required for API calls)
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': UA,
        'Cookie': cookie,
        'Accept': 'text/plain'
      }
    });
    const crumb = await crumbRes.text();

    if (!crumb || crumb.includes('Unauthorized') || crumb.length > 20) {
      throw new Error('Could not get Yahoo Finance crumb');
    }

    // Step 3 — Fetch all 44 stock quotes
    const quotesUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}&crumb=${encodeURIComponent(crumb)}&lang=en&region=US`;
    const quotesRes = await fetch(quotesUrl, {
      headers: {
        'User-Agent': UA,
        'Cookie': cookie,
        'Accept': 'application/json'
      }
    });

    if (!quotesRes.ok) throw new Error(`Yahoo quotes error: ${quotesRes.status}`);

    const data = await quotesRes.json();
    const quotes = data.quoteResponse?.result || [];

    if (quotes.length === 0) throw new Error('No quotes returned');

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

    res.json({
      prices,
      count: Object.keys(prices).length,
      updated: new Date().toISOString(),
      source: 'Yahoo Finance'
    });

  } catch (e) {
    // Fallback to FMP if Yahoo fails
    try {
      const FMP_KEY = 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
      const fmpUrl = `https://financialmodelingprep.com/api/v3/quote/${symbols.join(',')}?apikey=${FMP_KEY}`;
      const fmpRes = await fetch(fmpUrl);
      const fmpData = await fmpRes.json();

      const prices = {};
      if (Array.isArray(fmpData)) {
        fmpData.forEach(q => {
          if (q.price) {
            prices[q.symbol] = {
              price: q.price,
              change: q.change || 0,
              changePct: q.changesPercentage || 0,
              name: q.name || q.symbol
            };
          }
        });
      }

      res.json({
        prices,
        count: Object.keys(prices).length,
        updated: new Date().toISOString(),
        source: 'FMP (Yahoo fallback)'
      });

    } catch (e2) {
      res.status(500).json({ error: e.message, fallbackError: e2.message, prices: {} });
    }
  }
};
