// api/sa-analyze.js — THEISI SA PRO Intelligence Engine v2
// Builds prompt server-side, calls Claude, returns structured JSON + token count

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const REPO          = 'ralyafei-source/theisilabs-portfolio';

function buildPrompt(inputs) {
  const cashUSD = inputs.cashUSD || 0;
  const cashStr = cashUSD > 0 ? '$' + Number(cashUSD).toLocaleString() + ' / ' + Number(inputs.cash||0).toLocaleString() + ' ' + (inputs.currency||'AED') : 'غير محدد';

  const dataBlock = [
    inputs.shortIdeas   ? `[SHORT_IDEAS]\n${inputs.shortIdeas.slice(0,2000)}`   : '',
    inputs.updownMine   ? `[UPGRADES_MINE]\n${inputs.updownMine.slice(0,1000)}` : '',
    inputs.updownMarket ? `[UPGRADES_MARKET]\n${inputs.updownMarket.slice(0,800)}` : '',
    inputs.pqp          ? `[PRO_QUANT_30 — columns: symbol | picked | price | sector | weight% | quant_rating | quant_score | price_return%]\n${inputs.pqp.slice(0,1500)}` : '',
    inputs.topRated     ? `[TOP_RATED_38 — columns: rank | symbol | quant | SA_analyst | wall_street | valuation | growth | profit | momentum | EPS]\n${inputs.topRated.slice(0,1500)}` : '',
    inputs.exclusive    ? `[EXCLUSIVE_COVERAGE]\n${inputs.exclusive.slice(0,800)}`  : '',
    inputs.alphaPicks   ? `[ALPHA_PICKS]\n${inputs.alphaPicks.slice(0,1000)}`      : '',
    inputs.quantScreen  ? `[QUANT_SCREEN]\n${inputs.quantScreen.slice(0,800)}`     : '',
    inputs.stockDetail  ? `[STOCK_DETAIL]\n${inputs.stockDetail.slice(0,1000)}`    : ''
  ].filter(Boolean).join('\n\n');

  return `محلل استثماري متخصص — مستثمر إماراتي، لا ضريبة أرباح رأسمالية.
محفظة: ~49 سهم، ~$551K. كاش متاح: ${cashStr}.

أسهم رئيسية (وزن / ربح أو خسارة):
NVDA 9.7%+161% | MU 7.9%+529% | AMZN 6.8%+19% | DUOL 4.4%-49%
OKTA 3.7%+28% | ONTO 3.1%+87% | CRDO 2.6%+98% | CLS 1.4%+796%
PLTR 2.2%+475% | MSTR 1.8%-61% | ADBE 0.4%-61% | SERV 0.9%-51%
ATYR 1.1%-80% | MVST 1.4%-71% | SEZL 1.1%+61% | PANW 2.2%+61%
MSFT 3.1%-5% | GOOGL 3.4%+41% | QQQ 3.5%+68% | APH 2.9%+26%

${dataBlock}

أعد JSON صارم فقط — لا نص قبله ولا بعده:
{
  "executive_summary": {
    "portfolio_value": "~$551K",
    "weekly_performance": "جملة وصف الأداء",
    "biggest_risk_symbol": "SYMBOL",
    "best_opportunity": "SYMBOL",
    "summary_text": "3 جمل: أهم خطر + أهم فرصة + الوضع العام",
    "weekly_decision": "قرار واحد محدد وقابل للتنفيذ هذا الأسبوع"
  },
  "warnings": [
    {
      "symbol": "NVDA",
      "rating": "Strong Sell",
      "badges": ["Short Ideas ×N", "Quant 3.XX"],
      "weight": "9.7%",
      "gl": "+161%",
      "grades": {"Quant": "3.48", "Growth": "A+", "Momentum": "B-", "EPS": "B-"},
      "sources": "اسم المحلل أو المصدر",
      "reason": "جملة واحدة: لماذا تحذير مرتبط بوضعه في محفظتك تحديداً",
      "action": "إجراء محدد بالأرقام: بيع كم سهم أو كم دولار"
    }
  ],
  "strong_positions": [
    {
      "symbol": "MU",
      "rating": "Strong Buy",
      "badges": ["PRO Quant #1", "Alpha Picks"],
      "weight": "7.9%",
      "gl": "+529%",
      "grades": {"Quant": "4.99", "Growth": "A+", "Profit": "A+", "Momentum": "A+"},
      "sources": "PRO Quant + Alpha Picks",
      "reason": "جملة واحدة: لماذا قوي مرتبطاً بوضعه الفعلي",
      "action": "احتفظ / زد / لا تضف — مع سبب"
    }
  ],
  "cash_decisions": {
    "total_available": "${cashStr}",
    "allocations": [
      {
        "symbol": "SNDK",
        "is_new": true,
        "amount_usd": "$45,000",
        "pct_of_cash": "27.5%",
        "reason": "Quant 4.99 · Top Rated #1 · PRO Quant · Alpha Picks — تأكيد 4 مصادر"
      }
    ]
  },
  "new_opportunities": [
    {
      "symbol": "SNDK",
      "rating": "Strong Buy",
      "badges": ["Top Rated #1", "PRO Quant", "Alpha Picks"],
      "grades": {"Quant": "4.99", "Momentum": "A+", "EPS": "B+"},
      "sources": "3 مصادر SA",
      "reason": "لماذا هذا السهم تحديداً مناسب لمحفظتك",
      "action": "راجع توزيع الكاش في التبويب أعلاه"
    }
  ],
  "conflicts": [
    {
      "symbol": "MU",
      "sell_sources": "Short Ideas: Sell — David McMillan — Micron Bubble",
      "buy_sources": "PRO Quant 4.99 + Alpha Picks +470%",
      "recommendation": "PRO Quant أقوى من رأي محلل واحد — احتفظ مع مراقبة"
    }
  ]
}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { inputs, prompt, saveOnly } = req.body || {};
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  // ── Save inputs to GitHub ──────────────────────────────────────────────────
  let savedPath = null;
  if (inputs && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const filePath = `data/sa-inputs-${date}.json`;
      const fileContent = JSON.stringify({ date, inputs, savedAt: new Date().toISOString() }, null, 2);
      let sha = null;
      try {
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${filePath}`, {
          headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' }
        });
        if (ex.ok) { sha = (await ex.json()).sha; }
      } catch {}
      const saveBody = { message: `SA Intel inputs — ${date}`, content: Buffer.from(fileContent).toString('base64'), ...(sha ? { sha } : {}) };
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${filePath}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' },
        body: JSON.stringify(saveBody)
      });
      if (sr.ok) savedPath = filePath;
    } catch {}
  }

  if (saveOnly) return res.status(200).json({ saved: savedPath || false });

  // ── Build prompt (use server-side builder if inputs provided, else use passed prompt) ──
  const finalPrompt = (inputs && Object.keys(inputs).length > 0) ? buildPrompt(inputs) : prompt;
  if (!finalPrompt) return res.status(400).json({ error: 'inputs or prompt required' });

  // ── Call Claude ────────────────────────────────────────────────────────────
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 10000, messages: [{ role: 'user', content: finalPrompt }] })
    });
    const data = await r.json();
    if (!data.content?.[0]?.text) return res.status(500).json({ error: 'No response from Claude', raw: JSON.stringify(data).slice(0,200) });

    return res.status(200).json({
      result: data.content[0].text,
      savedPath,
      usage: {
        input_tokens:  data.usage?.input_tokens  || 0,
        output_tokens: data.usage?.output_tokens || 0,
        total_tokens:  (data.usage?.input_tokens||0) + (data.usage?.output_tokens||0),
        input_cost:    ((data.usage?.input_tokens||0)  / 1000000 * 3).toFixed(4),
        output_cost:   ((data.usage?.output_tokens||0) / 1000000 * 15).toFixed(4),
        total_cost:    (((data.usage?.input_tokens||0)/1000000*3) + ((data.usage?.output_tokens||0)/1000000*15)).toFixed(4)
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
