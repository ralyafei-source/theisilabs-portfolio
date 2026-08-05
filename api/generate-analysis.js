// api/generate-analysis.js — v2 (SA-grade prompts, explain-only, multi-user)
// Types: weekly | monthly  (daily removed — Morning Brief covers it)
// Golden separation: Claude NEVER computes scores. Grades come from SA; numbers from data.

const REPO = 'ralyafei-source/theisilabs-portfolio';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const API_KEY = process.env.BRIEFING_API_KEY;

async function ghRead(path, asText) {
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`);
  if (!r.ok) return null;
  try { return asText ? await r.text() : await r.json(); } catch (e) { return null; }
}

async function ghWrite(path, data) {
  const check = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app' } });
  let sha = null;
  if (check.ok) { const ex = await check.json(); sha = ex.sha; }
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Generate ${path}`, content, ...(sha && { sha }) })
  });
  return r.ok;
}

async function verifyAccess(sessionToken) {
  if (!sessionToken) return null;
  const usersData = await ghRead('data/users.json');
  if (!usersData) return null;
  const list = Array.isArray(usersData) ? usersData : (usersData.users || []);

  const user = list.find(u =>
    (u.sessions || []).some(s => s.sessionToken === sessionToken)
  );
  if (!user) return null;

  const session = user.sessions.find(s => s.sessionToken === sessionToken);
  if (new Date(session.sessionExpiry) < new Date()) return null;

  return user;
}

// ── Find latest SA ratings file (walk back up to 30 days) ──────────────────
async function loadLatestSA() {
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.now() + 4 * 3600 * 1000 - i * 86400000).toISOString().slice(0, 10);
    const data = await ghRead(`data/sa-portfolio-${d}.json`);
    if (data) return { data, date: d };
  }
  return { data: null, date: null };
}



// ═══ v3 WEEKLY — deterministic signals, structured JSON output ═══
const FMP_KEY = process.env.FMP_API_KEY || process.env.FMP_KEY || '';

async function fetchTargets(symbols){
  const out={};
  if(!FMP_KEY) return out;
  const list=symbols.slice(0,25);
  await Promise.all(list.map(async sym=>{
    try{
      const r=await fetch(`https://financialmodelingprep.com/stable/price-target-consensus?symbol=${sym}&apikey=${FMP_KEY}`);
      if(r.ok){ const d=await r.json(); const row=Array.isArray(d)?d[0]:d; if(row&&row.targetConsensus) out[sym]=+row.targetConsensus; }
    }catch(e){}
  }));
  return out;
}

async function fetchWeekNews(){
  for(let o=0;o<7;o++){
    const d=new Date(Date.now()+4*3600000-o*86400000).toISOString().slice(0,10);
    const j=await ghRead(`data/market/news-${d}.json`);
    if(j) return {date:d, items:(Array.isArray(j)?j:(j.news||j.items||[]))};
  }
  return {date:null, items:[]};
}

function saRowMap(sa){
  const m={};
  [...((sa&&sa.stocks)||[]),...((sa&&sa.etfs)||[])].forEach(r=>{ const s=r.symbol||r.sym; if(s) m[s]=r; });
  return m;
}

// deterministic verdicts — the selection basis, enforced in code
function computeSignals(holdings, saMap, targets, totalValue){
  const today=Date.now();
  const rows=holdings.map(h=>{
    const sa=saMap[h.sym]||{};
    const quant=sa['Quant Rating']!=null?+sa['Quant Rating']:null;
    const M=sa['Momentum Grade']||null, V=sa['Valuation Grade']||null, G=sa['Growth Grade']||null, P=sa['Profitability Grade']||null, R=sa['EPS Revision Grade']||null;
    const rsi=sa['RSI']!=null?+(+sa['RSI']).toFixed(1):null;
    let earnDays=null;
    if(sa['Upcoming Announce Date']){ const t=Date.parse(sa['Upcoming Announce Date']); if(!isNaN(t)) earnDays=Math.round((t-today)/86400000); }
    const target=targets[h.sym]||null;
    const gapPct=(target&&h.livePrice)?+(((target-h.livePrice)/h.livePrice)*100).toFixed(1):null;
    const weight=totalValue?+((h.value/totalValue)*100).toFixed(1):null;
    const reasons=[];
    if(h.glPct<=-50) reasons.push('loss>=50%');
    if(quant!=null&&quant<2) reasons.push('quant<2');
    if(M&&/^[DF]/.test(M)&&h.value>5000) reasons.push('momentum D/F on >$5K');
    if(h.dayPct!=null&&Math.abs(h.dayPct)>=8) reasons.push('day move >=8%');
    if(rsi!=null&&(rsi>70||rsi<30)&&h.value>5000) reasons.push(rsi>70?'RSI>70':'RSI<30');
    if(earnDays!=null&&earnDays>=0&&earnDays<=14) reasons.push('earnings<=14d');
    // week move is a real weekly signal — day moves were the only short horizon before
    if(h.weekPct!=null&&Math.abs(h.weekPct)>=12) reasons.push('week move >=12%');

    // strong is evaluated INDEPENDENTLY of flags. A high-quality holding with
    // earnings on Thursday is still high-quality — it is strong AND flagged.
    const isStrong = (quant!=null&&quant>=4&&weight!=null&&weight>=2);
    let verdict='hold';
    if(h.glPct<=-50||(quant!=null&&quant<2)||(M&&/^[DF]/.test(M)&&h.value>5000)) verdict='review';
    else if(isStrong) verdict='strong';
    else if(reasons.length) verdict='watch';
    return {sym:h.sym, price:h.livePrice, glPct:+(+h.glPct).toFixed(1), dayPct:h.dayPct, weekPct:h.weekPct??null, value:h.value, weight, quant, V,G,P,M,R, rsi, earnDays, target, gapPct, sector:h.sector||sa['Sector']||null, verdict, reasons, strong:isStrong};
  });
  return rows;
}


function monthlyPromptV3(selected, portfolioStats, asOf){
  return `أنت محلل مالي محترف. حلّل الميزة التنافسية والنظرة البعيدة (سنة+) لكل سهم أدناه. البيانات محسوبة مسبقاً — لا تخترع أي رقم أو اسم قاعدة أو وصف شركة غير مستمد من الحقول. archetype و binding و conviction محسوبة آلياً — فسّرها ولا تغيّرها.

تواريخ البيانات: الأسعار ${asOf.prices} · تقييمات SA ${asOf.sa}
إحصاءات المحفظة: ${JSON.stringify(portfolioStats)}
الأسهم (أكبر المراكز + ما يحتاج قراراً بعيد المدى):
${JSON.stringify(selected)}

أخرج JSON فقط:
{
 "summary":"فقرة خليجية: خلاصة شهرية للمحفظة من منظور الاحتفاظ طويل المدى، اذكر تواريخ البيانات",
 "biggest_risk":"جملة واحدة: أكبر خطر بنيوي (تركّز/جودة/تقييم)",
 "long_view":"فقرة: كيف تبدو المحفظة على أفق سنة+ بناءً على درجات الجودة والنمو",
 "health":"فقرة: صحة التوزيع والتركّز وما يستحق إعادة نظر — معلومات لا أوامر",
 "stocks":[{"sym":"NVDA","moat":"wide|narrow|none|unclear","thesis":"2-3 جمل: قوة الأعمال من P وG، ماذا يعني archetype وbinding، وهل الاحتفاظ مبرر من البيانات","watch":"العائق أو الحدث للمراقبة أو \"\""}]
}
قواعد: moat يُشتق حصراً من Profitability وGrowth وconviction (P≥A- ونمو معقول ومؤكد = wide، P في B = narrow، P≤C أو distortion = none/unclear). لا نصيحة مالية. JSON فقط.`;
}

function weeklyPromptV3(selected, portfolioStats, newsText, asOf){
  return `أنت محلل مالي محترف. البيانات أدناه محسوبة مسبقاً — لا تعيد حسابها ولا تخترع أي رقم أو اسم قاعدة أو اقتباس غير موجود في البيانات. يُمنع منعاً باتاً نسب أي قاعدة لجهة (مثل قاعدة Bridgewater) ما لم ترد في البيانات. وصف أي شركة يكون فقط من الحقول المقدمة.

تواريخ البيانات: الأسعار ${asOf.prices} · تقييمات SA ${asOf.sa} · الأخبار حتى ${asOf.news||'غير متوفر'}

إحصاءات المحفظة (محسوبة): ${JSON.stringify(portfolioStats)}

الأسهم المختارة (بالقواعد الآلية — verdict و reasons محسوبة، لا تغيّرها):
${JSON.stringify(selected)}

أخبار الأسبوع (مترجمة):
${newsText}

أخرج JSON فقط، بلا أي نص قبله أو بعده، بهذا الشكل:
{
 "summary":"فقرة خليجية 3-4 جمل: خلاصة الأسبوع للمحفظة، اذكر تواريخ البيانات، واربط بأخبار الأسبوع إن مسّت أسهمه، بدون توصية شراء/بيع",
 "biggest_risk":"جملة واحدة: أكبر خطر هذا الأسبوع",
 "stocks":[{"sym":"DUOL","thesis":"2-3 جمل تجمع كل شيء عن السهم: ماذا تقول درجاته وسعره وخبره إن وجد، ولماذا هو بهذا الـverdict، معلوماتياً بدون أمر","watch":"مستوى أو حدث للمراقبة إن وجد وإلا \"\""}],
 "clusters":[{"name":"اسم المجموعة","syms":["A","B"],"note":"لماذا تتحرك معاً — من قطاعاتها وقيمها المقدمة فقط"}],
 "hedge":"فكرة تحوط معلوماتية إن ظهرت من البيانات وإلا \"\""
}
قواعد: stocks يشمل كل سهم في القائمة المختارة فقط. لا تذكر عدد الأسهم غير المعروضة في summary — الكود يكتبها في silent_note_ar. weekPct هو تغيّر السهم خلال الأسبوع — استخدمه عند الحديث عن الأسبوع. glPct هو الربح/الخسارة منذ الشراء وليس أداء الأسبوع، لا تصفه كأداء أسبوعي. thesis بالعربية الخليجية المهنية. إن غاب target اكتب في thesis أن هدف المحللين غير متوفر فقط إذا كان ذلك مهماً. لا نصيحة مالية.`;
}


async function callClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 16000, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error('Claude API error: ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return d.content?.[0]?.text || '';
}

const { percentileRead, crossSectional, normalRank } = require('./_lib/percentile-read');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sessionToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const apiKey = req.body?.api_key;
  let requestingUser = null;
  let authorized = false;
  if (apiKey === API_KEY) authorized = true;
  else if (sessionToken) { requestingUser = await verifyAccess(sessionToken); if (requestingUser) authorized = true; }
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

  const { nickname, type = 'weekly' } = req.body || {};
  if (!nickname) return res.status(400).json({ error: 'nickname required' });
  if (!['weekly', 'monthly'].includes(type)) return res.status(400).json({ error: 'type must be weekly or monthly' });
  if (requestingUser && !requestingUser.isAdmin && requestingUser.nickname !== nickname)
    return res.status(403).json({ error: 'Forbidden' });

  try {
    // v3 builds its own holdings from portfolio.json + live quotes.
    // (The old portfolio-for-ai fetch, saToText and market-data reads fed the
    //  deleted buildPrompt path and were unused dead weight — removed.)
    const today = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
    const pf = await ghRead(nickname === 'rashed' ? 'data/portfolio.json' : `data/portfolio-${nickname}.json`);
    const { data: sa } = await loadLatestSA();

    if (type === 'weekly') {
      try {
      // ═══ v3 structured weekly ═══
      // build holdings from portfolio.json + live Yahoo prices (portfolio-for-ai returns text, not JSON)
      const baseHold=((pf&&(pf.holdings||pf.stocks))||[]).filter(h=>h&&h.sym&&h.shares>0);
      if(!baseHold.length) return res.status(400).json({ error:'portfolio.json empty for '+nickname });
      const quotes={};
      await Promise.all(baseHold.map(async h=>{
        try{
          const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(h.sym)}?interval=1d&range=1y`,{headers:{'User-Agent':'Mozilla/5.0'}});
          if(!r.ok) return;
          const d=await r.json(); const rs=d?.chart?.result?.[0]; const meta=rs?.meta;
          // Self-compute from the close array — do NOT trust chartPreviousClose (SSOT §6).
          const cl=(rs?.indicators?.quote?.[0]?.close||[]).filter(v=>v!=null);
          const px=meta?.regularMarketPrice ?? cl[cl.length-1] ?? null;
          const avg=n=>cl.length>=n?cl.slice(-n).reduce((a,b)=>a+b,0)/n:null;
          if(meta) quotes[h.sym]={
            price: px,
            prev:  cl.length>=2  ? cl[cl.length-2]  : null,
            wk:    cl.length>=6  ? cl[cl.length-6]  : null,   // 5 trading days back
            q3:    cl.length>=64 ? cl[cl.length-64] : null,   // ~63 trading days back
            sma50: avg(50), sma200: avg(200)                  // same call, no extra fetch
          };
        }catch(e){}
      }));
      const holdings=baseHold.map(h=>{
        const q=quotes[h.sym]||{};
        const price=q.price||h.cost;
        const value=Math.round(h.shares*price);
        const glPct=h.cost?((price-h.cost)/h.cost*100):0;
        const dayPct=q.prev?+(((price-q.prev)/q.prev)*100).toFixed(2):null;
        const weekPct=q.wk?+(((price-q.wk)/q.wk)*100).toFixed(2):null;
        const ret3m=q.q3?+(((price-q.q3)/q.q3)*100).toFixed(2):null;
        return { sym:h.sym, sector:h.sector||null, shares:h.shares, cost:h.cost, livePrice:price, value,
                 glPct, dayPct, weekPct, ret3m, sma50:q.sma50??null, sma200:q.sma200??null };
      });
      const totalValue=holdings.reduce((a,h)=>a+(h.value||0),0);
      const saMap=saRowMap(sa);
      const saDate=(sa&&sa.date)||'غير معروف';
      const bigSyms=holdings.filter(h=>h.value>5000).map(h=>h.sym);
      const targets=await fetchTargets(bigSyms);
      const news=await fetchWeekNews();
      const newsText=news.items.slice(0,14).map(n=>'- '+(n.title_ar||n.title||'')+' ['+((n.syms||[]).join(','))+'] '+(n.insight_ar||'').slice(0,160)).join('\n')||'لا أخبار متوفرة';
      const rows=computeSignals(holdings, saMap, targets, totalValue);
      let selected=rows.filter(r=>r.verdict!=='hold');
      const watchRows=selected.filter(r=>r.verdict==='watch').sort((a,b)=>(b.value||0)-(a.value||0)).slice(0,10);
      selected=selected.filter(r=>r.verdict!=='watch').concat(watchRows);
      const techValue=rows.filter(r=>/tech/i.test(r.sector||'')).reduce((a,r)=>a+(r.value||0),0);
      const shown=new Set(selected.map(r=>r.sym));
      const silent=rows.filter(r=>r.verdict==='hold');              // no signals at all
      const cut=rows.filter(r=>!shown.has(r.sym)&&r.verdict!=='hold'); // had signals, lost to the top-10 cap
      // ── PRICE READ (section 8 of SSOT) — computed for ALL holdings, shown on some.
      // Logging every holding every week is the dataset that lets this be TESTED in
      // ~6 months (percentile band vs forward return). Free now, unreconstructable later.
      let readLog=[];
      try {
        const dists = await ghRead('data/distributions.json');
        if (dists) {
          const cross = crossSectional(holdings.map(h=>({sym:h.sym, price:h.livePrice,
            sma50:h.sma50, sma200:h.sma200, ret3m:h.ret3m})));
          const byS = Object.fromEntries(holdings.map(h=>[h.sym,h]));
          rows.forEach(r=>{
            const h=byS[r.sym]; if(!h) return;
            const rd = percentileRead({
              sym:r.sym, price:h.livePrice, sma50:h.sma50, sma200:h.sma200, ret3m:h.ret3m,
              dist: dists[r.sym] || {}, crossPct: cross[r.sym] || null,
              normalRank: normalRank(r.sym, dists)
            });
            if (rd && rd.show) r.read = rd;               // rendered on the card
            readLog.push({ sym:r.sym, zone:rd?.zone||null, driver:rd?.driver||null,
              value:rd?.value??null, normal:rd?.normal??null, self:rd?.self_pct??null,
              cross:rd?.cross_pct??null, nrank:rd?.normal_rank??null,
              regime:!!rd?.regime_flag, price:h.livePrice });
          });
        }
      } catch(e) { readLog=[]; }

      const portfolioStats={ total_value:Math.round(totalValue), holdings:rows.length,
        tech_concentration_pct:totalValue?+((techValue/totalValue)*100).toFixed(1):null,
        review_count:selected.filter(r=>r.verdict==='review').length,
        watch_count:selected.filter(r=>r.verdict==='watch').length,
        strong_count:selected.filter(r=>r.verdict==='strong').length,
        watch_capped:cut.length>0,
        silent_count:silent.length,
        silent_value:Math.round(silent.reduce((a,r)=>a+(r.value||0),0)),
        cut_count:cut.length,
        cut_value:Math.round(cut.reduce((a,r)=>a+(r.value||0),0)),
        cut_syms:cut.map(r=>r.sym),
        not_shown_count:silent.length+cut.length,
        stress_tech_minus20:Math.round(techValue*0.2) };
      const asOf={prices:today, sa:saDate, news:news.date};
      const raw=await callClaude(weeklyPromptV3(selected, portfolioStats, newsText, asOf));
      let cj=null; try{ cj=JSON.parse(raw.replace(/```json|```/g,'').trim()); }catch(e){ return res.status(500).json({error:'Claude JSON parse failed', preview:raw.slice(0,200)}); }
      const thesisMap={}; (cj.stocks||[]).forEach(s=>{ thesisMap[s.sym]={thesis:s.thesis||'',watch:s.watch||''}; });
      const stocksOut=selected.map(r=>Object.assign({},r,thesisMap[r.sym]||{}));
      // clusters: attach code-summed values
      const valBySym={}; rows.forEach(r=>valBySym[r.sym]=r.value||0);
      const clusters=(cj.clusters||[]).map(c=>Object.assign({},c,{value:Math.round((c.syms||[]).reduce((a,s)=>a+(valBySym[s]||0),0))}));
      const doc={ type:'weekly', schema:2, date:today, nickname, as_of:asOf,
        verdict:Object.assign({},portfolioStats,{
          biggest_risk:cj.biggest_risk||'',
          silent_note_ar: [
            portfolioStats.silent_count
              ? `و${portfolioStats.silent_count} سهم تم فحصها وما ظهرت فيها إشارات هذا الأسبوع`
              : '',
            portfolioStats.cut_count
              ? `و${portfolioStats.cut_count} سهم ظهرت فيها إشارات لكن ما دخلت القائمة لأن العرض محدود بأكبر ١٠ مراكز قيمةً (${portfolioStats.cut_syms.join('، ')})`
              : ''
          ].filter(Boolean).join('. ')
        }),
        summary:cj.summary||'', stocks:stocksOut, clusters, hedge:cj.hedge||'',
        price_reads: readLog,        // ALL holdings, incl. ones not shown — for future testing
        stress:[{scenario:'تصحيح تقنية -20%', impact_usd:-portfolioStats.stress_tech_minus20}],
        generated:new Date().toISOString() };
      const filePath=`data/analysis-weekly-${nickname}-${today}.json`;
      const ok=await ghWrite(filePath, doc);
      if(!ok) return res.status(500).json({ error:'Failed to save analysis' });
      return res.status(200).json({ success:true, type, nickname, path:filePath, schema:2, selected:selected.length });
      } catch(e) {
        return res.status(500).json({ error:'weekly v3 crashed', detail:String(e && e.stack || e).slice(0,400) });
      }
    } else {
      // ═══ v3 structured monthly ═══
      try {
      const baseHold=((pf&&(pf.holdings||pf.stocks))||[]).filter(h=>h&&h.sym&&h.shares>0);
      if(!baseHold.length) return res.status(400).json({ error:'portfolio.json empty for '+nickname });
      const quotes={};
      await Promise.all(baseHold.map(async h=>{
        try{ const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(h.sym)}?interval=1d&range=5d`,{headers:{'User-Agent':'Mozilla/5.0'}});
          if(!r.ok) return; const d=await r.json(); const meta=d?.chart?.result?.[0]?.meta;
          if(meta) quotes[h.sym]={price:meta.regularMarketPrice||null};
        }catch(e){}
      }));
      const holdings=baseHold.map(h=>{ const price=(quotes[h.sym]&&quotes[h.sym].price)||h.cost; return { sym:h.sym, sector:h.sector||null, value:Math.round(h.shares*price), livePrice:price, glPct:h.cost?+(((price-h.cost)/h.cost)*100).toFixed(1):0 }; });
      const totalValue=holdings.reduce((a,h)=>a+(h.value||0),0);
      const saMap=saRowMap(sa);
      // buckets (scorer v2 output) — walk back 14 days
      let bk=null;
      for(let o=0;o<14;o++){ const d=new Date(Date.now()+4*3600000-o*86400000).toISOString().slice(0,10);
        bk=await ghRead(`data/sa-buckets-${d}.json`)||await ghRead(`data/sa-buckets-${nickname}-${d}.json`); if(bk) break; }
      const bkMap=(bk&&bk.scored)||{};
      const rows=holdings.map(h=>{
        const r=saMap[h.sym]||{}; const b=bkMap[h.sym]||{};
        return { sym:h.sym, value:h.value, weight:totalValue?+((h.value/totalValue)*100).toFixed(1):null,
          glPct:h.glPct, sector:h.sector,
          quant:r['Quant Rating']!=null?+r['Quant Rating']:null,
          P:r['Profitability Grade']||null, G:r['Growth Grade']||null, V:r['Valuation Grade']||null,
          long_score:(b.long&&b.long.score!=null)?b.long.score:null,
          archetype:(b.archetype&&b.archetype.key)||null,
          conviction:(b.conviction&&b.conviction.tier)||null,
          binding:(b.binding&&(b.binding.grade+':'+b.binding.letter))||null,
          distortion:!!b.distortion };
      });
      rows.sort((a,b)=>(b.value||0)-(a.value||0));
      const selected=rows.slice(0,12);
      const techValue=rows.filter(r=>/tech/i.test(r.sector||'')).reduce((a,r)=>a+(r.value||0),0);
      // Monthly is a LONG-horizon report: a 3-month percentile is the wrong timescale
      // and would contradict the moat framing. Only the regime fact carries over —
      // "this stock's own normal is extreme" is a long-horizon statement.
      let regimeNotes=[];
      try {
        const dists = await ghRead('data/distributions.json');
        if (dists) rows.forEach(r=>{
          const nr = normalRank(r.sym, dists), d = dists[r.sym];
          if (!nr || !d || !d.normal) return;
          const k = nr.sma200!=null ? 'sma200' : (nr.sma50!=null ? 'sma50' : null);
          if (k && nr[k] >= 85) regimeNotes.push({ sym:r.sym, metric:k,
            normal:d.normal[k], normal_rank:nr[k] });
        });
      } catch(e) { regimeNotes=[]; }

      const portfolioStats={ total_value:Math.round(totalValue), holdings:rows.length,
        tech_concentration_pct:totalValue?+((techValue/totalValue)*100).toFixed(1):null };
      const asOf={prices:today, sa:(sa&&sa.date)||'غير معروف'};
      const raw=await callClaude(monthlyPromptV3(selected, portfolioStats, asOf));
      let cj=null; try{ cj=JSON.parse(raw.replace(/```json|```/g,'').trim()); }catch(e){ return res.status(500).json({error:'Claude JSON parse failed', preview:raw.slice(0,200)}); }
      const tm={}; (cj.stocks||[]).forEach(s=>{ tm[s.sym]={thesis:s.thesis||'', watch:s.watch||'', moat:s.moat||'unclear'}; });
      const MOAT2V={wide:'strong', narrow:'hold', unclear:'watch', none:'review'};
      const stocksOut=selected.map(r=>{ const t=tm[r.sym]||{}; return Object.assign({},r,t,{verdict:MOAT2V[t.moat]||'watch', price:holdings.find(h=>h.sym===r.sym).livePrice}); });
      const doc={ type:'monthly', schema:2, date:today, nickname, as_of:asOf,
        verdict:{ tech_concentration_pct:portfolioStats.tech_concentration_pct,
          review_count:stocksOut.filter(s=>s.verdict==='review').length,
          watch_count:stocksOut.filter(s=>s.verdict==='watch').length,
          strong_count:stocksOut.filter(s=>s.verdict==='strong').length,
          biggest_risk:cj.biggest_risk||'' },
        summary:cj.summary||'', long_view:cj.long_view||'', health:cj.health||'',
        stocks:stocksOut, clusters:[], hedge:'', stress:[],
        regime_notes: regimeNotes,   // long-horizon only — no short-horizon percentile in monthly
        generated:new Date().toISOString() };
      const filePath=`data/analysis-monthly-${nickname}-${today.slice(0,7)}.json`;
      const ok=await ghWrite(filePath, doc);
      if(!ok) return res.status(500).json({ error:'Failed to save analysis' });
      return res.status(200).json({ success:true, type, nickname, path:filePath, schema:2, selected:stocksOut.length });
      } catch(e) {
        return res.status(500).json({ error:'monthly v3 crashed', detail:String(e&&e.stack||e).slice(0,400) });
      }
    }
    // both branches above always return — nothing reachable here
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
