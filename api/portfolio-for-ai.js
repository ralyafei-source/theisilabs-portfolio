// api/portfolio-for-ai.js
// Returns Rashed's complete portfolio as formatted plain text for Claude
// Reads portfolio.json (shares + cost) → fetches live prices → formats for AI

const REPO = 'ralyafei-source/theisilabs-portfolio';
const FILE = 'data/portfolio.json';
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    // 1. Read portfolio.json from GitHub
    const raw = await fetch(
      `https://raw.githubusercontent.com/${REPO}/main/${FILE}?t=${Date.now()}`
    );
    if (!raw.ok) throw new Error('Cannot read portfolio.json');
    const portfolio = await raw.json();
    const holdings  = portfolio.holdings || [];
    const cash      = portfolio.cash_summary || {};

    // 2. Fetch live prices for all symbols in parallel (Yahoo Finance v8/chart)
    const symbols = holdings.map(h => h.sym);
    const priceMap = {};

    const priceResults = await Promise.all(
      symbols.map(async sym => {
        try {
          const r = await fetch(
            `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
            { headers: { 'User-Agent': UA } }
          );
          if (!r.ok) return { sym, price: null };
          const d = await r.json();
          const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
          return { sym, price };
        } catch {
          return { sym, price: null };
        }
      })
    );

    priceResults.forEach(({ sym, price }) => {
      priceMap[sym] = price;
    });

    // 3. Calculate totals
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price   = priceMap[h.sym] || h.cost; // fallback to cost if no price
      const value   = Math.round(h.shares * price);
      const glPct   = ((price - h.cost) / h.cost * 100);
      totalValue   += value;
      return { ...h, livePrice: price, value, glPct };
    });

    // 4. Sort by value descending
    enriched.sort((a, b) => b.value - a.value);

    // 5. Group by sector
    const sectors = {
      tech:   { label: 'TECHNOLOGY',   items: [] },
      spec:   { label: 'SPECULATIVE',  items: [] },
      bio:    { label: 'BIOTECH',      items: [] },
      mining: { label: 'MINING',       items: [] },
      etf:    { label: 'ETFs',         items: [] },
    };

    enriched.forEach(h => {
      const sec = sectors[h.sector] || sectors.tech;
      sec.items.push(h);
    });

    // 6. Format as plain text for Claude
    const pricesAvailable = Object.values(priceMap).filter(Boolean).length;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    let text = '';
    text += `═══════════════════════════════════════════════════════\n`;
    text += `RASHED'S PORTFOLIO — Live as of ${timestamp}\n`;
    text += `Broker: Wio Invest, Abu Dhabi UAE\n`;
    text += `Total Value: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
    text += `Live prices: ${pricesAvailable}/${symbols.length} stocks updated\n`;
    text += `═══════════════════════════════════════════════════════\n`;
    text += `INVESTOR RULES (apply to all recommendations):\n`;
    text += `- UAE investor — ZERO capital gains tax on profits\n`;
    text += `- Cannot short sell or trade options (Wio Invest)\n`;
    text += `- SPUS = Sharia-compliant ETF — never recommend selling\n`;
    text += `- US market opens 5:30pm UAE time\n`;
    text += `- Long-term growth investor, high risk tolerance\n`;
    text += `═══════════════════════════════════════════════════════\n\n`;

    Object.values(sectors).forEach(sec => {
      if (sec.items.length === 0) return;
      text += `${sec.label}:\n`;
      sec.items.forEach(h => {
        const glSign  = h.glPct >= 0 ? '+' : '';
        const priceNote = priceMap[h.sym] ? '' : ' (price unavailable)';
        text += `${h.sym.padEnd(6)} ${String(h.shares).padEnd(10)} sh  `;
        text += `cost $${String(h.cost.toFixed(2)).padEnd(8)}  `;
        text += `now $${String(h.livePrice.toFixed(2)).padEnd(8)}  `;
        text += `value $${h.value.toLocaleString().padEnd(8)}  `;
        text += `${glSign}${h.glPct.toFixed(1)}%${priceNote}\n`;
      });
      text += '\n';
    });

    text += `═══════════════════════════════════════════════════════\n`;
    text += `CASH SUMMARY:\n`;
    text += `Fresh cash deposited:    $${(cash.fresh_cash_deposited||0).toLocaleString()}\n`;
    text += `Current portfolio value: $${totalValue.toLocaleString()}\n`;
    const roi = cash.fresh_cash_deposited
      ? (((totalValue - cash.fresh_cash_deposited) / cash.fresh_cash_deposited) * 100).toFixed(1)
      : 'N/A';
    text += `Return on cash invested: +${roi}%\n`;
    text += `Last updated:            ${portfolio.meta?.last_updated || 'N/A'}\n`;
    text += `═══════════════════════════════════════════════════════\n`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch (e) {
    // Fallback — return minimal portfolio if anything fails
    res.status(500).send(`Portfolio data unavailable: ${e.message}\nPlease use cached portfolio data.`);
  }
};
