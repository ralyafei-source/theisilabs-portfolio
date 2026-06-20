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

  // ── deepRead: build the AI deep-read for ONE stock and return it to the caller.
  // CONSOLE-ONLY by design (Task 4): nothing is saved, nothing is shown in-app.
  // The on-tap UI stays disabled behind a default-off flag until Rashed reviews a
  // real sample. Reads today's buckets (carry-forward) for the stock's resolved
  // facts + the portfolio store for personal context, builds the prompt, calls
  // Claude, returns { symbol, prompt_used, result }. On any failure the tab falls
  // back to the templated card summary (graceful degradation).
  if (req.body && req.body.deepRead && req.body.symbol && GITHUB_TOKEN) {
    try {
      const sym = String(req.body.symbol).toUpperCase();
      const today = new Date().toISOString().slice(0,10);
      const readJson = async (fp) => {
        const ex = await fetch(`https://api.github.com/repos/${REPO}/contents/${fp}`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (!ex.ok) return null;
        const f = await ex.json();
        return JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
      };
      // resolve buckets (today, else most-recent prior)
      let buckets = await readJson(`data/sa-buckets-${today}.json`);
      if (!buckets) {
        const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (dir.ok) {
          const files = await dir.json();
          const dates = (Array.isArray(files)?files:[])
            .map(f => (f.name||'').match(/^sa-buckets-(\d{4}-\d{2}-\d{2})\.json$/))
            .filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
          if (dates.length) buckets = await readJson(`data/sa-buckets-${dates[0]}.json`);
        }
      }
      if (!buckets || !buckets.scored || !buckets.scored[sym]) {
        return res.status(200).json({ symbol: sym, result: null, error: 'no buckets entry for symbol' });
      }
      // load the portfolio store for personal context (today, else most-recent prior)
      let store = await readJson(`data/sa-portfolio-${today}.json`);
      if (!store) {
        const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/data`, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisi' } });
        if (dir.ok) {
          const files = await dir.json();
          const dates = (Array.isArray(files)?files:[])
            .map(f => (f.name||'').match(/^sa-portfolio-(\d{4}-\d{2}-\d{2})\.json$/))
            .filter(Boolean).map(m => m[1]).filter(dt => dt < today).sort().reverse();
          if (dates.length) store = await readJson(`data/sa-portfolio-${dates[0]}.json`);
        }
      }
      const allRecs = store ? [].concat(store.stocks||[], store.etfs||[]) : [];

      const prompt = buildDeepReadPrompt(sym, buckets.scored[sym], allRecs);

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
      });
      const d = await r.json();
      const text = d.content && d.content[0] && d.content[0].text ? d.content[0].text.trim() : null;
      return res.status(200).json({
        symbol: sym,
        result: text,
        prompt_used: prompt,                 // returned so Rashed can audit the exact prompt
        source_buckets_date: buckets.date || null,
        usage: text ? {
          input_tokens: d.usage?.input_tokens || 0,
          output_tokens: d.usage?.output_tokens || 0
        } : undefined,
        raw: text ? undefined : JSON.stringify(d).slice(0,300)
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
