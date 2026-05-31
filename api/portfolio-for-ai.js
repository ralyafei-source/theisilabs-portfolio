// api/portfolio-for-ai.js
// Returns portfolio as formatted plain text for Claude
// Supports ?nickname=ahmed for per-user portfolios
// Supports ?include=intelligence for smart FMP data (earnings, targets, grades, metrics)
// Default (no nickname): reads Rashed's portfolio.json

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const FMP_KEY = 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
const FMP     = 'https://financialmodelingprep.com/stable';

// ─── FMP helper ──────────────────────────────────────────────────────────────
async function fmpGet(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? d : (d?.Error ? null : d);
  } catch { return null; }
}

function todayUAE() {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysAheadUAE(n) {
  return new Date(Date.now() + 4 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);
}

// ─── main ────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  // Auth check
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ', '').trim();
  if (key && key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { nickname, include } = req.query;
  const wantIntelligence = include === 'intelligence';

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
      holdings = userStocks.map(s => ({
        sym: s.sym, shares: s.shares || (s.mv / s.cost),
        cost: s.cost, sector: s.sec || 'tech', name: s.en || s.sym
      }));

    } else {
      // ── Rashed's portfolio (default) ──
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/data/portfolio.json?t=${Date.now()}`
      );
      if (!raw.ok) throw new Error('Cannot read portfolio.json');
      const portfolio = await raw.json();
      holdings = portfolio.holdings || [];
      cash = portfolio.cash_summary || {};
    }

    const symbols  = holdings.map(h => h.sym);
    const ownedSet = new Set(symbols);

    // ── Live prices (Yahoo Finance) ──────────────────────────────────────────
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
          return { sym, price: d?.chart?.result?.[0]?.meta?.regularMarketPrice || null };
        } catch { return { sym, price: null }; }
      })
    );
    priceResults.forEach(({ sym, price }) => { priceMap[sym] = price; });

    // ── Calculate totals ─────────────────────────────────────────────────────
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price = priceMap[h.sym] || h.cost;
      const value = Math.round(h.shares * price);
      const glPct = ((price - h.cost) / h.cost * 100);
      totalValue += value;
      return { ...h, livePrice: price, value, glPct };
    });
    enriched.sort((a, b) => b.value - a.value);

    // ── Group by sector ──────────────────────────────────────────────────────
    const sectors = {
      tech:   { label: 'TECHNOLOGY',  items: [] },
      spec:   { label: 'SPECULATIVE', items: [] },
      bio:    { label: 'BIOTECH',     items: [] },
      mining: { label: 'MINING',      items: [] },
      etf:    { label: 'ETFs',        items: [] },
      other:  { label: 'OTHER',       items: [] },
    };
    enriched.forEach(h => { (sectors[h.sector] || sectors.other).items.push(h); });

    // ── Format portfolio text ────────────────────────────────────────────────
    const pricesAvailable = Object.values(priceMap).filter(Boolean).length;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    let text = '';
    text += `═══════════════════════════════════════════════════════\n`;
    text += `${investorName.toUpperCase()}'S PORTFOLIO — Live as of ${timestamp}\n`;
    text += `Total Value: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
    text += `Live prices: ${pricesAvailable}/${symbols.length} stocks updated\n`;
    text += `═══════════════════════════════════════════════════════\n`;

    if (!isGenericUser) {
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
        const glSign = h.glPct >= 0 ? '+' : '';
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

    // ── Market Intelligence (only when ?include=intelligence) ────────────────
    if (wantIntelligence) {

      // Read today's market movers from saved market-data file
      // (Module 37 now saves this BEFORE Module 12 calls this endpoint)
      let moverSyms = [];
      try {
        const mdr = await fetch(
          `https://raw.githubusercontent.com/${REPO}/main/data/market-data-${todayUAE()}.json?t=${Date.now()}`
        );
        if (mdr.ok) {
          const md   = await mdr.json();
          const str  = typeof md === 'string' ? md : JSON.stringify(md);
          const matches = str.match(/"ticker"\s*:\s*"([A-Z]{1,6})"/g) || [];
          moverSyms = [...new Set(
            matches.map(m => m.match(/"([A-Z]{1,6})"/)?.[1]).filter(Boolean)
          )].slice(0, 20);
        }
      } catch { /* market data not yet available — skip */ }

      // Combined symbol list: portfolio first, then movers
      const allSyms = [...new Set([...symbols, ...moverSyms])];
      const symList = allSyms.join(',');

      // Fetch all FMP intelligence in parallel
      const [earnings, targets, grades, metrics] = await Promise.all([
        fmpGet(`/earnings-calendar?from=${todayUAE()}&to=${daysAheadUAE(60)}&symbol=${symList}`),
        fmpGet(`/price-target-consensus?symbol=${symList}`),
        fmpGet(`/grades?symbol=${symList}&limit=5`),
        fmpGet(`/key-metrics-ttm?symbol=${symList}`)
      ]);

      // Tag each item — is it in the portfolio or just a mover?
      const tag = (arr, f = 'symbol') =>
        (arr || []).map(i => ({ ...i, inPortfolio: ownedSet.has(i[f]) }));

      // Sort earnings — portfolio stocks first, then by date
      const earningsSorted = tag(earnings || [])
        .sort((a, b) => {
          if (a.inPortfolio && !b.inPortfolio) return -1;
          if (!a.inPortfolio && b.inPortfolio) return 1;
          return new Date(a.date) - new Date(b.date);
        });

      // Append intelligence block to text
      text += `\n═══════════════════════════════════════════════════════\n`;
      text += `MARKET INTELLIGENCE — ${todayUAE()}\n`;
      text += `Portfolio symbols: ${symbols.join(', ')}\n`;
      text += `Market movers tracked: ${moverSyms.join(', ') || 'none yet'}\n`;
      text += `═══════════════════════════════════════════════════════\n\n`;

      text += `EARNINGS CALENDAR (next 60 days — portfolio stocks first):\n`;
      text += JSON.stringify({
        portfolio: earningsSorted.filter(e => e.inPortfolio),
        movers:    earningsSorted.filter(e => !e.inPortfolio).slice(0, 10)
      }, null, 2) + '\n\n';

      text += `ANALYST PRICE TARGETS:\n`;
      text += JSON.stringify(tag(targets), null, 2) + '\n\n';

      text += `ANALYST GRADES (recent):\n`;
      text += JSON.stringify(tag(grades), null, 2) + '\n\n';

      text += `KEY METRICS TTM (P/E, ROE, margins etc):\n`;
      text += JSON.stringify(tag(metrics), null, 2) + '\n';

      text += `\n═══════════════════════════════════════════════════════\n`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch (e) {
    res.status(500).send(`Portfolio data unavailable: ${e.message}`);
  }
};
