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
    inputs.updownMine   ? `[UPGRADES_MINE]\n${inputs.updownMine.slice(0,4000)}`  : '',
    inputs.updownMarket ? `[UPGRADES_MARKET]\n${inputs.updownMarket.slice(0,3000)}` : '',
    inputs.pqp          ? `[PRO_QUANT_30]\n${inputs.pqp.slice(0,6000)}`         : '',
    inputs.topRated     ? `[TOP_RATED_38]\n${inputs.topRated.slice(0,6000)}`    : '',
    inputs.alphaPicks   ? `[ALPHA_PICKS]\n${inputs.alphaPicks.slice(0,3000)}`    : '',
    inputs.exclusive    ? `[EXCLUSIVE]\n${inputs.exclusive.slice(0,3000)}`        : '',
    inputs.stockDetail  ? `[STOCK_DETAIL]\n${inputs.stockDetail.slice(0,3000)}`  : ''
  ].filter(Boolean).join('\n\n');

  return `محلل استثماري — مستثمر إماراتي لا ضريبة. محفظة ~$551K (~49 سهم). كاش: ${cashStr}.
أسهم رئيسية: NVDA 9.7%+161% | MU 7.9%+529% | AMZN 6.8%+19% | DUOL 4.4%-49% | OKTA 3.7%+28% | CRDO 2.6%+98% | CLS 1.4%+796% | PLTR 2.2%+475% | MSTR 1.8%-61% | ADBE 0.4%-61%

${parts}

قاعدة التحذيرات: ضع في "warnings" فقط الأسهم التي تملكها والتي ظهرت في بيانات [UPGRADES_MINE] أو [UPGRADES_MARKET] بنوع تغيير "Downgrade". لكل تحذير، اذكر في "reason" سبب التحذير بدقة: الجهة التي خفّضت التصنيف (Wall St. أو SA Analysts أو Quant)، والتصنيف الجديد مقابل السابق، والتاريخ. إذا خُفّض السهم من أكثر من جهة، اذكرها جميعاً كدليل أقوى. لا تضع تحذيراً لأي سهم ليس له تخفيض تصنيف فعلي في هذه البيانات.

قاعدة التقييم الكمي (Quant): لكل سهم تذكره، ابحث عنه في بيانات [PRO_QUANT_30] و[TOP_RATED_38] و[ALPHA_PICKS] وأي قائمة Stocks by Quant. إذا وُجد السهم، استخرج درجة Quant من النمط "Rating: <التصنيف><الرقم>" مثل "Strong Buy4.99" → الدرجة هي 4.99 (مقياس 1 إلى 5)، وضعها في grades.Quant. إذا لم يظهر السهم في أيٍّ من هذه القوائم، اترك Quant كـ "N/A" — لا تخمّن.

أعد JSON صارم فقط — لا نص قبله ولا بعده أبداً:
{"executive_summary":{"portfolio_value":"~$551K","weekly_performance":"نص","biggest_risk_symbol":"SYM","best_opportunity":"SYM","summary_text":"3 جمل: أهم خطر + أهم فرصة + الوضع العام","weekly_decision":"قرار واحد محدد وقابل للتنفيذ"},"warnings":[{"symbol":"SYM","rating":"Strong Sell","badges":["Short Ideas ×N"],"weight":"X%","gl":"+X%","grades":{"Quant":"X.XX","Growth":"X","Momentum":"X","EPS":"X"},"sources":"مصدر","reason":"سبب التحذير: من خفّض التصنيف، من أي تصنيف إلى أي تصنيف، والتاريخ","action":"إجراء محدد بالأرقام"}],"strong_positions":[{"symbol":"SYM","rating":"Strong Buy","badges":["PRO Quant"],"weight":"X%","gl":"+X%","grades":{"Quant":"X.XX"},"sources":"مصادر","reason":"لماذا قوي","action":"احتفظ أو زد"}],"cash_decisions":{"total_available":"${cashStr}","allocations":[{"symbol":"SYM","is_new":true,"amount_usd":"$XX,000","pct_of_cash":"XX%","reason":"سبب التأكيد"}]},"new_opportunities":[{"symbol":"SYM","rating":"Strong Buy","badges":["Top Rated #N"],"grades":{"Quant":"X.XX"},"sources":"N مصادر","reason":"لماذا مناسب","action":"اشترِ"}],"conflicts":[{"symbol":"SYM","sell_sources":"مصدر البيع","buy_sources":"مصدر الشراء","recommendation":"الترجيح"}]}`;
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

  // ── loadInputs: today's inputs, or fall back to most recent prior day ──
  if (req.body && req.body.loadInputs && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => {
        const fp = `data/sa-inputs-${date}.json`;
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
          headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' }
        });
        if (!ex.ok) return null;
        const f = await ex.json();
        const decoded = JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
        return { inputs: decoded.inputs || null, savedAt: decoded.savedAt || null, date };
      };
      // try today first
      let result = await readDay(today);
      if (result && result.inputs) {
        return res.status(200).json({ ...result, isCarryForward: false });
      }
      // fall back: list sa-inputs-*.json, pick most recent date < today
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, {
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' }
      });
      if (!dir.ok) return res.status(200).json({ inputs: null });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : [])
        .map(f => (f.name||'').match(/^sa-inputs-(\d{4}-\d{2}-\d{2})\.json$/))
        .filter(Boolean).map(m => m[1])
        .filter(dt => dt < today)
        .sort().reverse();
      if (!dates.length) return res.status(200).json({ inputs: null });
      const prior = await readDay(dates[0]);
      if (prior && prior.inputs) {
        return res.status(200).json({ ...prior, isCarryForward: true });
      }
      return res.status(200).json({ inputs: null });
    } catch(e) {
      return res.status(200).json({ inputs: null, error: e.message });
    }
  }

  // ── saveResult: store analysis result, keep last 3 per day ───────
  if (req.body && req.body.saveResult && req.body.result && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/sa-analysis-${date}.json`;
      let runs = [], sha = null;
      try {
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
          headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' }
        });
        if (ex.ok) {
          const f = await ex.json(); sha = f.sha;
          const prev = JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
          runs = Array.isArray(prev.runs) ? prev.runs : [];
        }
      } catch {}
      const version = (runs.length ? (runs[runs.length-1].version || runs.length) : 0) + 1;
      runs.push({ version, savedAt: new Date().toISOString(), result: req.body.result });
      if (runs.length > 3) runs = runs.slice(runs.length - 3);
      const body = JSON.stringify({ date, runs }, null, 2);
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' },
        body: JSON.stringify({ message: `SA analysis ${date} v${version}`, content: Buffer.from(body).toString('base64'), ...(sha?{sha}:{}) })
      });
      return res.status(200).json({ saved: sr.ok, version });
    } catch(e) {
      return res.status(200).json({ saved: false, error: e.message });
    }
  }

  // ── loadResult: return a result (optionally a specific date/version) ──
  if (req.body && req.body.loadResult && GITHUB_TOKEN) {
    try {
      const date = (req.body.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date))
        ? req.body.date : new Date().toISOString().slice(0,10);
      const fp = `data/sa-analysis-${date}.json`;
      const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' }
      });
      if (!ex.ok) return res.status(200).json({ result: null });
      const f = await ex.json();
      const data = JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
      const runs = Array.isArray(data.runs) ? data.runs : [];
      if (!runs.length) return res.status(200).json({ result: null });
      let run = runs[runs.length-1];
      if (req.body.version != null) {
        const found = runs.find(r => r.version === req.body.version);
        if (found) run = found;
      }
      return res.status(200).json({
        result: run.result, savedAt: run.savedAt, version: run.version,
        count: runs.length, versions: runs.map(r => ({ version: r.version, savedAt: r.savedAt })), date
      });
    } catch(e) {
      return res.status(200).json({ result: null, error: e.message });
    }
  }

  // ── listAnalyses: return dates that have a saved analysis ────────
  if (req.body && req.body.listAnalyses && GITHUB_TOKEN) {
    try {
      const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, {
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' }
      });
      if (!ex.ok) return res.status(200).json({ dates: [] });
      const files = await ex.json();
      const dates = (Array.isArray(files) ? files : [])
        .map(f => (f.name || '').match(/^sa-analysis-(\d{4}-\d{2}-\d{2})\.json$/))
        .filter(Boolean).map(m => m[1])
        .sort().reverse();
      return res.status(200).json({ dates });
    } catch(e) {
      return res.status(200).json({ dates: [], error: e.message });
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
