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

function saToText(sa) {
  if (!sa) return 'SA ratings unavailable — rely on FMP data and say so.';
  const rows = Array.isArray(sa) ? sa : (sa.holdings || sa.ratings || []);
  if (!rows.length) return JSON.stringify(sa).slice(0, 20000);
  const pick = (r, keys) => keys.map(k => r[k] !== undefined ? `${k}:${r[k]}` : null).filter(Boolean).join(' ');
  return rows.map(r => {
    const sym = r.sym || r.symbol || r.ticker || '?';
    return sym + ' | ' + pick(r, ['quant','sa_analyst','wall_st','wallSt','days_at_rating','V','G','P','M','R','valuation','growth','profitability','momentum','revisions','eps_estimate','eps_actual','eps_surprise','rsi','price']);
  }).join('\n').slice(0, 30000);
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

<b>━━━ الجزء الثالث — جدول الدرجات الكامل ━━━</b>
| الرمز | الدرجة | SA Quant | التوصية | السبب الرئيسي |
|---|---|---|---|---|

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
    const { data: sa } = await loadLatestSA();
    const saText = saToText(sa);
    const market = await ghRead(`data/market-data-${today}.json`, true);
    const marketText = market ? String(market).slice(0, 3000) : 'market data unavailable — skip silently';

    let analysisText = '';
    if (type === 'weekly') {
      analysisText = await callClaude(buildPrompt('weekly', portfolioText, saText, marketText, today));
    } else {
      const a = await callClaude(buildPrompt('monthly-a', portfolioText, saText, marketText, today));
      const b = await callClaude(buildPrompt('monthly-b', portfolioText, saText, marketText, today));
      analysisText = a + '\n\n' + b;
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
