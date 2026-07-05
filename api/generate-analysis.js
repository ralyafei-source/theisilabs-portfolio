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
  const usersData = await ghRead('data/users.json');
  if (!usersData) return null;
  const list = Array.isArray(usersData) ? usersData : (usersData.users || []);
  const user = list.find(u => u.sessionToken === sessionToken);
  if (!user || new Date(user.sessionExpiry) < new Date()) return null;
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

function saToText(sa, symbolSet) {
  if (!sa) return 'SA ratings unavailable — rely on FMP data and say so.';
  let rows = Array.isArray(sa) ? sa : [...(sa.stocks || []), ...(sa.etfs || []), ...(sa.holdings || []), ...(sa.ratings || [])];
  if (!rows.length) return JSON.stringify(sa).slice(0, 20000);
  if (symbolSet && symbolSet.size) {
    rows = rows.filter(r => symbolSet.has(String(r.sym || r.symbol || r.ticker || '').toUpperCase()));
  }
  const g = (r, ...keys) => { for (const k of keys) { if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k]; } return null; };
  const num = v => v === null ? null : (typeof v === 'number' ? +v.toFixed(2) : v);
  return rows.map(r => {
    const sym = g(r, 'sym', 'symbol', 'ticker', 'Symbol') || '?';
    const parts = [
      ['Quant', num(g(r, 'Quant Rating', 'quant'))],
      ['SA', num(g(r, 'SA Analyst Ratings', 'sa_analyst'))],
      ['WallSt', num(g(r, 'Wall Street Ratings', 'wall_st', 'wallSt'))],
      ['DaysAtRating', g(r, 'Days at Rating', 'days_at_rating')],
      ['V', g(r, 'Valuation Grade', 'V', 'valuation')],
      ['G', g(r, 'Growth Grade', 'G', 'growth')],
      ['P', g(r, 'Profitability Grade', 'P', 'profitability')],
      ['M', g(r, 'Momentum Grade', 'M', 'momentum')],
      ['R', g(r, 'EPS Revision Grade', 'R', 'revisions')],
      ['NextEarnings', g(r, 'Upcoming Announce Date')],
      ['EPSest', num(g(r, 'EPS Estimate', 'eps_estimate'))],
      ['EPSact', num(g(r, 'EPS Actual', 'eps_actual'))],
      ['EPSsurprise', num(g(r, 'EPS Surprise', 'eps_surprise'))],
      ['RSI', num(g(r, 'RSI', 'rsi'))],
      ['Price', num(g(r, 'Price', 'price'))],
    ].filter(([k, v]) => v !== null).map(([k, v]) => `${k}:${v}`);
    return sym + ' | ' + parts.join(' ');
  }).join('\n').slice(0, 30000);
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
    let verdict='hold';
    if(h.glPct<=-50||(quant!=null&&quant<2)||(M&&/^[DF]/.test(M)&&h.value>5000)) verdict='review';
    else if(reasons.length) verdict='watch';
    else if(quant!=null&&quant>=4&&weight!=null&&weight>=2) verdict='strong';
    return {sym:h.sym, price:h.livePrice, glPct:+(+h.glPct).toFixed(1), dayPct:h.dayPct, value:h.value, weight, quant, V,G,P,M,R, rsi, earnDays, target, gapPct, sector:h.sector||sa['Sector']||null, verdict, reasons};
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
قواعد: stocks يشمل كل سهم في القائمة المختارة فقط. thesis بالعربية الخليجية المهنية. إن غاب target اكتب في thesis أن هدف المحللين غير متوفر فقط إذا كان ذلك مهماً. لا نصيحة مالية.`;
}

function buildPrompt(type, portfolioText, saText, marketText, today) {
  if (type === 'weekly') return `${portfolioText}

[SA PORTFOLIO RATINGS — ${today}]
${saText}

════════════════════════════════════════
DATA AVAILABLE:
1. ${portfolioText}: portfolio (shares, cost, value, P&L%), RSI, MACD, SMA50/200, EMA20, analyst $ targets (consensus/high/low), earnings dates, key metrics TTM
2. [SA PORTFOLIO RATINGS]: per holding Quant 1-5, V/G/P/M/R grades, SA Analyst, Wall St, days at rating, EPS estimate/actual/surprise
3. ${marketText}: market context (gainers/losers/news) — if 404 skip silently

SA GRADE SUBSTITUTIONS (use when FMP data missing):
- V grade → valuation signal (A+=cheap, F=expensive)
- G grade → growth signal (replaces revenue/earnings trend)
- M grade → momentum signal (replaces 5D price change direction)
- R grade → revisions signal (replaces earnings estimate trend)
- EPS surprise from SA → earnings beat/miss history

CRITICAL RULES:
- SA Results tab already shows Rashed: Quant ratings, grades, upgrades, downgrades. DO NOT repeat.
- Use RSI/MACD numbers from ${portfolioText} where available — they're real FMP data.
- Use analyst $ targets from ${portfolioText} for FAIR VALUE section — they ARE in the data.
- If a specific metric is not in the data, use the equivalent SA grade and say so clearly.
- No probability % columns — never invent probabilities.
- إذا لم يكن هدف المحللين موجوداً في البيانات، اكتب "غير متوفر" — يُمنع منعاً باتاً استنتاج أهداف من معرفة عامة أو الذاكرة.
- UAE investor: zero capital gains tax, long-only, SPUS never sell.

يجب أن تبدأ كل قسم بالعلامة التالية بالضبط:
═══ RISK RADAR ═══
═══ FAIR VALUE ═══
═══ SCORING ENGINE ═══
ثلاثة أقسام فقط — لا رابع
- SCORING ENGINE: قيّم فقط أفضل 5 وأسوأ 5. لا تنشئ جدول درجات كاملاً لكل المحفظة. لا تقدّر درجات لأسهم بلا بيانات — اكتب "بيانات غير كافية للتقييم" بدلاً من درجة (ت).

TODAY: ${today}
MARKET DATA: ${marketText}

═══ RISK RADAR ═══
<b>⚠️ رادار المخاطر الأسبوعي</b>

<b>1. أكبر 5 مخاطر في المحفظة:</b>
FORMAT: | الخطر | الضرر المحتمل $ | التوصية |
— استخدم RSI وMACO من ${portfolioText} للأسهم ذات الخطر التقني
— استخدم SA grades: M:D أو M:F = زخم هابط = خطر، R:F = تخفيضات محللين = خطر
— اذكر Bridgewater إذا التقنية > 60%

<b>2. اختبار الإجهاد — انخفاض السوق 20%:</b>
FORMAT: | SYMBOL | القيمة الحالية $ | الخسارة المتوقعة $ |
كل مركز أكبر من $10,000. الإجمالي $ للمحفظة.

<b>3. تركز القطاعات:</b>
النسبة الفعلية% + Goldman 25% Rule — هل أي سهم منفرد يتجاوز 25%؟

<b>4. الارتباط بين الأسهم:</b>
مجموعات ترتبط وتضخم الخسائر معاً — حسب القطاع من ${portfolioText}

<b>5. اقتراح تحوط (ETFs دفاعية طويلة فقط — لا ETFs عكسية أبداً):</b>
الأداة + الكمية + الحماية

═══ FAIR VALUE ═══
<b>💎 القيمة العادلة الأسبوعية</b>

استخدم هذا المصدر حسب الأولوية:
1. Analyst $ target من ANALYST PRICE TARGETS في ${portfolioText} — هذا متوفر دائماً
2. SA V grade كمؤشر نوعي للتقييم (A+=رخيص، F=غالٍ)
3. إذا لا يوجد أي منهما → اكتب "غير متوفر"

<b>1. جدول التقييم لكل مركز أكبر من $5,000:</b>
FORMAT: | SYMBOL | السعر الحالي | هدف المحللين $ | الفجوة% | SA V | التقييم |
— السعر الحالي من ${portfolioText}
— هدف المحللين = targetConsensus من ANALYST PRICE TARGETS في ${portfolioText}
— الفجوة% = (هدف - سعر) / سعر × 100
— SA V من [SA PORTFOLIO RATINGS]
— التقييم: مقيّم بأقل / عادل / مقيّم بأعلى

<b>2. أفضل 3 فرص — الأكثر تحت القيمة:</b>
لكل سهم: SYMBOL | السعر | هدف المحللين | الفجوة% | SA V grade | SA G grade | المحفز | الكمية المقترحة
اشرح ما تعنيه SA grades لهذا السهم تحديداً

<b>3. أكثر 3 أسهم تجاوزت القيمة:</b>
لكل سهم: SYMBOL | السعر | هدف المحللين | التجاوز% | SA V grade | الإجراء

<b>4. صحة المحفظة من منظور التقييم:</b>
كم مركز سعره تحت هدف المحللين؟ كم فوقه؟ الفجوة الإجمالية $.
⚠️ هدف المحللين تقدير وسطي — التباين طبيعي ±30%

═══ SCORING ENGINE ═══
<b>🎯 محرك القرار الأسبوعي</b>

<b>━━━ الجزء الأول — أعلى 5 فرص شراء ━━━</b>

[كرر لكل سهم من الخمسة]

<b>SYMBOL | Score X/10 | [التوصية]</b>
──────────────────────────────
<b>الطبقة 1 — مركزك الشخصي (15%):</b>
- ربحك/خسارتك: X% = $X | الوزن: X% | تكلفتك $X vs الحالي $X
- الإمارات: الربح معفى 100% من الضريبة
→ <b>درجة: X/10</b>

<b>الطبقة 2 — التقييم (30%):</b>
- هدف المحللين: $X (فجوة X%) من ANALYST PRICE TARGETS في ${portfolioText}
- SA V grade: [A+/A/B/C/D/F] — ما يعنيه (A+=رخيص نسبياً، F=غالٍ جداً)
- SA G grade: [X] — ما يعنيه للنمو
→ <b>درجة: X/10</b>

<b>الطبقة 3 — التقني (20%):</b>
- RSI: X من ${portfolioText} — [تشبع/محايد/مبالغ في البيع]
- MACD: من ${portfolioText} — [bullish/bearish]
- Cross: Golden/Death/لا شيء
- SA M grade: [X] — يؤكد أو يتعارض مع RSI/MACD؟
→ <b>درجة: X/10</b>

<b>الطبقة 4 — الأساسيات (25%):</b>
- SA P grade: [X] — جودة الأرباح والهوامش
- SA R grade: [X] — هل المحللون يرفعون أم يخفضون توقعاتهم؟
- EPS surprise من SA: آخر ربع — تجاوز أم أخفق؟ بكم؟
- Key metrics TTM من ${portfolioText} إذا متوفرة
→ <b>درجة: X/10</b>

<b>الطبقة 5 — الخارجي (10%):</b>
- SA Quant: [label score] — موقف SA الكلي
- Wall St: [X] — هل المحللون متفائلون؟
- Days at rating: [X] — تقييم جديد أم مستقر؟
- تأثير الماكرو من ${marketText} إذا متوفر
→ <b>درجة: X/10</b>

<b>📊 الحساب:</b>
L1×0.15 + L2×0.30 + L3×0.20 + L4×0.25 + L5×0.10 = <b>Score: X/10</b>

<b>✅ القرار:</b>
اشتري/أضف X سهم بـ $X = إجمالي $X | الوزن الجديد: X% | لماذا الآن؟

──────────────────────────────

<b>━━━ الجزء الثاني — أعلى 5 مراكز تحتاج مراجعة ━━━</b>
نفس التنسيق — القرار: بِع X سهم = $X محرر → أعِده لـ [SYMBOL] لأن [السبب بالأرقام]

──────────────────────────────

<b>━━━ الجزء الرابع — ملخص صحة المحفظة ━━━</b>
شراء (7-10): X مركز | احتفاظ (5-6): X | تخفيض (1-4): X
رأس المال للإعادة توظيف: $X
أفضل صفقة تبادل: بِع [SYMBOL] SA Quant [X] واشتري [SYMBOL] SA Quant [X] — [السبب]

After analyzing each stock, check the TRANSPARENCY section in ${portfolioText}. Include its line verbatim for stocks listed there.

═══ THIS WEEK'S DAILY ANALYSES ═══
{{51.data}}
═══ END ═══
`;
  if (type === 'monthly-a') return `[SA PORTFOLIO RATINGS — ${today}]
${saText}

SA GRADES: V=Valuation A+=cheap F=expensive | G=Growth | P=Profitability | M=Momentum | R=Revisions
SA Results tab already shows Rashed the full ratings — do not repeat them. Use grades as qualitative context when analyzing his holdings.

${portfolioText}

⚠️ CRITICAL DATA RULES — NEVER VIOLATE:
- ONLY use numbers that exist in ${portfolioText} above
- NEVER invent, estimate, or approximate any financial figure
- All values must come from ${portfolioText} only

📌 INVESTOR CONTEXT (structural — always true):
- UAE investor — ZERO capital gains tax
- No short selling, no options — long positions and ETFs only
- SPUS = ETF إسلامي — قيّمه على أساس الأداء والمزايا فقط كأي ETF آخر

📌 INVESTOR PROFILE (preferences):
An INVESTOR PROFILE section is included inside ${portfolioText}. Use it for risk tolerance,
time horizon, goals, constraints, cash-to-invest, and notes. Respect any stated
constraints as hard rules. If a field is absent it shows a safe default (risk=LOW,
horizon=LONG) — use the default, do not invent preferences. Do NOT assume a fixed
investor identity or portfolio size; read everything from ${portfolioText}.

📌 DATA SECTIONS TO USE FROM ${portfolioText}:
KEY METRICS TTM → FCF Yield + ROIC + ROE لتقييم جودة الخندق التنافسي
EARNINGS SURPRISES → beat_rate + avg_surprise لقياس جودة الإدارة
ANALYST CONSENSUS → consensus + analyst count

📌 McKinsey Moat Framework — قيّم كل سهم على 3 محاور:
1. التسعير: هل الشركة تستطيع رفع الأسعار؟ دليل: Gross Margin
2. تكلفة التحول: كم يكلف العميل المغادرة؟ دليل: Revenue retention
3. حصة السوق: هل تنمو؟ دليل: Revenue growth vs sector
قوي = 3/3 | متوسط = 2/3 | ضعيف = 1/3

📌 EXPLANATION RULES:
beat_rate=4/4 → "(إدارة تُحقق ما تعده 4 مرات متتالية — مؤشر جودة عالي)"
ROIC > 15% → "(عائد على رأس المال المستثمر ممتاز — الشركة تخلق قيمة حقيقية)"
FCF Yield > 5% → "(تدفق نقدي حر قوي نسبةً للسعر — الشركة تولد نقداً حقيقياً)"
Bridgewater: إذا التقنية > 60% → "(تركز قطاعي عالٍ — الفائدة المرتفعة تضغط على تقييمات النمو)"

يجب أن يبدأ القسم بالعلامة التالية بالضبط:
═══ COMPETITIVE EDGE ═══
لا تستخدم القسم الأول

TODAY: ${today}
MARKET DATA: ${marketText}

═══ COMPETITIVE EDGE ═══
<b>🏰 الميزة التنافسية الشهرية</b>

<b>1. تقييم الخندق التنافسي لكل مركز أكبر من $5,000:</b>
استخدم ROIC + FCF Yield + beat_rate من ${portfolioText}
FORMAT: SYMBOL | [قوي/متوسط/ضعيف] | السبب + الرقم من ${portfolioText} في جملة واحدة فقط

<b>2. أقوى 5 خنادق في المحفظة — الدليل الملموس:</b>
لكل سهم (3 أسطر فقط):
- محور التسعير: [قوي/ضعيف] + رقم واحد من ${portfolioText}
- محور النمو: ROIC + beat_rate + avg_surprise + ما يعنيه بجملة واحدة
- الخلاصة: لماذا هذا الخندق مستدام على 5 سنوات؟ جملة واحدة

<b>3. أضعف 3 خنادق — من يخسر ميزته التنافسية؟:</b>
لكل سهم (3 أسطر فقط):
- ما الذي تغيّر؟ رقم واحد من ${portfolioText}
- الخطر على قيمة الاستثمار بالدولار
- التوصية: جملة واحدة محددة

<b>4. أكبر تهديد تنافسي على المحفظة هذا الشهر:</b>
تهديد واحد + الأسهم المتأثرة + إجمالي المراكز المعرضة $

<b>5. الفائزون التنافسيون على 5 سنوات:</b>
ترتيب أفضل 5 مراكز بناءً على ROIC + FCF Yield + beat_rate من ${portfolioText}
لكل سهم: الرقمان الأقوى + جملة واحدة تشرح لماذا الخندق مستدام

After analyzing each stock, check the TRANSPARENCY section in the data. For any stock listed there, include its transparency line verbatim in your analysis of that stock. For stocks not listed, write nothing extra.`;
  if (type === 'monthly-b') return `[SA PORTFOLIO RATINGS — ${today}]
${saText}

SA GRADES: V=Valuation A+=cheap F=expensive | G=Growth | P=Profitability | M=Momentum | R=Revisions
SA Results tab already shows Rashed the full ratings — do not repeat them. Use grades as qualitative context when analyzing his holdings.

${portfolioText}

⚠️ CRITICAL DATA RULES — NEVER VIOLATE:
- ONLY use numbers that exist in ${portfolioText} above
- NEVER invent prices, targets, or growth rates
- Future projections: use compound growth formula ONLY on current portfolio value
  → محافظ = القيمة الحالية × (1.10)^سنوات
  → أساسي = القيمة الحالية × (1.15)^سنوات
  → متفائل = القيمة الحالية × (1.20)^سنوات
  احسب الأرقام الفعلية — لا تخترع أرقاماً مستديرة

📌 INVESTOR CONTEXT (structural — always true):
- UAE investor — ZERO capital gains tax
- No short selling, no options — long positions and ETFs only
- SPUS = ETF إسلامي — قيّمه على أساس الأداء والمزايا فقط كأي ETF آخر

📌 INVESTOR PROFILE (preferences):
An INVESTOR PROFILE section is included inside ${portfolioText}. Use it for risk tolerance,
time horizon, goals, constraints, cash-to-invest, and notes. Respect any stated
constraints as hard rules. If a field is absent it shows a safe default (risk=LOW,
horizon=LONG) — use the default, do not invent preferences. Do NOT assume a fixed
investor identity or portfolio size; read everything from ${portfolioText}.

📌 DATA SECTIONS TO USE FROM ${portfolioText}:
KEY METRICS TTM → FCF Yield + ROIC + ROE لقرارات LONG VIEW
EARNINGS SURPRISES → beat_rate + avg_surprise لتقييم المراكز طويلة المدى
DCF FAIR VALUES → dcf + upside% لصحة المحفظة
HISTORICAL P/E + PEG RATIO → hist5Y + currentPE لتقييم التوزيع
ANALYST CONSENSUS → consensus + analyst count

📌 EXPLANATION RULES:
beat_rate=4/4 → "(إدارة تُحقق ما تعده 4 مرات متتالية)"
ROIC > 15% → "(عائد ممتاز — الشركة تخلق قيمة حقيقية)"
FCF Yield > 5% → "(تدفق نقدي حر قوي — الشركة تولد نقداً فعلياً)"
DCF upside > 20% → "(نموذج FMP يرى قيمة حقيقية أعلى من السعر الحالي)"
Goldman 25% Rule: إذا تجاوز سهم 25% من المحفظة → أذكره في إعادة التوازن
Bridgewater: إذا التقنية > 60% → أذكره في صحة المحفظة

يجب أن تبدأ الأقسام بالعلامات التالية بالضبط:
═══ LONG VIEW ═══
═══ PORTFOLIO HEALTH ═══
لا تستخدم القسم الأول / الثاني

TODAY: ${today}
MARKET DATA: ${marketText}

═══ LONG VIEW ═══
<b>🔭 النظرة طويلة المدى</b>

<b>1. تقييم كل ETF من منظور 10 سنوات:</b>
FORMAT: SYMBOL | القيمة $ من ${portfolioText} | [احتفظ/أضف/قلل] | السبب في جملة واحدة
ملاحظة SPUS: قيّمه على الأداء والتنويع فقط

<b>2. أفضل 5 مراكز للاحتفاظ حتى 2036:</b>
لكل سهم:
SYMBOL | القيمة الحالية $ من ${portfolioText}
ROIC + beat_rate + ما يعنيه بجملة واحدة
تقدير 2036 (أساسي 15%): القيمة الحالية × (1.15)^10 = $X (احسب الرقم الفعلي)

<b>3. أسوأ 5 مراكز على المدى البعيد:</b>
لكل سهم:
SYMBOL | الخسارة% + القيمة $ من ${portfolioText}
السبب من ${portfolioText}: رقمان فقط (FCF سالب؟ ROIC منخفض؟ beat_rate ضعيف؟)
التوصية: جملة واحدة محددة + تاريخ أو حد

<b>4. تقدير قيمة المحفظة المستقبلية:</b>
القيمة الحالية من ${portfolioText} = $X
احسب الجدول التالي بالأرقام الفعلية فقط:
| السيناريو | 2031 (5 سنوات) | 2036 (10 سنوات) |
| محافظ 10% | $X × (1.10)^5 = $Y | $X × (1.10)^10 = $Y |
| أساسي 15% | $X × (1.15)^5 = $Y | $X × (1.15)^10 = $Y |
| متفائل 20% | $X × (1.20)^5 = $Y | $X × (1.20)^10 = $Y |
⚠️ هذه تقديرات رياضية على معدلات افتراضية — ليست ضماناً

<b>5. جميع ETFs في المحفظة — هل أحجامها مناسبة لمحفظة 10 سنوات؟</b>
| ETF | الحجم $ | % من المحفظة | التوصية | السبب |
استخدم القيم الفعلية من ${portfolioText}

═══ PORTFOLIO HEALTH ═══
<b>⚖️ صحة المحفظة الشهرية</b>

<b>1. درجة الصحة الشهرية: [X/10]</b>
قيّم بناءً على هذه المعايير الخمسة بالضبط:
- نسبة المراكز ذات beat_rate ≥ 3/4 من EARNINGS SURPRISES في ${portfolioText}: X من 20 = X%
- نسبة المراكز ذات DCF upside موجب من DCF FAIR VALUES في ${portfolioText}: X من 20 = X%
- نسبة التقنية من إجمالي المحفظة (احسب من ${portfolioText}): X% — Bridgewater حد: 60%
- نسبة المراكز ذات ROIC > 10% من KEY METRICS TTM في ${portfolioText}: X من 20 = X%
- نسبة المراكز ذات consensus Bullish من ANALYST CONSENSUS في ${portfolioText}: X من 20 = X%
الدرجة = متوسط هذه المعايير الخمسة مع تفسير لكل واحد

<b>2. توزيع الأصول الحالي vs المثالي:</b>
احسب النسب الفعلية من قيم ${portfolioText}
| القطاع | الحالي% (محسوب) | المثالي% | الإجراء |
لا تخترع النسب — احسبها من القيم الفعلية في ${portfolioText}

<b>3. خطة إعادة التوازن لهذا الشهر:</b>
ماذا تبيع: SYMBOL + الكمية + القيمة $ + السبب من ${portfolioText}
ماذا تشتري: SYMBOL + الكمية + القيمة $ + السبب من ${portfolioText}
Goldman 25% Rule: هل أي سهم يتجاوز 25%؟ احسب من ${portfolioText}
Bridgewater: هل التقنية > 60%؟ احسب من ${portfolioText}
المنطق الكامل بالأرقام

<b>4. نسبة السيولة المثلى هذا الشهر:</b>
عدد الأرباح القادمة من EARNINGS CALENDAR في ${portfolioText} = X شركة
البيئة الماكرو من ${marketText}
التوصية: X% نقداً + السبب المحدد

<b>5. أولويات الشهر القادم الثلاث:</b>
إجراء 1: SYMBOL + كمية + سعر + تاريخ تنفيذ + السبب من ${portfolioText}
إجراء 2: SYMBOL + كمية + سعر + تاريخ تنفيذ + السبب من ${portfolioText}
إجراء 3: SYMBOL + كمية + سعر + تاريخ تنفيذ + السبب من ${portfolioText}

⚠️ قبل أن تتصرف:
- هذا تحليل شهري يعتمد على بيانات FMP — ليس توصية استثمارية مرخصة
- التقديرات المستقبلية مبنية على معدلات نمو افتراضية فقط
- تحقق من آخر تقرير أرباح وأخبار الشركة قبل أي قرار

After analyzing each stock, check the TRANSPARENCY section in the data. For any stock listed there, include its transparency line verbatim in your analysis of that stock. For stocks not listed, write nothing extra.`;
  return '';
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
    // Portfolio via portfolio-for-ai (rich: prices, RSI/MACD/SMA, targets, key metrics, profile)
    const pfRes = await fetch(`https://theisilabs.vercel.app/api/portfolio-for-ai?nickname=${encodeURIComponent(nickname)}`);
    if (!pfRes.ok) return res.status(400).json({ error: 'portfolio-for-ai failed' });
    const portfolioText = await pfRes.text();

    const today = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
    const pf = await ghRead(nickname === 'rashed' ? 'data/portfolio.json' : `data/portfolio-${nickname}.json`);
    const symbolSet = new Set(((pf && (pf.holdings || pf.stocks)) || []).map(h => String(h.sym).toUpperCase()));
    const { data: sa } = await loadLatestSA();
    const saText = saToText(sa, symbolSet);
    const market = await ghRead(`data/market-data-${today}.json`, true);
    const marketText = market ? String(market).slice(0, 3000) : 'market data unavailable — skip silently';

    let analysisText = '';
    if (type === 'weekly') {
      try {
      // ═══ v3 structured weekly ═══
      // build holdings from portfolio.json + live Yahoo prices (portfolio-for-ai returns text, not JSON)
      const baseHold=((pf&&(pf.holdings||pf.stocks))||[]).filter(h=>h&&h.sym&&h.shares>0);
      if(!baseHold.length) return res.status(400).json({ error:'portfolio.json empty for '+nickname });
      const quotes={};
      await Promise.all(baseHold.map(async h=>{
        try{
          const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(h.sym)}?interval=1d&range=5d`,{headers:{'User-Agent':'Mozilla/5.0'}});
          if(!r.ok) return;
          const d=await r.json(); const meta=d?.chart?.result?.[0]?.meta;
          if(meta) quotes[h.sym]={price:meta.regularMarketPrice||null, prev:meta.chartPreviousClose||null};
        }catch(e){}
      }));
      const holdings=baseHold.map(h=>{
        const q=quotes[h.sym]||{};
        const price=q.price||h.cost;
        const value=Math.round(h.shares*price);
        const glPct=h.cost?((price-h.cost)/h.cost*100):0;
        const dayPct=q.prev?+(((price-q.prev)/q.prev)*100).toFixed(2):null;
        return { sym:h.sym, sector:h.sector||null, shares:h.shares, cost:h.cost, livePrice:price, value, glPct, dayPct };
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
      const portfolioStats={ total_value:Math.round(totalValue), holdings:rows.length,
        tech_concentration_pct:totalValue?+((techValue/totalValue)*100).toFixed(1):null,
        review_count:selected.filter(r=>r.verdict==='review').length,
        watch_count:selected.filter(r=>r.verdict==='watch').length,
        strong_count:rows.filter(r=>r.verdict==='strong').length,
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
        verdict:Object.assign({},portfolioStats,{biggest_risk:cj.biggest_risk||''}),
        summary:cj.summary||'', stocks:stocksOut, clusters, hedge:cj.hedge||'',
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
        generated:new Date().toISOString() };
      const filePath=`data/analysis-monthly-${nickname}-${today.slice(0,7)}.json`;
      const ok=await ghWrite(filePath, doc);
      if(!ok) return res.status(500).json({ error:'Failed to save analysis' });
      return res.status(200).json({ success:true, type, nickname, path:filePath, schema:2, selected:stocksOut.length });
      } catch(e) {
        return res.status(500).json({ error:'monthly v3 crashed', detail:String(e&&e.stack||e).slice(0,400) });
      }
    }
    if (!analysisText) return res.status(500).json({ error: 'Empty response from Claude' });

    const dateKey = type === 'monthly' ? today.slice(0, 7) : today;
    const filePath = `data/analysis-${type}-${nickname}-${dateKey}.json`;
    const doc = { type, date: today, nickname, content: analysisText, generated: new Date().toISOString() };
    const saved = await ghWrite(filePath, doc);
    if (!saved) return res.status(500).json({ error: 'Failed to save analysis' });

    return res.status(200).json({ success: true, type, nickname, path: filePath, preview: analysisText.slice(0, 200) + '...' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
