// api/generate-analysis.js
const REPO = 'ralyafei-source/theisilabs-portfolio';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const API_KEY = process.env.BRIEFING_API_KEY;

async function ghRead(path) {
  const r = await fetch(
    `https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`
  );
  if (!r.ok) return null;
  try { return await r.json(); } catch(e) { return null; }
}

async function ghWrite(path, data) {
  const check = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app' } }
  );
  let sha = null;
  if (check.ok) { const ex = await check.json(); sha = ex.sha; }
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = { message: `Generate analysis for ${path}`, content, ...(sha && { sha }) };
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  return r.ok;
}

async function verifyAccess(sessionToken) {
  const usersData = await ghRead('data/users.json');
  if (!usersData) return null;
  const user = usersData.find(u => u.sessionToken === sessionToken);
  if (!user || new Date(user.sessionExpiry) < new Date()) return null;
  return user;
}

function buildPrompt(type, portfolioText, marketData) {
  const today = new Date().toISOString().slice(0, 10);

  if (type === 'daily') {
    return `أنت محلل مالي متخصص في السوق الأمريكي. قدم التحليل كمعلومات فقط وليس توصيات مالية.

بيانات السوق اليوم:
${marketData || 'بيانات السوق غير متاحة حالياً'}

محفظة المستثمر:
${portfolioText}

التاريخ: ${today}

قدم تحليلاً يومياً شاملاً بالعربية يتضمن:

═══ DAILY SIGNALS ═══
تقييم كل مركز (شراء قوي / شراء / احتفظ / خفف / بيع) مع السبب في سطر واحد لكل سهم
FORMAT: SYMBOL | التوصية | السبب

═══ EARNINGS ═══
الأرباح والأحداث القادمة خلال 2 أسبوع للأسهم في المحفظة

═══ MACRO ═══
أبرز المؤثرات الاقتصادية الكلية على هذه المحفظة اليوم`;
  }

  if (type === 'weekly') {
    return `أنت محلل مالي متخصص في السوق الأمريكي. قدم التحليل كمعلومات فقط وليس توصيات مالية.

محفظة المستثمر:
${portfolioText}

التاريخ: ${today}

قدم تحليلاً أسبوعياً شاملاً بالعربية يتضمن الأقسام التالية بالترتيب والتنسيق الدقيق:

═══ RISK RADAR ═══
تقييم المخاطر لكل مركز — مستوى الخطر، الخسارة المحتملة، نسبة المحفظة

═══ FAIR VALUE ═══
القيمة العادلة لكل سهم — سعر اليوم مقابل القيمة العادلة، هامش الأمان

═══ MOMENTUM ═══
تحليل الزخم والاتجاه لكل سهم — RSI، المتوسطات المتحركة

═══ SCORING ENGINE ═══

الجزء الأول — أفضل 5 فرص شراء هذا الأسبوع

لكل سهم من الأفضل 5، استخدم هذا التنسيق الدقيق:

SYMBOL | Score X.X/10 | التوصية
الطبقة 1 — مركزك الشخصي: [التحليل]
درجة هذه الطبقة: X/10
الطبقة 2 — التقييم: [التحليل]
درجة هذه الطبقة: X/10
الطبقة 3 — التقني: [التحليل]
درجة هذه الطبقة: X/10
الطبقة 4 — الأساسيات: [التحليل]
درجة هذه الطبقة: X/10
الإطار المستخدم: [اسم الإطار]
الإجراء: [توصية محددة]
ما لم يُؤخذ بعين الاعتبار: [ملاحظة]
───────────────────────────────

الجزء الثاني — أعلى 5 مراكز تحتاج مراجعة هذا الأسبوع

نفس التنسيق أعلاه لكل سهم من الأسوأ 5

الجزء الثالث — جدول الدرجات الكامل

| الرمز | الأساسيات | الزخم | التقييم | المخاطر | النقاط | التصنيف |
|-------|-----------|-------|---------|---------|--------|---------|
[صف لكل سهم في المحفظة]

الجزء الرابع — ملخص صحة المحفظة

درجة الصحة الإجمالية: X/10
التنويع: [تقييم]
التوصية الشهرية: [ملخص]`;
  }

  if (type === 'monthly') {
    return `أنت محلل مالي متخصص في السوق الأمريكي. قدم التحليل كمعلومات فقط وليس توصيات مالية.

محفظة المستثمر:
${portfolioText}

التاريخ: ${today}

قدم تحليلاً شهرياً شاملاً بالعربية يتضمن:

═══ COMPETITIVE EDGE ═══
الميزة التنافسية لكل شركة — الخندق التنافسي، التهديدات، التقييم التنافسي

═══ LONG VIEW ═══
النظرة طويلة المدى 5-10 سنوات لأهم المراكز

═══ PORTFOLIO HEALTH ═══
صحة المحفظة الشاملة — درجة الصحة، التنويع، التوصية الشهرية`;
  }

  return '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const sessionToken = authHeader.replace('Bearer ', '').trim();
  const apiKey = req.body?.api_key;

  let authorized = false;
  let requestingUser = null;

  if (apiKey === API_KEY) {
    authorized = true;
  } else if (sessionToken) {
    requestingUser = await verifyAccess(sessionToken);
    if (requestingUser) authorized = true;
  }

  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

  const { nickname, type = 'daily' } = req.body || {};
  if (!nickname) return res.status(400).json({ error: 'nickname required' });

  if (requestingUser && !requestingUser.isAdmin && requestingUser.nickname !== nickname) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const portfolioData = await ghRead(`data/portfolio-${nickname}.json`);
    if (!portfolioData || !portfolioData.stocks || portfolioData.stocks.length === 0) {
      return res.status(400).json({ error: 'No portfolio found for this user' });
    }

    const portfolioLines = portfolioData.stocks.map(s => {
      const val = s.mv || Math.round((s.shares || 0) * (s.price || s.cost || 0));
      const gl = s.gl ? (s.gl >= 0 ? '+' : '') + s.gl.toFixed(1) + '%' : '0%';
      const date = s.purchaseDate ? ` | تاريخ الشراء: ${s.purchaseDate}` : '';
      return `${s.sym}: ${s.shares || 0} سهم | تكلفة $${s.cost || 0} | قيمة $${val.toLocaleString()} | ${gl}${date}`;
    });
    const totalVal = portfolioData.stocks.reduce((a, s) => a + (s.mv || 0), 0);
    portfolioLines.push(`الإجمالي: $${totalVal.toLocaleString()}`);
    const portfolioText = portfolioLines.join('\n');

    const today = new Date().toISOString().slice(0, 10);
    const marketData = await ghRead(`data/market-data-${today}.json`);
    const marketText = marketData ? JSON.stringify(marketData).slice(0, 3000) : '';

    const prompt = buildPrompt(type, portfolioText, marketText);
    if (!prompt) return res.status(400).json({ error: 'Invalid type' });

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(500).json({ error: 'Claude API error', details: err });
    }

    const claudeData = await claudeRes.json();
    const analysisText = claudeData.content?.[0]?.text || '';
    if (!analysisText) return res.status(500).json({ error: 'Empty response from Claude' });

    const dateKey = (type === 'weekly' || type === 'monthly') ? today.slice(0, 7) : today;
    const filePath = `data/analysis-${type}-${nickname}-${dateKey}.json`;

    const analysisDoc = {
      type, date: today, nickname,
      content: analysisText,
      generated: new Date().toISOString()
    };

    const saved = await ghWrite(filePath, analysisDoc);
    if (!saved) return res.status(500).json({ error: 'Failed to save analysis' });

    return res.status(200).json({
      success: true, type, nickname, path: filePath,
      preview: analysisText.slice(0, 200) + '...'
    });

  } catch(e) {
    console.error('generate-analysis error:', e);
    return res.status(500).json({ error: e.message });
  }
};
