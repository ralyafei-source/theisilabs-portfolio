// api/backtest-analyze.js
// Proxy Claude API call server-side (browser can't call Anthropic directly due to CORS)
// POST /api/backtest-analyze
// Body: { portfolioText: string, date: string }

const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { portfolioText, date } = req.body || {};
    if (!portfolioText || !date) return res.status(400).json({ error: 'portfolioText and date required' });

    // Use Anthropic API key from env or fall back
    const key = ANTHROPIC_KEY || process.env.CLAUDE_API_KEY;
    if (!key) return res.status(500).json({ error: 'Anthropic API key not configured in Vercel env vars' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: `أنت محلل مالي متخصص تُحلل محفظة رشيد الاستثمارية.
هذا اختبار رجعي — البيانات المقدمة هي كما كانت في ${date}.
قدم تحليلاً صادقاً كأنك لا تعرف ما حدث بعد ذلك التاريخ.

لكل سهم في المحفظة، قدم بهذا الصيغة بالضبط:
[[SYM|توصية|X.X/10|السبب الرئيسي]]

التوصية يجب أن تكون: تراكم | احتفظ | مراقبة | بيع

مثال:
[[NVDA|تراكم|8.2|Golden Cross + DCF +31% + ROE 111%]]
[[PLTR|مراقبة|5.5|RSI 78 تشبع + P/E مرتفع]]

بعد جميع الأسهم:
[[TOP_BUY|SYM|السبب الكامل]]
[[TOP_RISK|SYM|السبب الكامل]]

ركز على الأسهم الرئيسية (أعلى 20 بالقيمة). لا تضيف شرحاً إضافياً.`,
        messages: [{
          role: 'user',
          content: `بيانات المحفظة في ${date}:\n\n${portfolioText}`
        }]
      })
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Anthropic API error: ${err.slice(0, 200)}` });
    }

    const data = await r.json();
    const text = data?.content?.[0]?.text || '';
    res.status(200).json({ analysis: text, model: data?.model, tokens: data?.usage });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
