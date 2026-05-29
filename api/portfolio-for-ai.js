// api/portfolio-for-ai.js
// Returns portfolio as formatted plain text for Claude
// Supports ?nickname=ahmed for per-user portfolios
// Default (no nickname): reads Rashed's portfolio.json

const REPO = 'ralyafei-source/theisilabs-portfolio';
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  // Auth check (optional — allows Make.com to call with API key)
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ', '').trim();
  if (key && key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { nickname } = req.query;

  try {
    let holdings = [];
    let cash = {};
    let investorName = 'Rashed';
    let isGenericUser = false;

    if (nickname && nickname !== 'rashed') {
      // ── Per-user portfolio ──
      investorName = nickname.charAt(0).toUpperCase() + nickname.slice(1);
      isGenericUser = true;
      const FILE = `data/portfolio-${nickname}.json`;
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/${FILE}?t=${Date.now()}`
      );
      if (!raw.ok) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(`Portfolio for ${investorName} is empty or not found.\nNo stocks to analyze.`);
      }
      const portfolio = await raw.json();
      const userStocks = portfolio.stocks || [];

      if (userStocks.length === 0) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(`Portfolio for ${investorName} is empty.\nNo stocks to analyze.`);
      }

      // Convert user stocks format to holdings format
      holdings = userStocks.map(s => ({
        sym: s.sym,
        shares: s.shares || (s.mv / s.cost),
        cost: s.cost,
        sector: s.sec || 'tech',
        name: s.en || s.sym
      }));

    } else {
      // ── Rashed's portfolio (default) ──
      const FILE = 'data/portfolio.json';
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/${FILE}?t=${Date.now()}`
      );
      if (!raw.ok) throw new Error('Cannot read portfolio.json');
      const portfolio = await raw.json();
      holdings = portfolio.holdings || [];
      cash = portfolio.cash_summary || {};
    }

    // Fetch live prices for all symbols in parallel
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

    priceResults.forEach(({ sym, price }) => { priceMap[sym] = price; });

    // Calculate totals
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price   = priceMap[h.sym] || h.cost;
      const value   = Math.round(h.shares * price);
      const glPct   = ((price - h.cost) / h.cost * 100);
      totalValue   += value;
      return { ...h, livePrice: price, value, glPct };
    });

    enriched.sort((a, b) => b.value - a.value);

    // Group by sector
    const sectors = {
      tech:   { label: 'TECHNOLOGY',   items: [] },
      spec:   { label: 'SPECULATIVE',  items: [] },
      bio:    { label: 'BIOTECH',       items: [] },
      mining: { label: 'MINING',        items: [] },
      etf:    { label: 'ETFs',          items: [] },
      other:  { label: 'OTHER',         items: [] },
    };

    enriched.forEach(h => {
      const sec = sectors[h.sector] || sectors.other;
      sec.items.push(h);
    });

    // Format as plain text for Claude
    const pricesAvailable = Object.values(priceMap).filter(Boolean).length;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    let text = '';
    text += `═══════════════════════════════════════════════════════\n`;
    text += `${investorName.toUpperCase()}'S PORTFOLIO — Live as of ${timestamp}\n`;
    text += `Total Value: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
    text += `Live prices: ${pricesAvailable}/${symbols.length} stocks updated\n`;
    text += `═══════════════════════════════════════════════════════\n`;

    if (!isGenericUser) {
      // Rashed's specific investor rules
      text += `INVESTOR RULES (apply to all recommendations):\n`;
      text += `- UAE investor — ZERO capital gains tax on profits\n`;
      text += `- Cannot short sell or trade options (Wio Invest)\n`;
      text += `- SPUS = Sharia-compliant ETF — never recommend selling\n`;
      text += `- US market opens 5:30pm UAE time\n`;
      text += `- Long-term growth investor, high risk tolerance\n`;
    } else {
      text += `INVESTOR: ${investorName}, UAE investor\n`;
      text += `- Long-term growth focus\n`;
    }
    text += `═══════════════════════════════════════════════════════\n\n`;

    Object.values(sectors).forEach(sec => {
      if (sec.items.length === 0) return;
      text += `${sec.label}:\n`;
      sec.items.forEach(h => {
        const glSign  = h.glPct >= 0 ? '+' : '';
        text += `${h.sym.padEnd(6)} ${String(h.shares).padEnd(10)} sh  `;
        text += `cost $${String(h.cost.toFixed(2)).padEnd(8)}  `;
        text += `now $${String(h.livePrice.toFixed(2)).padEnd(8)}  `;
        text += `value $${h.value.toLocaleString().padEnd(8)}  `;
        text += `${glSign}${h.glPct.toFixed(1)}%\n`;
      });
      text += '\n';
    });

    text += `═══════════════════════════════════════════════════════\n`;
    text += `TOTAL PORTFOLIO VALUE: $${totalValue.toLocaleString()}\n`;

    if (!isGenericUser && cash.fresh_cash_deposited) {
      const roi = (((totalValue - cash.fresh_cash_deposited) / cash.fresh_cash_deposited) * 100).toFixed(1);
      text += `Return on cash invested: +${roi}%\n`;
    }

    text += `═══════════════════════════════════════════════════════\n`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch (e) {
    res.status(500).send(`Portfolio data unavailable: ${e.message}`);
  }
};
