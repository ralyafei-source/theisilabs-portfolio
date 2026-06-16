// api/sa-analyze.js — THEISI SA PRO Intelligence Engine FINAL
// Dashboard sends: saveOnly (inputs only) OR {inputs} for full analysis
// GitHub save happens in saveOnly call. Main call is Claude-only = fast.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const REPO          = 'ralyafei-source/theisilabs-portfolio';

function buildPrompt(inputs) {
  const cashUSD = inputs.cashUSD || 0;
  const cashStr = cashUSD > 0 ? '$' + Number(cashUSD).toLocaleString() + ' / ' + Number(inputs.cash||0).toLocaleString() + ' ' + (inputs.currency||'AED') : 'غير محدد';

  const parts = [
    inputs.shortIdeas   ? `[SHORT_IDEAS]\n${inputs.shortIdeas.slice(0,2000)}`   : '',
    inputs.updownMine   ? `[UPGRADES_MINE]\n${inputs.updownMine.slice(0,800)}`  : '',
    inputs.updownMarket ? `[UPGRADES_MARKET]\n${inputs.updownMarket.slice(0,600)}` : '',
    inputs.pqp          ? `[PRO_QUANT_30]\n${inputs.pqp.slice(0,1200)}`         : '',
    inputs.topRated     ? `[TOP_RATED_38]\n${inputs.topRated.slice(0,1200)}`    : '',
    inputs.alphaPicks   ? `[ALPHA_PICKS]\n${inputs.alphaPicks.slice(0,800)}`    : '',
    inputs.exclusive    ? `[EXCLUSIVE]\n${inputs.exclusive.slice(0,600)}`        : '',
    inputs.stockDetail  ? `[STOCK_DETAIL]\n${inputs.stockDetail.slice(0,800)}`  : ''
  ].filter(Boolean).join('\n\n');

  return `محلل استثماري — مستثمر إماراتي لا ضريبة. محفظة ~$551K (~49 سهم). كاش: ${cashStr}.
أسهم رئيسية: NVDA 9.7%+161% | MU 7.9%+529% | AMZN 6.8%+19% | DUOL 4.4%-49% | OKTA 3.7%+28% | CRDO 2.6%+98% | CLS 1.4%+796% | PLTR 2.2%+475% | MSTR 1.8%-61% | ADBE 0.4%-61%

${parts}

أعد JSON صارم فقط — لا نص قبله ولا بعده أبداً:
{"executive_summary":{"portfolio_value":"~$551K","weekly_performance":"نص","biggest_risk_symbol":"SYM","best_opportunity":"SYM","summary_text":"3 جمل: أهم خطر + أهم فرصة + الوضع العام","weekly_decision":"قرار واحد محدد وقابل للتنفيذ"},"warnings":[{"symbol":"SYM","rating":"Strong Sell","badges":["Short Ideas ×N"],"weight":"X%","gl":"+X%","grades":{"Quant":"X.XX","Growth":"X","Momentum":"X","EPS":"X"},"sources":"مصدر","reason":"جملة واحدة مرتبطة بمحفظتك","action":"إجراء محدد بالأرقام"}],"strong_positions":[{"symbol":"SYM","rating":"Strong Buy","badges":["PRO Quant"],"weight":"X%","gl":"+X%","grades":{"Quant":"X.XX"},"sources":"مصادر","reason":"لماذا قوي","action":"احتفظ أو زد"}],"cash_decisions":{"total_available":"${cashStr}","allocations":[{"symbol":"SYM","is_new":true,"amount_usd":"$XX,000","pct_of_cash":"XX%","reason":"سبب التأكيد"}]},"new_opportunities":[{"symbol":"SYM","rating":"Strong Buy","badges":["Top Rated #N"],"grades":{"Quant":"X.XX"},"sources":"N مصادر","reason":"لماذا مناسب","action":"اشترِ"}],"conflicts":[{"symbol":"SYM","sell_sources":"مصدر البيع","buy_sources":"مصدر الشراء","recommendation":"الترجيح"}]}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { inputs, prompt, saveOnly } = req.body || {};
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  // ── saveOnly: just save inputs, return fast ────────────────────────────────
  if (saveOnly && inputs && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/sa-inputs-${date}.json`;
      const fc = JSON.stringify({ date, inputs, savedAt: new Date().toISOString() }, null, 2);
      let sha = null;
      try {
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
          headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' }
        });
        if (ex.ok) sha = (await ex.json()).sha;
      } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' },
        body: JSON.stringify({ message: `SA inputs ${date}`, content: Buffer.from(fc).toString('base64'), ...(sha ? { sha } : {}) })
      });
      return res.status(200).json({ saved: sr.ok ? fp : false });
    } catch(e) {
      return res.status(200).json({ saved: false, error: e.message });
    }
  }

  // ── Analysis: build prompt + call Claude (NO GitHub save here) ────────────
  const finalPrompt = inputs ? buildPrompt(inputs) : prompt;
  if (!finalPrompt) return res.status(400).json({ error: 'inputs or prompt required' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages: [{ role: 'user', content: finalPrompt }] })
    });
    const d = await r.json();
    if (!d.content?.[0]?.text) return res.status(500).json({ error: 'No response', raw: JSON.stringify(d).slice(0,200) });
    return res.status(200).json({
      result: d.content[0].text,
      usage: {
        input_tokens:  d.usage?.input_tokens  || 0,
        output_tokens: d.usage?.output_tokens || 0,
        total_tokens:  (d.usage?.input_tokens||0) + (d.usage?.output_tokens||0),
        input_cost:  ((d.usage?.input_tokens||0)  / 1000000 * 3).toFixed(4),
        output_cost: ((d.usage?.output_tokens||0) / 1000000 * 15).toFixed(4),
        total_cost:  (((d.usage?.input_tokens||0)/1000000*3)+((d.usage?.output_tokens||0)/1000000*15)).toFixed(4)
      }
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
