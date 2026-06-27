// api/sa-analyze.js — THEISI SA PRO Intelligence Engine FINAL
// Dashboard sends: saveOnly (inputs only) OR {inputs} for full analysis
// GitHub save happens in saveOnly call. Main call is Claude-only = fast.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const REPO          = 'ralyafei-source/theisilabs-portfolio';

const { computeBuckets } = require('./_lib/bucket-scorer.js');
const { buildDeepReadPrompt } = require('./_lib/deep-read.js');
const { fetchExtrasForSymbol, buildCatalysts, benzingaNews, fmpNews, daysAgoUAE, todayUAE } = require('./_lib/catalysts.js');

function buildPrompt(inputs) {
  const cashUSD = inputs.cashUSD || 0;
  const cashStr = cashUSD > 0 ? '$' + Number(cashUSD).toLocaleString() + ' / ' + Number(inputs.cash||0).toLocaleString() + ' ' + (inputs.currency||'AED') : 'غير محدد';
  const rows = Array.isArray(inputs.excelRows) ? inputs.excelRows : [];
  let totalVal = 0;
  rows.forEach(r => { const v = Number(r.Value || r.value || 0); if(!isNaN(v)) totalVal += v; });
  const totalStr = totalVal > 0 ? '$' + Math.round(totalVal).toLocaleString() : 'غير متوفر';
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

  // ── saveOnly ────────────────────────────────────────────────────────────────
  if (saveOnly && inputs && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/sa-inputs-${date}.json`;
      const fc = JSON.stringify({ date, inputs, savedAt: new Date().toISOString() }, null, 2);
      let sha = null;
      try { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (ex.ok) sha = (await ex.json()).sha; } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' }, body: JSON.stringify({ message: `SA inputs ${date}`, content: Buffer.from(fc).toString('base64'), ...(sha ? { sha } : {}) }) });
      return res.status(200).json({ saved: sr.ok ? fp : false });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── loadInputs ──────────────────────────────────────────────────────────────
  if (req.body && req.body.loadInputs && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => {
        const fp = `data/sa-inputs-${date}.json`;
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (!ex.ok) return null;
        const f = await ex.json();
        const decoded = JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
        return { inputs: decoded.inputs || null, savedAt: decoded.savedAt || null, date };
      };
      let result = await readDay(today);
      if (result && result.inputs) return res.status(200).json({ ...result, isCarryForward: false });
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!dir.ok) return res.status(200).json({ inputs: null });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : []).map(f => (f.name||'').match(/^sa-inputs-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
      if (!dates.length) return res.status(200).json({ inputs: null });
      const prior = await readDay(dates[0]);
      if (prior && prior.inputs) return res.status(200).json({ ...prior, isCarryForward: true });
      return res.status(200).json({ inputs: null });
    } catch(e) { return res.status(200).json({ inputs: null, error: e.message }); }
  }

  // ── saveResult ──────────────────────────────────────────────────────────────
  if (req.body && req.body.saveResult && req.body.result && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/sa-analysis-${date}.json`;
      let runs = [], sha = null;
      try { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (ex.ok) { const f = await ex.json(); sha = f.sha; const prev = JSON.parse(Buffer.from(f.content,'base64').toString('utf8')); runs = Array.isArray(prev.runs) ? prev.runs : []; } } catch {}
      const version = (runs.length ? (runs[runs.length-1].version || runs.length) : 0) + 1;
      runs.push({ version, savedAt: new Date().toISOString(), result: req.body.result });
      if (runs.length > 3) runs = runs.slice(runs.length - 3);
      const body = JSON.stringify({ date, runs }, null, 2);
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' }, body: JSON.stringify({ message: `SA analysis ${date} v${version}`, content: Buffer.from(body).toString('base64'), ...(sha?{sha}:{}) }) });
      return res.status(200).json({ saved: sr.ok, version });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── loadResult ──────────────────────────────────────────────────────────────
  if (req.body && req.body.loadResult && GITHUB_TOKEN) {
    try {
      const date = (req.body.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) ? req.body.date : new Date().toISOString().slice(0,10);
      const fp = `data/sa-analysis-${date}.json`;
      const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!ex.ok) return res.status(200).json({ result: null });
      const f = await ex.json();
      const data = JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
      const runs = Array.isArray(data.runs) ? data.runs : [];
      if (!runs.length) return res.status(200).json({ result: null });
      let run = runs[runs.length-1];
      if (req.body.version != null) { const found = runs.find(r => r.version === req.body.version); if (found) run = found; }
      return res.status(200).json({ result: run.result, savedAt: run.savedAt, version: run.version, count: runs.length, versions: runs.map(r => ({ version: r.version, savedAt: r.savedAt })), date });
    } catch(e) { return res.status(200).json({ result: null, error: e.message }); }
  }

  // ── listAnalyses ────────────────────────────────────────────────────────────
  if (req.body && req.body.listAnalyses && GITHUB_TOKEN) {
    try {
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!dir.ok) return res.status(200).json({ dates: [] });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : []).map(f => (f.name||'').match(/^sa-analysis-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m => m[1]).sort().reverse();
      return res.status(200).json({ dates });
    } catch(e) { return res.status(200).json({ dates: [], error: e.message }); }
  }

  // ── savePortfolio ───────────────────────────────────────────────────────────
  if (req.body && req.body.savePortfolio && req.body.rows && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/sa-portfolio-${date}.json`;
      const raw = req.body.rows;
      const stocks = [], etfs = [];
      const numOrNull = v => (v===undefined||v===null||v==='') ? null : (isNaN(Number(v))?v:Number(v));
      const pick = (r, ...keys) => { for(const k of keys){ if(r[k]!==undefined&&r[k]!=='') return r[k]; } return null; };
      for (const r of raw) {
        const sym = r.symbol || r.sym; if(!sym) continue;
        const sheets = r.__sheets || {};
        const full = {}; Object.keys(r).forEach(k=>{ if(k!=='__sheets') full[k]=r[k]; });
        full.sym = String(sym).toUpperCase();
        full.quant = numOrNull(pick(r,'Quant Rating','quant'));
        full.grades = { V: pick(r,'Valuation Grade','valuation','V'), G: pick(r,'Growth Grade','growth','G'), P: pick(r,'Profitability Grade','profitability','P'), M: pick(r,'Momentum Grade','momentum','M'), R: pick(r,'EPS Revision Grade','EPS Revisions Grade','eps_revision','R') };
        full.shares = numOrNull(pick(r,'Shares','shares'));
        full.cost = numOrNull(pick(r,'Cost','Avg Cost','cost'));
        full.value = numOrNull(pick(r,'Value','Market Value','value'));
        full.weight = pick(r,'Weight','weight');
        full.days_at_rating = numOrNull(pick(r,'Days at Rating','days_at_rating'));
        full.analysts_covering = numOrNull(pick(r,'# SA Analysts Covering','# Analysts','analysts_covering'));
        full.sheets = { dashboard: sheets.dashboard||null, holdings: sheets.holdings||null, short: sheets.short||null, dividends: sheets.dividends||null, ratings: sheets.ratings||null, summary: sheets.summary||null };
        (full.grades.V!=null?stocks:etfs).push(full);
      }
      const payload = JSON.stringify({ date, stocks, etfs, saved_at: new Date().toISOString(), count: { stocks: stocks.length, etfs: etfs.length } }, null, 2);
      let sha = null;
      try { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (ex.ok) sha = (await ex.json()).sha; } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' }, body: JSON.stringify({ message: `SA portfolio ${date}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) }) });
      return res.status(200).json({ saved: sr.ok ? fp : false, stocks: stocks.length, etfs: etfs.length });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── saveUniverse ────────────────────────────────────────────────────────────
  if (req.body && req.body.saveUniverse && req.body.rows && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/sa-universe-${date}.json`;
      const raw = req.body.rows;
      const stocks = [], etfs = [];
      const numOrNull = v => (v===undefined||v===null||v==='') ? null : (isNaN(Number(v))?v:Number(v));
      const pick = (r, ...keys) => { for(const k of keys){ if(r[k]!==undefined&&r[k]!=='') return r[k]; } return null; };
      for (const r of raw) {
        const sym = r.symbol || r.sym; if(!sym) continue;
        const sheets = r.__sheets || {};
        const full = {}; Object.keys(r).forEach(k=>{ if(k!=='__sheets') full[k]=r[k]; });
        full.sym = String(sym).toUpperCase();
        full.quant = numOrNull(pick(r,'Quant Rating','quant'));
        full.grades = { V: pick(r,'Valuation Grade','valuation','V'), G: pick(r,'Growth Grade','growth','G'), P: pick(r,'Profitability Grade','profitability','P'), M: pick(r,'Momentum Grade','momentum','M'), R: pick(r,'EPS Revision Grade','EPS Revisions Grade','eps_revision','R') };
        full.shares = null; full.cost = null; full.value = null; full.weight = null;
        full.days_at_rating = numOrNull(pick(r,'Days at Rating','days_at_rating'));
        full.analysts_covering = numOrNull(pick(r,'# SA Analysts Covering','# Analysts','analysts_covering'));
        full.sheets = { dashboard: sheets.dashboard||null, holdings: sheets.holdings||null, short: sheets.short||null, dividends: sheets.dividends||null, ratings: sheets.ratings||null, summary: sheets.summary||null };
        (full.grades.V!=null?stocks:etfs).push(full);
      }
      const payload = JSON.stringify({ date, stocks, etfs, saved_at: new Date().toISOString(), count: { stocks: stocks.length, etfs: etfs.length } }, null, 2);
      let sha = null;
      try { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (ex.ok) sha = (await ex.json()).sha; } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' }, body: JSON.stringify({ message: `SA universe ${date}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) }) });
      return res.status(200).json({ saved: sr.ok ? fp : false, stocks: stocks.length, etfs: etfs.length });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── loadPortfolio ───────────────────────────────────────────────────────────
  if (req.body && req.body.loadPortfolio && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => { const fp = `data/sa-portfolio-${date}.json`; const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (!ex.ok) return null; const f = await ex.json(); return JSON.parse(Buffer.from(f.content,'base64').toString('utf8')); };
      let result = await readDay(today);
      if (result) return res.status(200).json({ ...result, isCarryForward: false });
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!dir.ok) return res.status(200).json({ stocks: [], etfs: [] });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : []).map(f => (f.name||'').match(/^sa-portfolio-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
      if (!dates.length) return res.status(200).json({ stocks: [], etfs: [] });
      const prior = await readDay(dates[0]);
      if (prior) return res.status(200).json({ ...prior, isCarryForward: true });
      return res.status(200).json({ stocks: [], etfs: [] });
    } catch(e) { return res.status(200).json({ stocks: [], etfs: [], error: e.message }); }
  }

  // ── saveRisk ────────────────────────────────────────────────────────────────
  if (req.body && req.body.saveRisk && req.body.rows && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/sa-risk-${date}.json`;
      const raw = req.body.rows;
      const num = v => { if(v===undefined||v===null) return null; const s=String(v).trim(); if(s===''||s==='-'||s==='—'||s.toLowerCase()==='n/a') return null; const n=Number(s.replace(/[$,%\s]/g,'')); return isNaN(n)?null:n; };
      const pick = (r, ...keys) => { for(const k of keys){ if(r[k]!==undefined&&r[k]!==null&&r[k]!=='') return r[k]; } return null; };
      const symbols = {};
      for (const r of raw) {
        const sym = (r.symbol || r.sym || r.Symbol); if(!sym) continue;
        const S = String(sym).toUpperCase();
        symbols[S] = { beta24: num(pick(r,'24M Beta','beta24','Beta','beta')), beta60: num(pick(r,'60M Beta','beta60')), low52: num(pick(r,'52W Low','low52')), high52: num(pick(r,'52W High','high52')), altmanZ: num(pick(r,'Altman Z Score','Altman Z','altmanZ')), volume: num(pick(r,'Volume','volume')), marketCap: num(pick(r,'Market Cap','marketCap')), price: num(pick(r,'Price','price')), changePct: num(pick(r,'Change %','changePct')) };
      }
      const payload = JSON.stringify({ date, symbols, saved_at: new Date().toISOString(), count: Object.keys(symbols).length }, null, 2);
      let sha = null;
      try { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (ex.ok) sha = (await ex.json()).sha; } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' }, body: JSON.stringify({ message: `SA risk ${date}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) }) });
      return res.status(200).json({ saved: sr.ok ? fp : false, count: Object.keys(symbols).length });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── loadRisk ────────────────────────────────────────────────────────────────
  if (req.body && req.body.loadRisk && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => { const fp = `data/sa-risk-${date}.json`; const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (!ex.ok) return null; const f = await ex.json(); return JSON.parse(Buffer.from(f.content,'base64').toString('utf8')); };
      let result = await readDay(today);
      if (result) return res.status(200).json({ ...result, isCarryForward: false });
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!dir.ok) return res.status(200).json({ symbols: {} });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : []).map(f => (f.name||'').match(/^sa-risk-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
      if (!dates.length) return res.status(200).json({ symbols: {} });
      const prior = await readDay(dates[0]);
      if (prior) return res.status(200).json({ ...prior, isCarryForward: true });
      return res.status(200).json({ symbols: {} });
    } catch(e) { return res.status(200).json({ symbols: {}, error: e.message }); }
  }

  // ── saveDividends ───────────────────────────────────────────────────────────
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
        symbols[S] = { yield: num(pick(r,'Yield FWD','Yield TTM','yieldFwd')), yieldTtm: num(pick(r,'Yield TTM','yieldTtm')), yieldGrade: str(pick(r,'Yield')), safety: str(pick(r,'Safety','safety')), growth: str(pick(r,'Growth','growth')), estIncome: num(pick(r,'Est Annual Income','estIncome')), divRateFwd: num(pick(r,'Div Rate FWD','divRateFwd')), frequency: str(pick(r,'Frequency','frequency')), payoutRatio: num(pick(r,'Payout Ratio','payoutRatio')), exDiv: str(pick(r,'Ex-Div Date','exDiv')), consecutive: str(pick(r,'Consecutive Years','consecutive')) };
      }
      const payload = JSON.stringify({ date, symbols, saved_at: new Date().toISOString(), count: Object.keys(symbols).length }, null, 2);
      let sha = null;
      try { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (ex.ok) sha = (await ex.json()).sha; } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' }, body: JSON.stringify({ message: `SA dividends ${date}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) }) });
      return res.status(200).json({ saved: sr.ok ? fp : false, count: Object.keys(symbols).length });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── loadDividends ───────────────────────────────────────────────────────────
  if (req.body && req.body.loadDividends && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => { const fp = `data/sa-div-${date}.json`; const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (!ex.ok) return null; const f = await ex.json(); return JSON.parse(Buffer.from(f.content,'base64').toString('utf8')); };
      let result = await readDay(today);
      if (result) return res.status(200).json({ ...result, isCarryForward: false });
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!dir.ok) return res.status(200).json({ symbols: {} });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : []).map(f => (f.name||'').match(/^sa-div-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
      if (!dates.length) return res.status(200).json({ symbols: {} });
      const prior = await readDay(dates[0]);
      if (prior) return res.status(200).json({ ...prior, isCarryForward: true });
      return res.status(200).json({ symbols: {} });
    } catch(e) { return res.status(200).json({ symbols: {}, error: e.message }); }
  }

  // ── snapshotValue ───────────────────────────────────────────────────────────
  if (req.body && req.body.snapshotValue && req.body.value != null && GITHUB_TOKEN) {
    try {
      const date = new Date().toISOString().slice(0,10);
      const fp = `data/portfolio-history.json`;
      const val = Number(req.body.value);
      if (!isFinite(val) || val <= 0) return res.status(200).json({ saved:false, error:'invalid value' });
      const dayChange = (req.body.dayChange!=null && isFinite(Number(req.body.dayChange))) ? Number(req.body.dayChange) : null;
      let history = [], sha = null;
      try { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (ex.ok) { const f = await ex.json(); sha = f.sha; const parsed = JSON.parse(Buffer.from(f.content,'base64').toString('utf8')); if (Array.isArray(parsed)) history = parsed; else if (parsed && Array.isArray(parsed.points)) history = parsed.points; } } catch {}
      const idx = history.findIndex(p => p && p.date === date);
      const entry = { date, value: Math.round(val), dayChange: dayChange!=null?Math.round(dayChange):null };
      if (idx >= 0) history[idx] = entry; else history.push(entry);
      history.sort((a,b) => (a.date < b.date ? -1 : 1));
      if (history.length > 400) history = history.slice(-400);
      const payload = JSON.stringify({ points: history, updated_at: new Date().toISOString() }, null, 2);
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' }, body: JSON.stringify({ message: `portfolio snapshot ${date}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) }) });
      return res.status(200).json({ saved: sr.ok ? fp : false, date, value: entry.value, points: history.length });
    } catch(e) { return res.status(200).json({ saved:false, error: e.message }); }
  }

  // ── loadHistory ─────────────────────────────────────────────────────────────
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

  // ── bucketScore ─────────────────────────────────────────────────────────────
  if (req.body && req.body.bucketScore && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => { const fp = `data/sa-portfolio-${date}.json`; const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (!ex.ok) return null; const f = await ex.json(); return { store: JSON.parse(Buffer.from(f.content,'base64').toString('utf8')), date }; };
      let picked = await readDay(today);
      let sourceDate = today, isCarryForward = false;
      if (!picked) {
        const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (!dir.ok) return res.status(200).json({ saved: false, error: 'no portfolio store found' });
        const files = await dir.json();
        const dates = (Array.isArray(files) ? files : []).map(f => (f.name||'').match(/^sa-portfolio-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
        if (!dates.length) return res.status(200).json({ saved: false, error: 'no portfolio store found' });
        picked = await readDay(dates[0]); sourceDate = dates[0]; isCarryForward = true;
        if (!picked) return res.status(200).json({ saved: false, error: 'portfolio store unreadable' });
      }
      const readUniverse = async (date) => { const ufp = `data/sa-universe-${date}.json`; const ux = await fetch(`https://api.github.com/repos/${REPO}/contents/${ufp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (!ux.ok) return null; const uf = await ux.json(); return JSON.parse(Buffer.from(uf.content,'base64').toString('utf8')); };
      let universeStore = await readUniverse(today);
      if (!universeStore) {
        try { const udir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (udir.ok) { const ufiles = await udir.json(); const udates = (Array.isArray(ufiles) ? ufiles : []).map(f => (f.name||'').match(/^sa-universe-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse(); if (udates.length) universeStore = await readUniverse(udates[0]); } } catch {}
      }
      const symOf = r => String((r && (r.sym || r.symbol)) || '').toUpperCase();
      const hasGrades = r => !!(r && r.grades && r.grades.V != null);
      const portfolioRows = [].concat(picked.store.stocks||[], picked.store.etfs||[]);
      const byTicker = {};
      portfolioRows.forEach(r => { const s = symOf(r); if (s) byTicker[s] = r; });
      const universeRows = universeStore ? [].concat(universeStore.stocks||[], universeStore.etfs||[]) : [];
      universeRows.forEach(u => {
        const s = symOf(u); if (!s) return;
        const p = byTicker[s];
        if (!p) { byTicker[s] = u; }
        else if (!hasGrades(p) && hasGrades(u)) { byTicker[s] = Object.assign({}, u, { shares: (p.shares != null ? p.shares : u.shares), cost: (p.cost != null ? p.cost : u.cost), value: (p.value != null ? p.value : u.value), weight: (p.weight != null ? p.weight : u.weight) }); }
      });
      const all = Object.keys(byTicker).map(k => byTicker[k]);
      const { scored, excluded_etfs } = computeBuckets(all);
      const fp = `data/sa-buckets-${today}.json`;
      const payload = JSON.stringify({ date: today, source_portfolio_date: sourceDate, isCarryForward, scored, excluded_etfs, count: { scored: Object.keys(scored).length, excluded: excluded_etfs.length }, generated_at: new Date().toISOString() }, null, 2);
      let sha = null;
      try { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (ex.ok) sha = (await ex.json()).sha; } catch {}
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' }, body: JSON.stringify({ message: `SA buckets ${today}`, content: Buffer.from(payload).toString('base64'), ...(sha ? { sha } : {}) }) });
      return res.status(200).json({ saved: sr.ok ? fp : false, scored: Object.keys(scored).length, excluded: excluded_etfs.length, source_portfolio_date: sourceDate, isCarryForward });
    } catch(e) { return res.status(200).json({ saved: false, error: e.message }); }
  }

  // ── loadBuckets ─────────────────────────────────────────────────────────────
  if (req.body && req.body.loadBuckets && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const reqDate = (req.body.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) ? req.body.date : null;
      const readDay = async (date) => { const fp = `data/sa-buckets-${date}.json`; const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (!ex.ok) return null; const f = await ex.json(); return JSON.parse(Buffer.from(f.content,'base64').toString('utf8')); };
      let result = await readDay(reqDate || today);
      if (result) return res.status(200).json({ ...result, isCarryForward: result.isCarryForward || false });
      if (reqDate) return res.status(200).json({ scored: {}, excluded_etfs: [] });
      const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (!dir.ok) return res.status(200).json({ scored: {}, excluded_etfs: [] });
      const files = await dir.json();
      const dates = (Array.isArray(files) ? files : []).map(f => (f.name||'').match(/^sa-buckets-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
      if (!dates.length) return res.status(200).json({ scored: {}, excluded_etfs: [] });
      const prior = await readDay(dates[0]);
      if (prior) return res.status(200).json({ ...prior, isCarryForward: true });
      return res.status(200).json({ scored: {}, excluded_etfs: [] });
    } catch(e) { return res.status(200).json({ scored: {}, excluded_etfs: [], error: e.message }); }
  }

  // ── deepRead ────────────────────────────────────────────────────────────────
  if (req.body && req.body.deepRead && req.body.symbol && GITHUB_TOKEN) {
    try {
      const sym = String(req.body.symbol).toUpperCase();
      const forceRefresh = !!req.body.forceRefresh;
      const adminTest = !!req.body.adminTest;
      const today = new Date().toISOString().slice(0,10);
      const readJson = async (fp) => { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (!ex.ok) return null; const f = await ex.json(); return { data: JSON.parse(Buffer.from(f.content,'base64').toString('utf8')), sha: f.sha }; };
      let bucketsWrap = await readJson(`data/sa-buckets-${today}.json`);
      let buckets = bucketsWrap ? bucketsWrap.data : null;
      if (!buckets) { const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (dir.ok) { const files = await dir.json(); const dates = (Array.isArray(files)?files:[]).map(f => (f.name||'').match(/^sa-buckets-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse(); if (dates.length){ const w = await readJson(`data/sa-buckets-${dates[0]}.json`); buckets = w?w.data:null; } } }
      if (!buckets || !buckets.scored || !buckets.scored[sym]) return res.status(200).json({ symbol: sym, result: null, error: 'no buckets entry for symbol' });
      const o = buckets.scored[sym];
      const snapshot = { grades: o.grades || {}, archetype: (o.long && o.long.archetype) || null, short: o.short ? o.short.score : null, mid: o.mid ? o.mid.score : null, long: o.long ? o.long.score : null, conviction: (o.long && o.long.conviction) ? o.long.conviction.tier : null, quant: o.quant != null ? o.quant : null };
      const fingerprint = JSON.stringify(snapshot);
      const cachePath = `data/deep-reads-${sym}.json`;
      const cachedWrap = await readJson(cachePath);
      const cached = cachedWrap ? cachedWrap.data : null;
      const GLABEL = { V:'التقييم', G:'النمو', P:'الربحية', M:'الزخم', R:'مراجعات الأرباح' };
      const HLABEL = { short:'القصير', mid:'المتوسط', long:'الطويل' };
      function computeChanges(oldSnap, newSnap){ if (!oldSnap) return []; const ch = []; for (const k of ['V','G','P','M','R']) { const a = (oldSnap.grades||{})[k], b = (newSnap.grades||{})[k]; if (a !== b) ch.push({ field: GLABEL[k], from: a||'—', to: b||'—' }); } for (const k of ['short','mid','long']) { if (oldSnap[k] !== newSnap[k]) ch.push({ field: HLABEL[k], from: oldSnap[k]==null?'—':String(oldSnap[k]), to: newSnap[k]==null?'—':String(newSnap[k]) }); } if (oldSnap.archetype !== newSnap.archetype) ch.push({ field: 'نوع الموقف', from: oldSnap.archetype||'—', to: newSnap.archetype||'—' }); if (oldSnap.conviction !== newSnap.conviction) ch.push({ field: 'الثقة', from: oldSnap.conviction||'—', to: newSnap.conviction||'—' }); if (oldSnap.quant !== newSnap.quant) ch.push({ field: 'الكوانت', from: oldSnap.quant==null?'—':String(oldSnap.quant), to: newSnap.quant==null?'—':String(newSnap.quant) }); return ch; }
      const factsChanged = cached ? (cached.fingerprint !== fingerprint) : false;
      const changes = cached ? computeChanges(cached.snapshot, snapshot) : [];
      let hoursSince = Infinity;
      if (cached && cached.generated_at) hoursSince = (Date.now() - new Date(cached.generated_at).getTime()) / 3600000;
      const cooldownPassed = hoursSince >= 24;
      const refreshAllowed = adminTest || factsChanged || cooldownPassed;
      const mustGenerate = !cached;
      const wantGenerate = forceRefresh && refreshAllowed;
      if (!mustGenerate && !wantGenerate) return res.status(200).json({ symbol: sym, result: cached.text, cached: true, generated_at: cached.generated_at, factsChanged, changes, refreshAllowed, hoursSinceRead: Math.floor(hoursSince), nextRefreshInHours: cooldownPassed ? 0 : Math.ceil(24 - hoursSince), usage: cached.usage || undefined });
      let storeWrap = await readJson(`data/sa-portfolio-${today}.json`);
      let store = storeWrap ? storeWrap.data : null;
      if (!store) { const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } }); if (dir.ok) { const files = await dir.json(); const dates = (Array.isArray(files)?files:[]).map(f => (f.name||'').match(/^sa-portfolio-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse(); if (dates.length){ const w = await readJson(`data/sa-portfolio-${dates[0]}.json`); store = w?w.data:null; } } }
      const allRecs = store ? [].concat(store.stocks||[], store.etfs||[]) : [];
      const trackedSet = new Set(allRecs.map(r => (r.symbol||r.sym)).filter(Boolean));
      const ownedSet = new Set(allRecs.filter(r => { const sh = r.shares ?? ((r.sheets&&r.sheets.holdings)||{})['Shares']; return Number(sh) > 0; }).map(r => (r.symbol||r.sym)));
      let extras = null;
      try { extras = await fetchExtrasForSymbol(sym, trackedSet, ownedSet); } catch { extras = null; }
      const promptText = buildDeepReadPrompt(sym, o, allRecs, extras);
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: promptText }] }) });
      const d = await r.json();
      const text = d.content && d.content[0] && d.content[0].text ? d.content[0].text.trim() : null;
      if (!text) { if (cached) return res.status(200).json({ symbol: sym, result: cached.text, cached: true, generated_at: cached.generated_at, factsChanged, changes, refreshAllowed, error: 'generation failed, served cache' }); return res.status(200).json({ symbol: sym, result: null, error: 'generation failed', raw: JSON.stringify(d).slice(0,300) }); }
      const usage = { input_tokens: d.usage?.input_tokens || 0, output_tokens: d.usage?.output_tokens || 0 };
      usage.est_cost_usd = +((usage.input_tokens/1e6*3) + (usage.output_tokens/1e6*15)).toFixed(4);
      const savePayload = JSON.stringify({ symbol: sym, text, fingerprint, snapshot, generated_at: new Date().toISOString(), source_buckets_date: buckets.date || null, usage }, null, 2);
      const sr = await fetch(`https://api.github.com/repos/${REPO}/contents/${cachePath}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'theisi' }, body: JSON.stringify({ message: `Deep read ${sym} ${today}`, content: Buffer.from(savePayload).toString('base64'), ...(cachedWrap?{sha:cachedWrap.sha}:{}) }) });
      return res.status(200).json({ symbol: sym, result: text, cached: false, generated_at: new Date().toISOString(), saved: sr.ok, factsChanged: false, changes: [], refreshAllowed: false, hoursSinceRead: 0, nextRefreshInHours: 24, usage, prompt_used: promptText });
    } catch(e) { return res.status(200).json({ symbol: req.body.symbol, result: null, error: e.message }); }
  }

  // ── newsFeed ────────────────────────────────────────────────────────────────
  if (req.body && req.body.newsFeed && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const readDay = async (date) => { const fp = `data/sa-buckets-${date}.json`; const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers:{ 'Authorization':`token ${GITHUB_TOKEN}`,'User-Agent':'theisi' } }); if(!ex.ok) return null; return JSON.parse(Buffer.from((await ex.json()).content,'base64').toString('utf8')); };
      let b = await readDay(today);
      if(!b){ const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers:{ 'Authorization':`token ${GITHUB_TOKEN}`,'User-Agent':'theisi' } }); if(dir.ok){ const files=await dir.json(); const dates=(Array.isArray(files)?files:[]).map(f=>(f.name||'').match(/^sa-buckets-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m=>m[1]).filter(d=>d<today).sort().reverse(); if(dates.length) b=await readDay(dates[0]); } }
      const scored = (b && b.scored) || {};
      const syms = Object.keys(scored).slice(0, 30);
      const from = daysAgoUAE(7);
      const results = await Promise.all(syms.map(async sym => { const news = await benzingaNews(sym, from); return news.map(n => ({ sym, title: n.title, date: n.date })); }));
      const items = results.flat().sort((a,b)=>(b.date<a.date?-1:1)).slice(0, 25);
      return res.status(200).json({ date: today, items });
    } catch(e){ return res.status(200).json({ date:new Date().toISOString().slice(0,10), items:[], error:e.message }); }
  }

  // ── dailyRead ───────────────────────────────────────────────────────────────
  if (req.body && req.body.dailyRead && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const cachePath = `data/daily-brief.json`;
      const readJson = async (fp) => { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers:{ 'Authorization':`token ${GITHUB_TOKEN}`,'User-Agent':'theisi' } }); if(!ex.ok) return null; const f = await ex.json(); return { data: JSON.parse(Buffer.from(f.content,'base64').toString('utf8')), sha: f.sha }; };
      const cachedWrap = await readJson(cachePath);
      if (cachedWrap && cachedWrap.data && !req.body.forceRefresh) return res.status(200).json({ ...cachedWrap.data, cached:true });
      const readBuckets = async (date) => { const w = await readJson(`data/sa-buckets-${date}.json`); return w ? w.data : null; };
      let buckets = await readBuckets(today);
      if(!buckets){ const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers:{ 'Authorization':`token ${GITHUB_TOKEN}`,'User-Agent':'theisi' } }); if(dir.ok){ const files=await dir.json(); const dates=(Array.isArray(files)?files:[]).map(f=>(f.name||'').match(/^sa-buckets-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m=>m[1]).filter(d=>d<today).sort().reverse(); if(dates.length) buckets=await readBuckets(dates[0]); } }
      const scored = (buckets && buckets.scored) || {};
      if (!Object.keys(scored).length) return res.status(200).json({ date:today, brief:'لا توجد بيانات محفظة بعد.', detail:'', generated_at:new Date().toISOString() });
      const ownedSet = new Set(Object.keys(scored).filter(s => scored[s].owned));
      const trackedSet = new Set(Object.keys(scored));
      const ownedByLong = Object.keys(scored).filter(s => scored[s].owned && scored[s].long && scored[s].long.score!=null).sort((a,b)=>scored[b].long.score-scored[a].long.score);
      const strongest = ownedByLong.slice(0,2);
      const weakest = ownedByLong.slice(-2).filter(s => !strongest.includes(s));
      const symbols = Object.keys(scored);
      const [pastEarnings, gradeArrays] = await Promise.all([
        fetch(`https://financialmodelingprep.com/stable/earnings-calendar?from=${daysAgoUAE(14)}&to=${today}&symbol=${symbols.join(',')}&apikey=${process.env.FMP_API_KEY||process.env.FMP_KEY}`).then(r=>r.ok?r.json():[]).catch(()=>[]),
        Promise.all(symbols.map(s => fetch(`https://financialmodelingprep.com/stable/grades?symbol=${s}&limit=3&apikey=${process.env.FMP_API_KEY||process.env.FMP_KEY}`).then(r=>r.ok?r.json():null).catch(()=>null)))
      ]);
      const grades = gradeArrays.flat().filter(Boolean);
      const catMap = buildCatalysts(pastEarnings, grades, trackedSet, ownedSet);
      const changes = [];
      Object.entries(catMap).forEach(([sym,arr]) => arr.forEach(c => changes.push({ sym, type:c.type, detail:c.detail, age:c.age_days, held:c.owned })));
      changes.sort((a,b)=>a.age-b.age);
      const catSyms = Object.keys(catMap);
      const newsByStock = {};
      await Promise.all(catSyms.slice(0,8).map(async sym => { const n = await benzingaNews(sym, daysAgoUAE(14)); if(n.length) newsByStock[sym] = n.map(x=>x.title); }));

      // ── Big movers: daily (>=5%) AND 5-day drift (>=5%) ─────────────────────
      const FMP_K = process.env.FMP_API_KEY || process.env.FMP_KEY || 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
      let bigMoves = [];
      const moveMap = {}; // sym -> { sym, daily, fiveDay, price, held }
      try {
        // 1) daily moves from live quote
        const quoteRes = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${symbols.join(',')}&apikey=${FMP_K}`, { headers:{ 'User-Agent':'theisi' } });
        if (quoteRes.ok) {
          const quotes = await quoteRes.json();
          (Array.isArray(quotes)?quotes:[]).forEach(qq => {
            const chg = qq && qq.changesPercentage != null ? parseFloat(qq.changesPercentage) : null;
            if (qq && qq.symbol) moveMap[qq.symbol] = { sym: qq.symbol, daily: (chg!=null?+chg.toFixed(2):null), fiveDay: null, price: qq.price, held: ownedSet.has(qq.symbol) };
          });
        }
        // 2) 5-day drift: compare latest close vs close ~5 trading days ago
        await Promise.all(symbols.map(async sym => {
          try {
            const hr = await fetch(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${sym}&apikey=${FMP_K}`, { headers:{ 'User-Agent':'theisi' } });
            if (!hr.ok) return;
            const hd = await hr.json();
            const arr = Array.isArray(hd) ? hd : (hd.historical || []);
            if (arr.length < 6) return;
            const latest = arr[0].close ?? arr[0].price;
            const fiveAgo = arr[5].close ?? arr[5].price;
            if (latest && fiveAgo) {
              const pct = +(((latest - fiveAgo) / fiveAgo) * 100).toFixed(2);
              if (!moveMap[sym]) moveMap[sym] = { sym, daily: null, fiveDay: pct, price: latest, held: ownedSet.has(sym) };
              else moveMap[sym].fiveDay = pct;
            }
          } catch {}
        }));
        // keep symbols where daily >=5% OR 5-day >=5%
        Object.values(moveMap).forEach(m => {
          const dBig = m.daily != null && Math.abs(m.daily) >= 5;
          const fBig = m.fiveDay != null && Math.abs(m.fiveDay) >= 5;
          if (dBig || fBig) bigMoves.push(m);
        });
        // sort by the larger of the two magnitudes
        bigMoves.sort((a,b) => Math.max(Math.abs(b.daily||0),Math.abs(b.fiveDay||0)) - Math.max(Math.abs(a.daily||0),Math.abs(a.fiveDay||0)));
        bigMoves = bigMoves.slice(0,8);
      } catch {}
      // pull news for big movers that don't already have catalyst news (the "why")
      await Promise.all(bigMoves.map(async m => {
        if (!newsByStock[m.sym]) { const n = await benzingaNews(m.sym, daysAgoUAE(7)); if(n.length) newsByStock[m.sym] = n.map(x=>x.title); }
      }));

      const G = s => scored[s] ? scored[s].grades : {};
      const payload = { posture: { strongest: strongest.map(s=>({sym:s, long:scored[s].long.score, grades:G(s)})), weakest: weakest.map(s=>({sym:s, long:scored[s].long.score, grades:G(s)})), owned_count: ownedSet.size }, changes: changes.slice(0,8), big_moves: bigMoves, news: newsByStock };
      const prompt = `أنت تكتب «موجز المحفظة» اليومي لمستثمر إماراتي (لا ضريبة) بالخليجية الودّية — صديق ذكي، مو تقرير بنكي. ممنوع الفصحى المتكلّفة.\n\nقواعد صارمة:\n- اشرح، لا توصِ. ممنوع «اشترِ/بِع». ممنوع تخترع أرقاماً أو أهدافاً أو نسباً.\n- الدرجات والنقاط (٠–١٠٠) قراءات ترتيبية — مو نسب ولا عوائد. أعد ذكرها لا تعِد تفسيرها.\n- استخدم الأخبار لتفسير «لماذا» حدث محفّز أو حركة سعرية كبيرة. لا تكرّر أي توقّع ورد في الخبر.\n- في حقل big_moves أسهم تحرّكت بقوة: daily = حركة اليوم، fiveDay = حركة آخر ٥ أيام (±5% أو أكثر). اذكر أبرزها مع التمييز بين حركة يوم واحد وانزلاق تدريجي خلال ٥ أيام، وفسّر السبب من الأخبار إن توفّر. إذا لم تجد في الأخبار ما يفسّر الحركة، اكتب بالضبط: «من دون محفّز إخباري واضح» — ولا تخترع سبباً.\n- إذا تعارض محفّز مع الدرجات، وضّح التعارض بصراحة.\n- رموز الأسهم بالإنجليزي. الانتقالات بالعربي (من X إلى Y).\n- نص عادي فقط، بدون ماركداون.\n- تنسيق detail: كل فكرة أو سهم مستقل في سطر منفصل (افصل بـ \\n). إذا كانت عدة أفكار مترابطة في تحليل واحد متصل اكتبها كفقرة متّصلة. لا تجعل كل شيء كتلة واحدة.\n\nأعد JSON صارم فقط:\n{"brief":"٢-٣ جمل: وضع المحفظة العام (الأقوى/الأضعف) ثم أبرز ما تغيّر","detail":"٤ إلى ١٢ جملة حسب أهمية ما حدث فعلاً (لا تملأ بجمل زائدة)، مع وضع كل فكرة أو سهم في سطر منفصل بـ \\n: تفصيل المحفّزات والحركات السعرية الكبيرة (±5%) بأسبابها من الأخبار، والتعارضات إن وُجدت. إذا كان اليوم هادئاً اكتب أقل.","posture_line":"جملة واحدة تلخّص الوضع"}\n\nالبيانات:\n${JSON.stringify(payload)}`;
      const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{ 'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01' }, body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:2200, messages:[{role:'user',content:prompt}] }) });
      const d = await r.json();
      let txt = (d.content||[]).map(c=>c.type==='text'?c.text:'').join('').trim().replace(/```json|```/g,'').trim();
      let parsed; try { parsed = JSON.parse(txt); } catch { parsed = { brief: txt.slice(0,400), detail:'', posture_line:'' }; }
      const out = { date: today, brief: parsed.brief || '', detail: parsed.detail || '', posture_line: parsed.posture_line || '', change_count: changes.length, generated_at: new Date().toISOString() };
      try { await fetch(`https://api.github.com/repos/${REPO}/contents/${cachePath}`, { method:'PUT', headers:{ 'Authorization':`token ${GITHUB_TOKEN}`,'Content-Type':'application/json','User-Agent':'theisi' }, body: JSON.stringify({ message:`daily brief ${out.generated_at}`, content:Buffer.from(JSON.stringify(out,null,2)).toString('base64'), ...(cachedWrap?{sha:cachedWrap.sha}:{}) }) }); } catch {}
      return res.status(200).json({ ...out, cached:false });
    } catch(e){ return res.status(500).json({ error:e.message }); }
  }

  // ── themedNews ──────────────────────────────────────────────────────────────
  if (req.body && req.body.themedNews && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const cachePath = `data/themed-news.json`;
      const readJson = async (fp) => { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers:{ 'Authorization':`token ${GITHUB_TOKEN}`,'User-Agent':'theisi' } }); if(!ex.ok) return null; const f = await ex.json(); return { data: JSON.parse(Buffer.from(f.content,'base64').toString('utf8')), sha: f.sha }; };
      const cachedWrap = await readJson(cachePath);
      if (cachedWrap && cachedWrap.data && cachedWrap.data.date===today && !req.body.forceRefresh) return res.status(200).json({ ...cachedWrap.data, cached:true });
      const readBuckets = async (date) => { const w = await readJson(`data/sa-buckets-${date}.json`); return w?w.data:null; };
      let buckets = await readBuckets(today);
      if(!buckets){ const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers:{ 'Authorization':`token ${GITHUB_TOKEN}`,'User-Agent':'theisi' } }); if(dir.ok){ const files=await dir.json(); const dates=(Array.isArray(files)?files:[]).map(f=>(f.name||'').match(/^sa-buckets-(\d{4}-\d{2}-\d{2})\.json$/)).filter(Boolean).map(m=>m[1]).filter(d=>d<today).sort().reverse(); if(dates.length) buckets=await readBuckets(dates[0]); } }
      const symbols = buckets && buckets.scored ? Object.keys(buckets.scored) : [];
      if (!symbols.length) return res.status(200).json({ date:today, themes:[], note:'no symbols' });
      const news = await fmpNews(symbols, 60);
      if (!news.length) { const out = { date:today, themes:[], generated_at:new Date().toISOString() }; return res.status(200).json({ ...out, cached:false }); }
      const payloadIdx = news.slice(0, 40).map((n,i) => ({ i, t: n.title, s: (n.text||'').slice(0,300), sym: n.sym, d: n.date }));
      const prompt = `أنت محرّر أخبار THEISI. عندك عناوين ومقتطفات أخبار حديثة تمسّ أسهم محفظة مستثمر إماراتي.\nمهمتك: اجمع الأخبار في ٣-٥ مواضيع (themes) واضحة. لكل موضوع اكتب ملخّصين بالعربية الخليجية الودّية (مو فصحى متكلّفة):\n- "summary": جملة واحدة قصيرة تلخّص الموضوع.\n- "detail": ٤-٧ جمل تشرح مضمون الأخبار في الموضوع.\n\nقواعد صارمة:\n- اشرح ما يحدث، لا توصِ. ممنوع «اشترِ/بِع».\n- رموز الأسهم بالإنجليزي كما هي.\n- لا تكرّر نفس الموضوع. ادمج الأخبار المتشابهة.\n- نص عادي، بدون ماركداون.\n\nأعد JSON صارم فقط:\n{"themes":[{"summary":"جملة قصيرة","detail":"٤-٧ جمل","tickers":["SYM1","SYM2"]}]}\n\nالأخبار:\n${JSON.stringify(payloadIdx)}`;
      const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{ 'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01' }, body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:4500, messages:[{role:'user',content:prompt}] }) });
      const d = await r.json();
      let txt = (d.content||[]).map(c=>c.type==='text'?c.text:'').join('').trim().replace(/```json|```/g,'').trim();
      let parsed; try { parsed = JSON.parse(txt); } catch { parsed = { themes:[] }; }
      let themes = Array.isArray(parsed.themes) ? parsed.themes.slice(0,6) : [];
      themes = themes.map(th => ({ summary: th.summary || '', detail: th.detail || '', tickers: th.tickers || [] }));
      const out = { date:today, themes, generated_at:new Date().toISOString() };
      try { await fetch(`https://api.github.com/repos/${REPO}/contents/${cachePath}`, { method:'PUT', headers:{ 'Authorization':`token ${GITHUB_TOKEN}`,'Content-Type':'application/json','User-Agent':'theisi' }, body: JSON.stringify({ message:`themed news ${out.generated_at}`, content:Buffer.from(JSON.stringify(out,null,2)).toString('base64'), ...(cachedWrap?{sha:cachedWrap.sha}:{}) }) }); } catch {}
      return res.status(200).json({ ...out, cached:false });
    } catch(e){ return res.status(500).json({ error:e.message }); }
  }

  // ── marketRead ──────────────────────────────────────────────────────────────
  if (req.body && req.body.marketRead) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const cachePath = `data/market-read.json`;
      const MR_ANTHROPIC = process.env.ANTHROPIC_API_KEY || '';
      const readJson = async (fp) => { if (!GITHUB_TOKEN) return null; try { const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers:{ 'Authorization':`token ${GITHUB_TOKEN}`,'User-Agent':'theisi' } }); if(!ex.ok) return null; const f = await ex.json(); return { data: JSON.parse(Buffer.from(f.content,'base64').toString('utf8')), sha: f.sha }; } catch { return null; } };
      const cachedWrap = await readJson(cachePath);
      if (!req.body.forceRefresh && cachedWrap && cachedWrap.data && cachedWrap.data.date === today) return res.status(200).json({ ...cachedWrap.data, cached:true });

      // Use Claude with web_search to fetch live market data + generate report in one call
      const systemPrompt = `أنت محرر بيانات مالية دقيق ومحلل سوق خبير. مهمتك:
1. ابحث في الويب عن أحدث بيانات إغلاق الأسواق الأمريكية. إذا كان اليوم عطلة نهاية أسبوع أو عطلة رسمية، استخدم آخر يوم تداول متاح تلقائياً دون اعتذار أو تنبيه.
2. اجمع: أسعار S&P 500 و Nasdaq Composite و Dow Jones مع نسب التغير اليومي والأسبوعي، وأداء القطاعات، وأبرز الأخبار والمحفزات.
3. حوّل هذه البيانات إلى تقرير سوقي يومي بالعربية الفصحى.

قواعد صارمة:
- رموز المؤشرات والأسهم والأرقام والنسب المئوية تُكتب بالإنجليزية كما هي داخل النص العربي.
- استخدم الأرقام الفعلية من البحث بالضبط.
- لا تخترع أرقاماً.
- ممنوع منعاً باتاً كتابة أي اعتذار أو تمهيد أو ملاحظة خارج JSON.
- ممنوع استخدام علامات الاقتباس المرجعية أو أرقام المصادر داخل النص.
- أعد JSON خام فقط — لا تضعه داخل علامات code fence ولا تكتب أي شيء قبله أو بعده.

أعد هذا الـ JSON فقط:
{
  "brief": "جملتان: الأولى تصف حالة السوق بالأرقام الدقيقة، الثانية أبرز محرّك أو قطاع اليوم",
  "detail": "📊 الصورة الكلية\n[4 جمل: الزخم بالأرقام، المحرّكات، أداء القطاعات، والمخاطر أو الفرص]\n\n📉 الأرقام\n• S&P 500 — [السعر الدقيق] | [% اليومي] (يومي) | [% الأسبوعي] (أسبوعي)\n• Nasdaq Composite — [السعر الدقيق] | [% اليومي] (يومي) | [% الأسبوعي] (أسبوعي)\n• Dow Jones Industrial Average — [السعر الدقيق] | [% اليومي] (يومي) | [% الأسبوعي] (أسبوعي)\n\n⚡ المحفزات والتباين القطاعي\n[3 جمل: المحفز الرئيسي، التباين بين القطاعات، أبرز حركة في الأخبار]"
}`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key': MR_ANTHROPIC, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 3000,
          system: systemPrompt,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role:'user', content:`ابحث عن بيانات إغلاق الأسواق الأمريكية ليوم ${today} وأعد التقرير بالتنسيق المطلوب.` }]
        })
      });

      const cd = await claudeRes.json();
      // extract text from content blocks (skip tool_use blocks)
      let txt = (cd.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('').trim()
        .replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();

      // if response has tool_use but no final text, do a follow-up turn
      if (!txt && (cd.content||[]).some(c=>c.type==='tool_use')) {
        const toolResults = (cd.content||[]).filter(c=>c.type==='tool_result'||(c.type==='tool_use')).map(c=>({
          type:'tool_result', tool_use_id: c.id, content: c.content||''
        }));
        const followUp = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST',
          headers:{ 'Content-Type':'application/json','x-api-key':MR_ANTHROPIC,'anthropic-version':'2023-06-01' },
          body: JSON.stringify({
            model:'claude-haiku-4-5-20251001', max_tokens:2000,
            system: systemPrompt,
            tools:[{type:'web_search_20250305',name:'web_search'}],
            messages:[
              {role:'user',content:`ابحث عن بيانات إغلاق الأسواق الأمريكية ليوم ${today} وأعد التقرير بالتنسيق المطلوب.`},
              {role:'assistant',content:cd.content},
              {role:'user',content:'الآن أعد JSON النهائي فقط بناءً على نتائج البحث.'}
            ]
          })
        });
        const fd = await followUp.json();
        txt = (fd.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('').trim()
          .replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();
      }

      // Strip cite tags, extract JSON even if wrapped in preamble/code-fence
      const stripCites = s => String(s||'').replace(/<\/?cite[^>]*>/g,'').replace(/\[\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*\]/g,'').trim();
      const extractJson = (s) => {
        if (!s) return null;
        // prefer a ```json ... ``` block if present
        const fence = s.match(/```json\s*([\s\S]*?)```/);
        let candidate = fence ? fence[1] : s;
        const a = candidate.indexOf('{'), b = candidate.lastIndexOf('}');
        if (a === -1 || b <= a) return null;
        try { return JSON.parse(candidate.slice(a, b+1)); } catch { return null; }
      };
      let parsed = extractJson(txt);
      if (!parsed) { try { parsed = JSON.parse(txt); } catch { parsed = { brief: stripCites(txt).slice(0,300), detail: stripCites(txt) }; } }
      const out = { date:today, brief:stripCites(parsed.brief)||'', detail:stripCites(parsed.detail)||'', generated_at:new Date().toISOString() };

      // save cache
      try { if (GITHUB_TOKEN) { await fetch(`https://api.github.com/repos/${REPO}/contents/${cachePath}`, { method:'PUT', headers:{ 'Authorization':`token ${GITHUB_TOKEN}`,'Content-Type':'application/json','User-Agent':'theisi' }, body: JSON.stringify({ message:`market read ${out.generated_at}`, content: Buffer.from(JSON.stringify(out,null,2)).toString('base64'), ...(cachedWrap ? { sha:cachedWrap.sha } : {}) }) }); } } catch {}
      return res.status(200).json({ ...out, cached:false });
    } catch(e){ return res.status(500).json({ error:e.message }); }
  }

    // ── Main Analysis ───────────────────────────────────────────────────────────
  if (inputs && GITHUB_TOKEN) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const fp = `data/sa-portfolio-${today}.json`;
      const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
      if (ex.ok) { const f = await ex.json(); const store = JSON.parse(Buffer.from(f.content,'base64').toString('utf8')); const all = [].concat(store.stocks||[], store.etfs||[]); if (all.length) inputs.excelRows = all; }
    } catch (_) {}
  }
  const finalPrompt = inputs ? buildPrompt(inputs) : prompt;
  if (!finalPrompt) return res.status(400).json({ error: 'inputs or prompt required' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 12000, messages: [{ role: 'user', content: finalPrompt }] }) });
    const d = await r.json();
    if (!d.content?.[0]?.text) return res.status(500).json({ error: 'No response', raw: JSON.stringify(d).slice(0,200) });
    let cleaned = d.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'').trim();
    return res.status(200).json({ result: cleaned, usage: { input_tokens: d.usage?.input_tokens||0, output_tokens: d.usage?.output_tokens||0, total_tokens: (d.usage?.input_tokens||0)+(d.usage?.output_tokens||0), input_cost: ((d.usage?.input_tokens||0)/1000000*3).toFixed(4), output_cost: ((d.usage?.output_tokens||0)/1000000*15).toFixed(4), total_cost: (((d.usage?.input_tokens||0)/1000000*3)+((d.usage?.output_tokens||0)/1000000*15)).toFixed(4) } });
  } catch(e) { return res.status(500).json({ error: e.message }); }
};
