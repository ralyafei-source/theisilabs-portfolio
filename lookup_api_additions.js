// ═══════════════════════════════════════════════════════════════════════════
// THEISI — STOCK LOOKUP API ADDITIONS
// Adds: financials (3-yr history), priceHistory (1-yr chart),
//       companyName + beta (from profile)
//
// These four FMP calls return the data the redesigned Stock Lookup
// frontend reads: d.financials, d.priceHistory, d.companyName, d.beta
//
// Uses the SAME fmpGet() helper and FMP /stable base you already have.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Build the 3-year financial history (FY-2, FY-1, TTM) ────────────────────
// Returns an array oldest→newest, last entry = TTM, for the lookup table.
async function lookupFinancials(sym) {
  // annual income + cash-flow, last 3 fiscal years
  const [income, cashflow] = await Promise.all([
    fmpGet(`/income-statement?symbol=${sym}&period=annual&limit=3`),
    fmpGet(`/cash-flow-statement?symbol=${sym}&period=annual&limit=3`),
  ]);
  if (!Array.isArray(income) || income.length === 0) return null;

  // FMP returns newest→oldest; reverse to oldest→newest for the table
  const inc = [...income].reverse();
  const cf  = Array.isArray(cashflow) ? [...cashflow].reverse() : [];

  const rows = inc.map((y, i) => {
    const revenue   = y.revenue ?? null;
    const netIncome = y.netIncome ?? null;
    const fcfRow    = cf.find(c => c.calendarYear === y.calendarYear) || cf[i] || {};
    const freeCashFlow = fcfRow.freeCashFlow ?? null;
    const netMargin = (revenue && netIncome != null) ? (netIncome / revenue * 100) : null;
    return {
      label: y.period === 'FY' ? `FY${y.calendarYear}` : (y.calendarYear || y.date || ''),
      year: y.calendarYear,
      revenue,
      netIncome,
      netMargin,
      freeCashFlow,
    };
  });

  // Append a TTM column from the most recent metrics you already fetch.
  // If you have key-metrics-ttm or a quote handy, you can fill TTM here.
  // Otherwise the newest fiscal year stands as the latest column.
  return rows;
}

// ─── 1-year daily price history for the chart ────────────────────────────────
async function lookupPriceHistory(sym) {
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  // "light" endpoint returns just {symbol, date, price} — perfect & cheap
  const data = await fmpGet(`/historical-price-eod/light?symbol=${sym}&from=${from}&to=${to}`);
  if (!Array.isArray(data) || data.length === 0) return null;
  // FMP returns newest→oldest; reverse to oldest→newest for the line chart.
  // Downsample to ~52 weekly points to keep the payload small.
  const asc = [...data].reverse();
  const step = Math.max(1, Math.floor(asc.length / 52));
  const sampled = asc.filter((_, i) => i % step === 0);
  return sampled.map(p => ({ date: p.date, price: p.price ?? p.close ?? null }))
                .filter(p => p.price != null);
}

// ─── Company profile: name, beta, sector, description ────────────────────────
async function lookupProfile(sym) {
  const prof = await fmpGet(`/profile?symbol=${sym}`);
  const p = Array.isArray(prof) ? prof[0] : prof;
  if (!p) return {};
  return {
    companyName: p.companyName || null,
    beta:        p.beta ?? null,
    sector:      p.sector || null,
    description: p.description || null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HOW TO USE IN YOUR LOOKUP HANDLER
// ───────────────────────────────────────────────────────────────────────────
// Wherever you currently build the lookup `data` object (the one the frontend
// reads as res.data), add the three calls in parallel and merge the results:
//
//   const [financials, priceHistory, profile] = await Promise.all([
//     lookupFinancials(sym),
//     lookupPriceHistory(sym),
//     lookupProfile(sym),
//   ]);
//
//   const data = {
//     ...existingLookupData,        // symbol, price, changePct, marketCap,
//                                   // pe, peg, roe, revenueGrowth, targetMean,
//                                   // dcfValue, analystConsensus, grades
//     companyName: profile.companyName,
//     beta:        profile.beta,
//     financials,                   // → renders the Financial History table
//     priceHistory,                 // → renders the Price-vs-Fair-Value chart
//   };
//
//   return res.status(200).json({ data, analysis });
// ═══════════════════════════════════════════════════════════════════════════
