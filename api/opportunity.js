// api/opportunity.js — top non-owned Quant picks from latest SA file
// Returns: top overall + a diversifier (best pick OUTSIDE the overweight sector) with risk context.
const REPO = 'ralyafei-source/theisilabs-portfolio';

async function ghRead(path) {
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`);
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const nickname = (req.query.nickname || 'rashed').toLowerCase();

  let sa = null, saDate = null;
  for (let o = 0; o < 30; o++) {
    const d = new Date(Date.now() + 4 * 3600000 - o * 86400000).toISOString().slice(0, 10);
    sa = await ghRead(`data/sa-portfolio-${d}.json`);
    if (sa) { saDate = d; break; }
  }
  if (!sa) return res.status(404).json({ error: 'no SA data found' });

  const pf = await ghRead(nickname === 'rashed' ? 'data/portfolio.json' : `data/portfolio-${nickname}.json`);
  const holdings = (pf && (pf.holdings || pf.stocks)) || [];
  const owned = new Set(holdings.map(h => String(h.sym).toUpperCase()));

  // sector concentration from portfolio (by cost value as proxy; live prices not needed for weights signal)
  const secVal = {};
  let total = 0;
  holdings.forEach(h => { const v = (h.shares || 0) * (h.cost || 0); total += v; secVal[h.sector || 'other'] = (secVal[h.sector || 'other'] || 0) + v; });
  let topSector = null, topPct = 0;
  Object.entries(secVal).forEach(([s, v]) => { const p = total ? v / total * 100 : 0; if (p > topPct) { topPct = p; topSector = s; } });
  topPct = +topPct.toFixed(1);
  const overweight = topPct >= 50;

  const norm = s => String(s || '').toLowerCase();
  const isTech = s => /tech|information/.test(norm(s));
  const topIsTech = isTech(topSector);

  const mapRow = r => ({
    sym: r.symbol || r.sym,
    sector: r['Sector'] || null,
    quant: +(+r['Quant Rating']).toFixed(2),
    V: r['Valuation Grade'] || null, G: r['Growth Grade'] || null,
    P: r['Profitability Grade'] || null, M: r['Momentum Grade'] || null,
    R: r['EPS Revision Grade'] || null,
    rsi: r['RSI'] != null ? +(+r['RSI']).toFixed(1) : null,
    price: r['Price'] != null ? +(+r['Price']).toFixed(2) : null
  });

  const pool = [...(sa.stocks || []), ...(sa.etfs || [])]
    .filter(r => { const s = String(r.symbol || r.sym || '').toUpperCase(); return s && !owned.has(s) && r['Quant Rating'] != null; })
    .sort((a, b) => b['Quant Rating'] - a['Quant Rating'])
    .map(mapRow);

  if (!pool.length) return res.status(200).json({ as_of: saDate, opportunities: [] });

  const top = pool[0];
  const sameSectorAsOverweight = overweight && (topIsTech ? isTech(top.sector) : norm(top.sector) === norm(topSector));
  top.risk_note = sameSectorAsOverweight
    ? `يزيد التركّز الحالي: قطاع ${topSector} يمثل ${topPct}% من المحفظة`
    : '';

  let diversifier = null;
  if (sameSectorAsOverweight) {
    diversifier = pool.find(x => (topIsTech ? !isTech(x.sector) : norm(x.sector) !== norm(topSector))) || null;
    if (diversifier) diversifier.risk_note = `مُقترح بديل فقط بسبب تركّز ${topSector} عند ${topPct}% — أفضل تقييم خارج القطاع`;
  }

  return res.status(200).json({
    as_of: saDate,
    universe: 'قائمة متابعة Seeking Alpha الخاصة بك — ليست مسحاً لكامل السوق',
    concentration: { sector: topSector, pct: topPct },
    opportunities: [top, ...(diversifier ? [diversifier] : [])]
  });
};
