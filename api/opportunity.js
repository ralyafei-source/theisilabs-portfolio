// api/opportunity.js — top non-owned Quant picks from latest SA file
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
  const owned = new Set(((pf && (pf.holdings || pf.stocks)) || []).map(h => String(h.sym).toUpperCase()));

  const rows = [...(sa.stocks || []), ...(sa.etfs || [])]
    .filter(r => { const s = String(r.symbol || r.sym || '').toUpperCase(); return s && !owned.has(s) && r['Quant Rating'] != null; })
    .sort((a, b) => b['Quant Rating'] - a['Quant Rating'])
    .slice(0, 5)
    .map(r => ({
      sym: r.symbol || r.sym,
      quant: +(+r['Quant Rating']).toFixed(2),
      V: r['Valuation Grade'] || null, G: r['Growth Grade'] || null,
      P: r['Profitability Grade'] || null, M: r['Momentum Grade'] || null,
      R: r['EPS Revision Grade'] || null,
      rsi: r['RSI'] != null ? +(+r['RSI']).toFixed(1) : null,
      price: r['Price'] != null ? +(+r['Price']).toFixed(2) : null
    }));

  return res.status(200).json({ as_of: saDate, count: rows.length, opportunities: rows });
};
