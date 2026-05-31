// api/market-intelligence.js
// Smart data filter — reads portfolio dynamically per user, fetches only
// relevant earnings, analyst targets, grades, and key metrics from FMP
// Called by Make.com Scenario 255 + 357
// Usage: /api/market-intelligence?nickname=rashed (or omit for default)

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const FMP_KEY = 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
const FMP     = 'https://financialmodelingprep.com/stable';

// ─── helpers ────────────────────────────────────────────────────────────────

async function fmpGet(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? d : (d?.Error ? null : d);
  } catch {
    return null;
  }
}

function today() {
  const d = new Date(Date.now() + 4 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function daysAhead(n) {
  const d = new Date(Date.now() + 4 * 3600 * 1000 + n * 86400000);
  return d.toISOString().slice(0, 10);
}

// ─── main ────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {

    // ── 1. Read portfolio symbols dynamically ────────────────────────────────
    // Multi-user: ?nickname=ahmed reads portfolio-ahmed.json
    // No nickname = reads portfolio.json (admin/default)
    const nickname      = req.query?.nickname || null;
    const portfolioFile = nickname
      ? `data/portfolio-${nickname}.json`
      : `data/portfolio.json`;

    const raw = await fetch(
      `https://raw.githubusercontent.com/${REPO}/main/${portfolioFile}?t=${Date.now()}`
    );
    if (!raw.ok) throw new Error(`Cannot read ${portfolioFile}`);
    const portfolio  = await raw.json();
    const holdings   = portfolio.holdings || [];
    const ownedSyms  = holdings.map(h => h.sym);

    if (ownedSyms.length === 0) throw new Error('No holdings found in portfolio');

    // ── 2. Read today's market movers from saved market data ─────────────────
    // Market data is shared across all users — saved once by Scenario 255
    let moverSyms = [];
    try {
      const mdr = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/data/market-data-${today()}.json?t=${Date.now()}`
      );
      if (mdr.ok) {
        const md   = await mdr.json();
        const text = typeof md === 'string' ? md : JSON.stringify(md);
        const matches = text.match(/"ticker"\s*:\s*"([A-Z]{1,6})"/g) || [];
        moverSyms = [...new Set(
          matches.map(m => m.match(/"([A-Z]{1,6})"/)?.[1])
                 .filter(Boolean)
        )].slice(0, 20);
      }
    } catch { /* market data not yet saved — skip */ }

    // ── 3. Build smart symbol list ───────────────────────────────────────────
    // Portfolio stocks first, then today's movers — deduplicated
    const allSyms  = [...new Set([...ownedSyms, ...moverSyms])];
    const symList  = allSyms.join(',');
    const ownedSet = new Set(ownedSyms);

    // ── 4. Fetch all FMP data in parallel ────────────────────────────────────
    const [earnings, targets, grades, metrics] = await Promise.all([
      fmpGet(`/earnings-calendar?from=${today()}&to=${daysAhead(60)}&symbol=${symList}`),
      fmpGet(`/price-target-consensus?symbol=${symList}`),
      fmpGet(`/grades?symbol=${symList}&limit=5`),
      fmpGet(`/key-metrics-ttm?symbol=${symList}`)
    ]);

    // ── 5. Tag and sort — portfolio stocks always first ───────────────────────
    const tagOwned = (arr, symField = 'symbol') =>
      (arr || []).map(item => ({
        ...item,
        inPortfolio: ownedSet.has(item[symField])
      }));

    const earningsSorted = (earnings || [])
      .map(e => ({ ...e, inPortfolio: ownedSet.has(e.symbol) }))
      .sort((a, b) => {
        if (a.inPortfolio && !b.inPortfolio) return -1;
        if (!a.inPortfolio && b.inPortfolio) return 1;
        return new Date(a.date) - new Date(b.date);
      });

    // ── 6. Build final output ─────────────────────────────────────────────────
    const output = {
      generated:        new Date().toISOString(),
      date_today:       today(),
      user:             nickname || 'admin',
      portfolio_size:   ownedSyms.length,
      symbols_tracked:  allSyms.length,

      earnings_calendar: {
        portfolio_stocks: earningsSorted.filter(e => e.inPortfolio),
        market_movers:    earningsSorted.filter(e => !e.inPortfolio).slice(0, 10)
      },

      analyst_targets: tagOwned(targets),
      analyst_grades:  tagOwned(grades),
      key_metrics:     tagOwned(metrics),

      portfolio_symbols: ownedSyms,
      movers_tracked:    moverSyms
    };

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(output);

  } catch (e) {
    res.status(500).json({
      error:   e.message,
      message: 'Market intelligence unavailable — use individual module data as fallback'
    });
  }
};
