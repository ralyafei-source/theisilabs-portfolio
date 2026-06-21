// api/sa-analyze.js — THEISI SA PRO Intelligence Engine FINAL
// Dashboard sends: saveOnly (inputs only) OR {inputs} for full analysis
// GitHub save happens in saveOnly call. Main call is Claude-only = fast.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const REPO          = 'ralyafei-source/theisilabs-portfolio';

// Bucket scorer lives in api/_lib/ — the leading underscore means Vercel does NOT
// turn it into a Serverless Function (utility-file rule), so it does not count
// toward the 12-function limit. It is imported here, not routed.
const { computeBuckets } = require('./_lib/bucket-scorer.js');
// Deep-read prompt builder (non-routed _lib — see scorer note above).
const { buildDeepReadPrompt } = require('./_lib/deep-read.js');

function buildPrompt(inputs) {
  const cashUSD = inputs.cashUSD || 0;
  const cashStr = cashUSD > 0 ? '$' + Number(cashUSD).toLocaleString() + ' / ' + Number(inputs.cash||0).toLocaleString() + ' ' + (inputs.currency||'AED') : 'غير محدد';

  // REAL portfolio from the store (no hardcoding). Value total computed in code.
  const rows = Array.isArray(inputs.excelRows) ? inputs.excelRows : [];
  let totalVal = 0;
  rows.forEach(r => { const v = Number(r.Value || r.value || 0); if(!isNaN(v)) totalVal += v; });
  const totalStr = totalVal > 0 ? '$' + Math.round(totalVal).toLocaleString() : 'غير متوفر';

  // per-stock grade lines so the AI never writes N/A for a stock we own
  const gradeLines = rows.filter(r => r.symbol || r.sym).map(r => {
    const g = r.grades || {};
    const sym = (r.symbol || r.sym);
    return `${sym}: Quant ${r.quant ?? r['Quant Rating'] ?? '—'} | V:${g.V ?? r['Valuation Grade'] ?? '—'} G:${g.G ?? r['Growth Grade'] ?? '—'} P:${g.P ?? r['Profitability Grade'] ?? '—'} M:${g.M ?? r['Momentum Grade'] ?? '—'} R:${g.R ?? r['EPS Revision Grade'] ?? '—'} | shares ${r.shares ?? '—'} cost ${r.cost ?? '—'} value ${r.Value ?? r.value ?? '—'}`;
  }).join('\n');

  const portfolioBlock =
`القيمة الإجمالية للمحفظة (محسوبة من الملف — استخدمها كما هي، لا تعِد حسابها ولا تخمّن غيرها): ${totalStr}
عدد الأسهم: ${rows.length}. الكاش: ${cashStr}.

درجات كل سهم تملكه (استخدم هذه الدرجات حرفياً في warnings وstrong_positions — لا تكتب N/A لسهم موجود هنا):
${gradeLines}`;

  const parts = [
    inputs.updownMine   ? `[UPGRADES_MINE]\n${inputs.updownMine.slice(0,4000)}`  : '',
    inputs.updownMarket ? `[UPGRADES_MARKET]\n${inputs.updownMarket.slice(0,3000)}` : '',
    inputs.pqp          ? `[PRO_QUANT_30]\n${inputs.pqp.slice(0,6000)}`         : '',
    inputs.topRated     ? `[TOP_RATED_38]\n${inputs.topRated.slice(0,6000)}`    : '',
    inputs.alphaPicks   ? `[ALPHA_PICKS]\n${inputs.alphaPicks.slice(0,3000)}`    : '',
    inputs.exclusive    ? `[EXCLUSIVE]\n${inputs.exclusive.slice(0,3000)}`        : '',
    inputs.stockDetail  ? `[STOCK_DETAIL]\n${inputs.stockDetail.slice(0,3000)}`  : ''
  ].filter(Boolean).join('\n\n');

  return `محلل استثماري — مستثمر إماراتي لا ضريبة. ${portfolioBlock}

${parts}

قاعدة التحذيرات: ضع في "warnings" فقط الأسهم التي تملكها والتي ظهرت في بيانات [UPGRADES_MINE] أو [UPGRADES_MARKET] بنوع تغيير "Downgrade". لكل تحذير، اذكر في "reason" سبب التحذير بدقة: الجهة التي خفّضت التصنيف (Wall St. أو SA Analysts أو Quant)، والتصنيف الجديد مقابل السابق، والتاريخ. إذا خُفّض السهم من أكثر من جهة، اذكرها جميعاً كدليل أقوى. لا تضع تحذيراً لأي سهم ليس له تخفيض تصنيف فعلي في هذه البيانات.

قاعدة التقييم الكمي (Quant): لكل سهم تذكره، ابحث عنه في بيانات [PRO_QUANT_30] و[TOP_RATED_38] و[ALPHA_PICKS] وأي قائمة Stocks by Quant. إذا وُجد السهم، استخرج درجة Quant من النمط "Rating: <التصنيف><الرقم>" مثل "Strong Buy4.99" → الدرجة هي 4.99 (مقياس 1 إلى 5)، وضعها في grades.Quant. إذا لم يظهر السهم في أيٍّ من هذه القوائم، اترك Quant كـ "N/A" — لا تخمّن.

قاعدة درجات SA: استخدم درجات V/G/P/M/R وQuant من بيانات المحفظة المرفوعة لكل سهم تملكه (موجودة في الملف). لا تكتب N/A لسهم تملكه وله درجات في الملف.

قواعد صارمة للأرقام:
- portfolio_value = القيمة المعطاة أعلاه حرفياً (${totalStr}). ممنوع اختراع أو تعديل هذا الرقم.
- ممنوع منعاً باتاً ذكر أي نسبة أداء أسبوعي (مثل "+4.75%") أو عبارة "هذا الأسبوع" — لا تتوفر بيانات أسبوعية. اترك weekly_performance يصف الوضع نوعياً دون أي رقم اختُرع.
- ممنوع ذكر "بقيادة سهم X" إلا إذا كان مبنياً على وزن المركز الفعلي من البيانات.
- لكل سهم في warnings/strong_positions، انسخ درجات Quant/V/G/P/M/R من قائمة الدرجات أعلاه. ممنوع N/A لأي سهم موجود في القائمة.

أعد JSON صارم فقط — لا نص قبله ولا بعده أبداً:
{"executive_summary":{"portfolio_value":"${totalStr}","weekly_performance":"جملة وصفية نوعية بدون أي نسبة مئوية","biggest_risk_symbol":"SYM","best_opportunity":"SYM","summary_text":"3 جمل: أهم خطر + أهم فرصة + الوضع العام","weekly_decision":"قرار واحد محدد وقابل للتنفيذ"},"warnings":[{"symbol":"SYM","rating":"Strong Sell","badges":["Short Ideas ×N"],"weight":"X%","gl":"+X%","grades":{"Quant":"X.XX","Growth":"X","Momentum":"X","EPS":"X"},"sources":"مصدر","reason":"سبب التحذير: من خفّض التصنيف، من أي تصنيف إلى أي تصنيف، والتاريخ","action":"إجراء محدد بالأرقام"}],"strong_positions":[{"symbol":"SYM","rating":"Strong Buy","badges":["PRO Quant"],"weight":"X%","gl":"+X%","grades":{"Quant":"X.XX"},"sources":"مصادر","reason":"لماذا قوي","action":"احتفظ أو زد"}],"cash_decisions":{"total_available":"${cashStr}","allocations":[{"symbol":"SYM","is_new":true,"amount_usd":"$XX,000","pct_of_cash":"XX%","reason":"سبب التأكيد"}]},"new_opportunities":[{"symbol":"SYM","rating":"Strong Buy","badges":["Top Rated #N"],"grades":{"Quant":"X.XX"},"sources":"N مصادر","reason":"لماذا مناسب","action":"اشترِ"}],"conflicts":[{"symbol":"SYM","sell_sources":"مصدر البيع","buy_sources":"مصدر الشراء","recommendation":"الترجيح"}]}

مهم: أعد JSON كاملاً وصالحاً فقط — بدون أي علامات \`\`\` وبدون نص قبله أو بعده. تأكد من إغلاق كل الأقواس.`;
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

  // ── savePortfolio: parse + save SA portfolio Excel data ──────────
  if (req.body && req.body.savePortfolio && req.body.rows && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/sa-portfolio-${date}.json`;
      const raw = req.body.rows;
      const GRADE_MAP = { 'A+':4.3,'A':4.0,'A-':3.7,'B+':3.3,'B':3.0,'B-':2.7,'C+':2.3,'C':2.0,'C-':1.7,'D+':1.3,'D':1.0,'D-':0.7,'F':0 };
      const labelOf = q => q >= 4.5 ? 'Strong Buy' : q >= 3.5 ? 'Buy' : q >= 2.5 ? 'Hold' : q >= 1.5 ? 'Sell' : 'Strong Sell';
      const stocks = [], etfs = [];
      const numOrNull = v => (v===undefined||v===null||v==='') ? null : (isNaN(Number(v))?v:Number(v));
      const pick = (r, ...keys) => { for(const k of keys){ if(r[k]!==undefined&&r[k]!=='') return r[k]; } return null; };
      for (const r of raw) {
        const sym = r.symbol || r.sym; if(!sym) continue;
        const sheets = r.__sheets || {};
        const full = {}; Object.keys(r).forEach(k=>{ if(k!=='__sheets') full[k]=r[k]; });
        full.sym = String(sym).toUpperCase();
        full.quant       = numOrNull(pick(r,'Quant Rating','quant'));
        full.grades = {
          V: pick(r,'Valuation Grade','valuation','V'),
          G: pick(r,'Growth Grade','growth','G'),
          P: pick(r,'Profitability Grade','profitability','P'),
          M: pick(r,'Momentum Grade','momentum','M'),
          R: pick(r,'EPS Revision Grade','EPS Revisions Grade','eps_revision','R')
        };
        full.shares      = numOrNull(pick(r,'Shares','shares'));
        full.cost        = numOrNull(pick(r,'Cost','Avg Cost','cost'));
        full.value       = numOrNull(pick(r,'Value','Market Value','value'));
        full.weight      = pick(r,'Weight','weight');
        full.days_at_rating = numOrNull(pick(r,'Days at Rating','days_at_rating'));
        full.analysts_covering = numOrNull(pick(r,'# SA Analysts Covering','# Analysts','analysts_covering'));
        full.sheets = {
          dashboard: sheets.dashboard || null,
          holdings:  sheets.holdings  || null,
          short:     sheets.short     || null,
          dividends: sheets.dividends || null,
          ratings:   sheets.ratings   || null,
          summary:   sheets.summary   || null
        };
        const hasGrades = full.grades.V!=null;
        (hasGrades?stocks:etfs).push(full);
      }
      const payload = JSON.stringify({ date, stocks, etfs, saved_at: new Date().toISOString(), count: { stocks: stocks.length, etfs: etfs.length } }, null, 2);
      let sha = null;
      try {
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (ex.ok) sha = (await ex.json()).sha;
      } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' },
        body: JSON.stringify({ message: `SA portfolio ${date}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) })
      });
      return res.status(200).json({ saved: sr.ok ? fp : false, stocks: stocks.length, etfs: etfs.length });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── loadPortfolio: today's portfolio, or carry forward most recent ──
  if (req.body && req.body.loadPortfolio && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => {
        const fp = `data/sa-portfolio-${date}.json`;
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (!ex.ok) return null;
        const f = await ex.json();
        return JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
      };
      let result = await readDay(today);
      if (result) return res.status(200).json({ ...result, isCarryForward: false });
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!dir.ok) return res.status(200).json({ stocks: [], etfs: [] });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : [])
        .map(f => (f.name||'').match(/^sa-portfolio-(\d{4}-\d{2}-\d{2})\.json$/))
        .filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
      if (!dates.length) return res.status(200).json({ stocks: [], etfs: [] });
      const prior = await readDay(dates[0]);
      if (prior) return res.status(200).json({ ...prior, isCarryForward: true });
      return res.status(200).json({ stocks: [], etfs: [] });
    } catch(e) { return res.status(200).json({ stocks: [], etfs: [], error: e.message }); }
  }

  // ── saveRisk: parse the SA "Risks" sheet rows, save data/sa-risk-{date}.json ──
  if (req.body && req.body.saveRisk && req.body.rows && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/sa-risk-${date}.json`;
      const raw = req.body.rows;
      // '-' / '' / null  => null (no data); numbers => Number
      const num = v => {
        if (v===undefined || v===null) return null;
        const s = String(v).trim();
        if (s==='' || s==='-' || s==='—' || s.toLowerCase()==='n/a') return null;
        const n = Number(s.replace(/[$,%\s]/g,''));
        return isNaN(n) ? null : n;
      };
      const pick = (r, ...keys) => { for(const k of keys){ if(r[k]!==undefined&&r[k]!==null&&r[k]!=='') return r[k]; } return null; };
      const symbols = {};
      for (const r of raw) {
        const sym = (r.symbol || r.sym || r.Symbol); if(!sym) continue;
        const S = String(sym).toUpperCase();
        symbols[S] = {
          beta24:    num(pick(r,'24M Beta','beta24','Beta','beta')),
          beta60:    num(pick(r,'60M Beta','beta60')),
          low52:     num(pick(r,'52W Low','low52')),
          high52:    num(pick(r,'52W High','high52')),
          altmanZ:   num(pick(r,'Altman Z Score','Altman Z','altmanZ')),
          volume:    num(pick(r,'Volume','volume')),
          marketCap: num(pick(r,'Market Cap','marketCap')),
          price:     num(pick(r,'Price','price')),
          changePct: num(pick(r,'Change %','changePct'))
        };
      }
      const payload = JSON.stringify({ date, symbols, saved_at: new Date().toISOString(), count: Object.keys(symbols).length }, null, 2);
      let sha = null;
      try {
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (ex.ok) sha = (await ex.json()).sha;
      } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' },
        body: JSON.stringify({ message: `SA risk ${date}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) })
      });
      return res.status(200).json({ saved: sr.ok ? fp : false, count: Object.keys(symbols).length });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── loadRisk: today's risk store, carry forward to most recent prior ──
  if (req.body && req.body.loadRisk && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => {
        const fp = `data/sa-risk-${date}.json`;
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (!ex.ok) return null;
        const f = await ex.json();
        return JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
      };
      let result = await readDay(today);
      if (result) return res.status(200).json({ ...result, isCarryForward: false });
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!dir.ok) return res.status(200).json({ symbols: {} });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : [])
        .map(f => (f.name||'').match(/^sa-risk-(\d{4}-\d{2}-\d{2})\.json$/))
        .filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
      if (!dates.length) return res.status(200).json({ symbols: {} });
      const prior = await readDay(dates[0]);
      if (prior) return res.status(200).json({ ...prior, isCarryForward: true });
      return res.status(200).json({ symbols: {} });
    } catch(e) { return res.status(200).json({ symbols: {}, error: e.message }); }
  }

  // ── saveDividends: parse the SA "Dividends" sheet rows, save data/sa-div-{date}.json ──
  if (req.body && req.body.saveDividends && req.body.rows && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/sa-div-${date}.json`;
      const raw = req.body.rows;
      const num = v => { if(v===undefined||v===null) return null; const s=String(v).trim(); if(s===''||s==='-'||s==='—'||s.toLowerCase()==='n/a') return null; const n=Number(s.replace(/[$,%\s]/g,'')); return isNaN(n)?null:n; };
      const str = v => { if(v===undefined||v===null) return null; const s=String(v).trim(); return (s===''||s==='-'||s==='—')?null:s; };
      const pick = (r, ...keys) => { for(const k of keys){ if(r[k]!==undefined&&r[k]!==null&&r[k]!=='') return r[k]; } return null; };
      const symbols = {};
      for (const r of raw) {
        const sym = (r.symbol || r.sym || r.Symbol); if(!sym) continue;
        const S = String(sym).toUpperCase();
        symbols[S] = {
          yield:       num(pick(r,'Yield FWD','Yield TTM','yieldFwd')),
          yieldTtm:    num(pick(r,'Yield TTM','yieldTtm')),
          yieldGrade:  str(pick(r,'Yield')),
          safety:      str(pick(r,'Safety','safety')),
          growth:      str(pick(r,'Growth','growth')),
          estIncome:   num(pick(r,'Est Annual Income','estIncome')),
          divRateFwd:  num(pick(r,'Div Rate FWD','divRateFwd')),
          frequency:   str(pick(r,'Frequency','frequency')),
          payoutRatio: num(pick(r,'Payout Ratio','payoutRatio')),
          exDiv:       str(pick(r,'Ex-Div Date','exDiv')),
          consecutive: str(pick(r,'Consecutive Years','consecutive'))
        };
      }
      const payload = JSON.stringify({ date, symbols, saved_at: new Date().toISOString(), count: Object.keys(symbols).length }, null, 2);
      let sha = null;
      try { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (ex.ok) sha = (await ex.json()).sha; } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' },
        body: JSON.stringify({ message: `SA dividends ${date}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) })
      });
      return res.status(200).json({ saved: sr.ok ? fp : false, count: Object.keys(symbols).length });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── loadDividends: today's div store, carry forward to most recent prior ──
  if (req.body && req.body.loadDividends && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => {
        const fp = `data/sa-div-${date}.json`;
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (!ex.ok) return null;
        const f = await ex.json();
        return JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
      };
      let result = await readDay(today);
      if (result) return res.status(200).json({ ...result, isCarryForward: false });
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!dir.ok) return res.status(200).json({ symbols: {} });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : [])
        .map(f => (f.name||'').match(/^sa-div-(\d{4}-\d{2}-\d{2})\.json$/))
        .filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
      if (!dates.length) return res.status(200).json({ symbols: {} });
      const prior = await readDay(dates[0]);
      if (prior) return res.status(200).json({ ...prior, isCarryForward: true });
      return res.status(200).json({ symbols: {} });
    } catch(e) { return res.status(200).json({ symbols: {}, error: e.message }); }
  }

  // ── snapshotValue: append/overwrite today's portfolio total in a history file ──
  //    Body: { snapshotValue:true, value:<number>, dayChange:<number|null> }
  //    Idempotent per day (re-running same day overwrites that day's entry).
  if (req.body && req.body.snapshotValue && req.body.value != null && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/portfolio-history.json`;
      const val = Number(req.body.value);
      if (!isFinite(val) || val <= 0) return res.status(200).json({ saved:false, error:'invalid value' });
      const dayChange = (req.body.dayChange!=null && isFinite(Number(req.body.dayChange))) ? Number(req.body.dayChange) : null;
      // read existing history
      let history = [], sha = null;
      try {
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (ex.ok) { const f = await ex.json(); sha = f.sha; const parsed = JSON.parse(Buffer.from(f.content,'base64').toString('utf8')); if (Array.isArray(parsed)) history = parsed; else if (parsed && Array.isArray(parsed.points)) history = parsed.points; }
      } catch {}
      // upsert today
      const idx = history.findIndex(p => p && p.date === date);
      const entry = { date, value: Math.round(val), dayChange: dayChange!=null?Math.round(dayChange):null };
      if (idx >= 0) history[idx] = entry; else history.push(entry);
      history.sort((a,b) => (a.date < b.date ? -1 : 1));
      // cap to last 400 days
      if (history.length > 400) history = history.slice(-400);
      const payload = JSON.stringify({ points: history, updated_at: new Date().toISOString() }, null, 2);
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' },
        body: JSON.stringify({ message: `portfolio snapshot ${date}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) })
      });
      return res.status(200).json({ saved: sr.ok ? fp : false, date, value: entry.value, points: history.length });
    } catch(e) { return res.status(200).json({ saved:false, error: e.message }); }
  }

  // ── loadHistory: return the portfolio value history array ──
  if (req.body && req.body.loadHistory && GITHUB_TOKEN) {
    try {
      const fp = `data/portfolio-history.json`;
      const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!ex.ok) return res.status(200).json({ points: [] });
      const f = await ex.json();
      const parsed = JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
      const points = Array.isArray(parsed) ? parsed : (parsed && parsed.points ? parsed.points : []);
      return res.status(200).json({ points });
    } catch(e) { return res.status(200).json({ points: [], error: e.message }); }
  }

  // ── bucketScore: read the SA portfolio store, run the horizon scorer, save buckets ──
  // Reads today's sa-portfolio-{date}.json (carry-forward to most recent prior if today
  // is missing, same as loadPortfolio), feeds stocks+etfs into computeBuckets (the
  // scorer's own _isETF test does exclusion — not the store's grade-presence split),
  // and writes data/sa-buckets-{date}.json. CODE computes; no Claude here.
  if (req.body && req.body.bucketScore && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => {
        const fp = `data/sa-portfolio-${date}.json`;
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (!ex.ok) return null;
        const f = await ex.json();
        return { store: JSON.parse(Buffer.from(f.content,'base64').toString('utf8')), date };
      };
      // resolve which portfolio store to score (today, else most recent prior)
      let picked = await readDay(today);
      let sourceDate = today, isCarryForward = false;
      if (!picked) {
        const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (!dir.ok) return res.status(200).json({ saved: false, error: 'no portfolio store found' });
        const files = await dir.json();
        const dates = (Array.isArray(files) ? files : [])
          .map(f => (f.name||'').match(/^sa-portfolio-(\d{4}-\d{2}-\d{2})\.json$/))
          .filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
        if (!dates.length) return res.status(200).json({ saved: false, error: 'no portfolio store found' });
        picked = await readDay(dates[0]); sourceDate = dates[0]; isCarryForward = true;
        if (!picked) return res.status(200).json({ saved: false, error: 'portfolio store unreadable' });
      }

      // feed BOTH stocks + etfs; let the scorer's _isETF test decide exclusion
      const all = [].concat(picked.store.stocks||[], picked.store.etfs||[]);
      const { scored, excluded_etfs } = computeBuckets(all);

      // save buckets for TODAY (the run date), noting which store fed it
      const fp = `data/sa-buckets-${today}.json`;
      const payload = JSON.stringify({
        date: today,
        source_portfolio_date: sourceDate,
        isCarryForward,
        scored,
        excluded_etfs,
        count: { scored: Object.keys(scored).length, excluded: excluded_etfs.length },
        generated_at: new Date().toISOString()
      }, null, 2);
      let sha = null;
      try {
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (ex.ok) sha = (await ex.json()).sha;
      } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' },
        body: JSON.stringify({ message: `SA buckets ${today}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) })
      });
      return res.status(200).json({
        saved: sr.ok ? fp : false,
        scored: Object.keys(scored).length,
        excluded: excluded_etfs.length,
        source_portfolio_date: sourceDate,
        isCarryForward
      });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── loadBuckets: return today's buckets, or carry forward most recent prior ──
  if (req.body && req.body.loadBuckets && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const reqDate = (req.body.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) ? req.body.date : null;
      const readDay = async (date) => {
        const fp = `data/sa-buckets-${date}.json`;
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (!ex.ok) return null;
        const f = await ex.json();
        return JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
      };
      // a specific date, else today
      let result = await readDay(reqDate || today);
      if (result) return res.status(200).json({ ...result, isCarryForward: result.isCarryForward || false });
      if (reqDate) return res.status(200).json({ scored: {}, excluded_etfs: [] }); // asked for a specific day, none there
      // fall back: most recent prior buckets file
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!dir.ok) return res.status(200).json({ scored: {}, excluded_etfs: [] });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : [])
        .map(f => (f.name||'').match(/^sa-buckets-(\d{4}-\d{2}-\d{2})\.json$/))
        .filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
      if (!dates.length) return res.status(200).json({ scored: {}, excluded_etfs: [] });
      const prior = await readDay(dates[0]);
      if (prior) return res.status(200).json({ ...prior, isCarryForward: true });
      return res.status(200).json({ scored: {}, excluded_etfs: [] });
    } catch(e) { return res.status(200).json({ scored: {}, excluded_etfs: [], error: e.message }); }
  }

  // ── deepRead: cached AI deep-read for ONE stock.
  // Caching model (Task 4 v2): the read is saved to data/deep-reads-{SYM}.json with a
  // fact fingerprint (grades + archetype + scores + conviction). On open we return the
  // cached read instantly (no AI call). A fresh AI call happens only when:
  //   (a) no cached read exists, OR
  //   (b) forceRefresh AND (24h passed since cached read  OR  facts changed  OR  adminTest), OR
  //   (c) facts changed (auto-allows a refresh).
  // The 24h / facts / admin gate is enforced HERE (server-side) so the client can't spam.
  if (req.body && req.body.deepRead && req.body.symbol && GITHUB_TOKEN) {
    try {
      const sym = String(req.body.symbol).toUpperCase();
      const forceRefresh = !!req.body.forceRefresh;
      const adminTest = !!req.body.adminTest;
      const today = new Date().toISOString().slice(0,10);
      const readJson = async (fp) => {
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (!ex.ok) return null;
        const f = await ex.json();
        return { data: JSON.parse(Buffer.from(f.content,'base64').toString('utf8')), sha: f.sha };
      };

      // resolve buckets (today, else most-recent prior)
      let bucketsWrap = await readJson(`data/sa-buckets-${today}.json`);
      let buckets = bucketsWrap ? bucketsWrap.data : null;
      if (!buckets) {
        const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (dir.ok) {
          const files = await dir.json();
          const dates = (Array.isArray(files)?files:[])
            .map(f => (f.name||'').match(/^sa-buckets-(\d{4}-\d{2}-\d{2})\.json$/))
            .filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
          if (dates.length){ const w = await readJson(`data/sa-buckets-${dates[0]}.json`); buckets = w?w.data:null; }
        }
      }
      if (!buckets || !buckets.scored || !buckets.scored[sym]) {
        return res.status(200).json({ symbol: sym, result: null, error: 'no buckets entry for symbol' });
      }
      const o = buckets.scored[sym];

      // fact fingerprint + a labeled snapshot for human-readable change detection
      const snapshot = {
        grades: o.grades || {},
        archetype: (o.long && o.long.archetype) || null,
        short: o.short ? o.short.score : null,
        mid: o.mid ? o.mid.score : null,
        long: o.long ? o.long.score : null,
        conviction: (o.long && o.long.conviction) ? o.long.conviction.tier : null,
        quant: o.quant != null ? o.quant : null
      };
      const fingerprint = JSON.stringify(snapshot);

      // load any cached read
      const cachePath = `data/deep-reads-${sym}.json`;
      const cachedWrap = await readJson(cachePath);
      const cached = cachedWrap ? cachedWrap.data : null;

      // human-readable diff between cached snapshot and current
      const GLABEL = { V:'التقييم', G:'النمو', P:'الربحية', M:'الزخم', R:'مراجعات الأرباح' };
      const HLABEL = { short:'القصير', mid:'المتوسط', long:'الطويل' };
      function computeChanges(oldSnap, newSnap){
        if (!oldSnap) return [];
        const ch = [];
        for (const k of ['V','G','P','M','R']) {
          const a = (oldSnap.grades||{})[k], b = (newSnap.grades||{})[k];
          if (a !== b) ch.push({ field: GLABEL[k], from: a||'—', to: b||'—' });
        }
        for (const k of ['short','mid','long']) {
          if (oldSnap[k] !== newSnap[k]) ch.push({ field: HLABEL[k], from: oldSnap[k]==null?'—':String(oldSnap[k]), to: newSnap[k]==null?'—':String(newSnap[k]) });
        }
        if (oldSnap.archetype !== newSnap.archetype) ch.push({ field: 'نوع الموقف', from: oldSnap.archetype||'—', to: newSnap.archetype||'—' });
        if (oldSnap.conviction !== newSnap.conviction) ch.push({ field: 'الثقة', from: oldSnap.conviction||'—', to: newSnap.conviction||'—' });
        if (oldSnap.quant !== newSnap.quant) ch.push({ field: 'الكوانت', from: oldSnap.quant==null?'—':String(oldSnap.quant), to: newSnap.quant==null?'—':String(newSnap.quant) });
        return ch;
      }
      const factsChanged = cached ? (cached.fingerprint !== fingerprint) : false;
      const changes = cached ? computeChanges(cached.snapshot, snapshot) : [];

      // 24h check against the cached read's timestamp
      let hoursSince = Infinity;
      if (cached && cached.generated_at) hoursSince = (Date.now() - new Date(cached.generated_at).getTime()) / 3600000;
      const cooldownPassed = hoursSince >= 24;
      const refreshAllowed = adminTest || factsChanged || cooldownPassed;

      // DECISION: serve cache, or generate?
      const mustGenerate = !cached;                              // nothing cached yet
      const wantGenerate = forceRefresh && refreshAllowed;       // user asked + allowed
      if (!mustGenerate && !wantGenerate) {
        // serve cached read; tell the client the refresh state + any changes
        return res.status(200).json({
          symbol: sym, result: cached.text, cached: true,
          generated_at: cached.generated_at,
          factsChanged, changes,
          refreshAllowed, hoursSinceRead: Math.floor(hoursSince),
          nextRefreshInHours: cooldownPassed ? 0 : Math.ceil(24 - hoursSince),
          usage: cached.usage || undefined
        });
      }

      // ---- generate a fresh read ----
      // portfolio store for personal context (today, else most-recent prior)
      let storeWrap = await readJson(`data/sa-portfolio-${today}.json`);
      let store = storeWrap ? storeWrap.data : null;
      if (!store) {
        const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (dir.ok) {
          const files = await dir.json();
          const dates = (Array.isArray(files)?files:[])
            .map(f => (f.name||'').match(/^sa-portfolio-(\d{4}-\d{2}-\d{2})\.json$/))
            .filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
          if (dates.length){ const w = await readJson(`data/sa-portfolio-${dates[0]}.json`); store = w?w.data:null; }
        }
      }
      const allRecs = store ? [].concat(store.stocks||[], store.etfs||[]) : [];
      const prompt = buildDeepReadPrompt(sym, o, allRecs);

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
      });
      const d = await r.json();
      const text = d.content && d.content[0] && d.content[0].text ? d.content[0].text.trim() : null;
      if (!text) {
        // generation failed — fall back to cache if we have one
        if (cached) return res.status(200).json({ symbol: sym, result: cached.text, cached: true, generated_at: cached.generated_at, factsChanged, changes, refreshAllowed, error: 'generation failed, served cache' });
        return res.status(200).json({ symbol: sym, result: null, error: 'generation failed', raw: JSON.stringify(d).slice(0,300) });
      }
      const usage = { input_tokens: d.usage?.input_tokens || 0, output_tokens: d.usage?.output_tokens || 0 };
      usage.est_cost_usd = +((usage.input_tokens/1e6*3) + (usage.output_tokens/1e6*15)).toFixed(4);

      // save the read + fingerprint + snapshot to GitHub
      const payload = JSON.stringify({
        symbol: sym, text, fingerprint, snapshot,
        generated_at: new Date().toISOString(),
        source_buckets_date: buckets.date || null,
        usage
      }, null, 2);
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${cachePath}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' },
        body: JSON.stringify({ message: `Deep read ${sym} ${today}`, content: Buffer.from(payload).toString('base64'), ...(cachedWrap?{sha:cachedWrap.sha}:{}) })
      });

      return res.status(200).json({
        symbol: sym, result: text, cached: false,
        generated_at: new Date().toISOString(),
        saved: sr.ok,
        factsChanged: false, changes: [],
        refreshAllowed: false, hoursSinceRead: 0, nextRefreshInHours: 24,
        usage, prompt_used: prompt
      });
    } catch(e) { return res.status(200).json({ symbol: req.body.symbol, result: null, error: e.message }); }
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
  // Always hydrate the real portfolio from the store (don't trust the client to send it)
  if (inputs && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const fp = `data/sa-portfolio-${today}.json`;
      const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, {
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' }
      });
      if (ex.ok) {
        const f = await ex.json();
        const store = JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
        const all = [].concat(store.stocks||[], store.etfs||[]);
        if (all.length) inputs.excelRows = all;   // override whatever client sent
      }
    } catch (_) {}
  }
  const finalPrompt = inputs ? buildPrompt(inputs) : prompt;
  if (!finalPrompt) return res.status(400).json({ error: 'inputs or prompt required' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 12000, messages: [{ role: 'user', content: finalPrompt }] })
    });
    const d = await r.json();
    if (!d.content?.[0]?.text) return res.status(500).json({ error: 'No response', raw: JSON.stringify(d).slice(0,200) });
    let cleaned = d.content[0].text.trim();
    // strip ```json … ``` or ``` … ``` fences if present
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'').trim();
    return res.status(200).json({
      result: cleaned,
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
