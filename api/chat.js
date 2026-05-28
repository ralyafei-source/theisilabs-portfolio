// api/chat.js
// Portfolio Chat — Claude answers questions about Rashed's portfolio
// Context passed from frontend (already loaded) — no extra GitHub reads needed

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    message,
    history = [],
    portfolioContext = '',
    dailyContext = '',
    weeklyContext = '',
    monthlyContext = '',
    currentTab = '',
    lang = 'ar'
  } = req.body;

  if (!message?.trim()) return res.status(400).json({ error: 'No message' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key missing' });

  // Truncate analysis contexts to fit within token budget
  const truncate = (text, maxChars) =>
    text && text.length > maxChars ? text.slice(0, maxChars) + '\n...[مقتطع]' : text || '';

  const tabLabels = {
    signals:     'إشارات اليوم (Goldman)',
    earnings:    'الأرباح والأحداث (JPMorgan)',
    macro:       'الماكرو اليوم (McKinsey)',
    risk:        'رادار المخاطر (Bridgewater)',
    fairvalue:   'القيمة العادلة (Morgan Stanley)',
    momentum:    'الزخم (Renaissance)',
    competitive: 'الميزة التنافسية (Bain)',
    longview:    'النظرة طويلة المدى (Harvard)',
    health:      'صحة المحفظة (BlackRock)'
  };

  const systemPrompt = `أنت المستشار المالي الشخصي لراشد — مستثمر إماراتي محترف في أبوظبي.
لديك وصول كامل لمحفظته الحالية بأسعار السوق اللحظية وتحليلات اليوم من 9 أطر مؤسسية عالمية.

═══ قواعد الإجابة ═══
- أجب بالعربية دائماً ما لم يكتب راشد بالإنجليزية
- كن محدداً — استخدم الأرقام الفعلية من محفظته ومن التحليلات
- لا تعيد تكرار معلومات واضحة — اذهب مباشرة للتحليل والتوصية
- أجب بإيجاز وتركيز — فقرة أو فقرتين كافيتان للسؤال الواضح
- للأسئلة المعقدة: استخدم نقاط مرتبة وأرقام
- راشد لا يدفع ضريبة على أرباح رأس المال — اذكر هذا عند توصية البيع
- لا تستطيع البيع على المكشوف أو الخيارات (قيود Wio Invest)
- كن صريحاً حتى لو كانت التوصية بيع خسارة
- أنت مستشار خاص — تحدث كصديق خبير لا كمؤسسة رسمية

${currentTab ? `═══ السياق الحالي ═══\nراشد يشاهد الآن: ${tabLabels[currentTab] || currentTab}\n` : ''}

═══ محفظة راشد ═══
${truncate(portfolioContext, 3000)}

═══ التحليل اليومي ═══
${truncate(dailyContext, 2500)}

═══ التحليل الأسبوعي ═══
${truncate(weeklyContext, 2000)}

═══ التحليل الشهري ═══
${truncate(monthlyContext, 2000)}`;

  // Build conversation messages
  const messages = [
    ...history.slice(-8).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message }
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system: systemPrompt,
        messages
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'Claude API error' });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || 'عذراً، لم أستطع معالجة طلبك.';
    res.json({ response: text, usage: data.usage });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
