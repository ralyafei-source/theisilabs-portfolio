// api/backtest-analyze.js  v3
// Uses the EXACT same scoring logic as Make.com Scenario 255 (Daily Intelligence)
// BACKTEST SCORES block comes FIRST so it always completes within token limit
// Full Arabic analysis follows after — bonus if tokens allow

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { portfolioText, date } = req.body || {};
    if (!portfolioText || !date)
      return res.status(400).json({ error: 'portfolioText and date required' });

    const key = ANTHROPIC_KEY || process.env.CLAUDE_API_KEY;
    if (!key)
      return res.status(500).json({ error: 'Anthropic API key not configured in Vercel env vars' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 20000,

        system: `You are a senior financial analyst delivering daily morning intelligence.
This is a BACKTEST — data is historical as of ${date}. Analyze as if today is ${date} with no knowledge of what happened after.

INVESTOR CONTEXT (always true):
- UAE investor — ZERO capital gains tax
- No short selling, no options — long positions and ETFs only
- Risk tolerance: HIGH | Time horizon: LONG (5–10 years)
- SPUS = Islamic ETF — evaluate on performance only

CRITICAL DATA RULE: ONLY use numbers from the provided data. Never invent prices, targets, or percentages.

Output language: Arabic only. HTML allowed: <b> <i> only.`,

        messages: [{
          role: 'user',
          content: `بيانات المحفظة في ${date}:

${portfolioText}

══════════════════════════════════════════════
التعليمات — اتبع هذا الترتيب بالضبط:
══════════════════════════════════════════════

الخطوة 1 — ابدأ بهذا القسم أولاً (مطلوب دائماً):

═══ BACKTEST SCORES ═══
لكل سهم في المحفظة، سطر واحد بهذا الشكل بالضبط:
[[SYM|توصية|X.X/10|السبب الرئيسي]]

قواعد التوصية الصارمة:
• تراكم → فقط إذا كانت الدرجة 7.5 أو أعلى
• احتفظ → الدرجة بين 6.0 و 7.4
• مراقبة → الدرجة بين 4.0 و 5.9
• بيع   → الدرجة أقل من 4.0

نظام الدرجات — متوسط مرجح لـ 5 طبقات:
الطبقة 1 — مركزك الشخصي (15%): ربح/خسارة%، الوزن في المحفظة، التكلفة مقابل السعر
الطبقة 2 — التقييم (30%): DCF upside، P/E مقابل التاريخي، PEG
الطبقة 3 — التقني (20%): RSI، MACD، Golden/Death Cross، EMA20
الطبقة 4 — الأساسيات (25%): نمو الإيرادات، FCF، سجل الأرباح، قوة الخندق
الطبقة 5 — الخارجي (10%): إجماع المحللين، تأثير الماكرو، القطاع

قواعد إضافية صارمة:
• الأسهم المضاربية (BTBT، MVST، PONY، WOLF، MSTR، SEZL، SERV): اطرح 1.0 من الدرجة النهائية
• الأسهم البيوتكنولوجية بدون إيرادات (ATYR، NTLA): الحد الأقصى 5.0 مهما كانت الإشارات
• أي سهم خسارته تجاوزت 50% من التكلفة: يحتاج درجة 8.0+ للحصول على تراكم، وإلا احتفظ

بعد جميع الأسهم:
[[TOP_BUY|SYM|السبب الكامل]]
[[TOP_RISK|SYM|السبب الكامل]]
═══ END BACKTEST SCORES ═══

الخطوة 2 — بعد إنهاء الخطوة 1 بالكامل، أضف التحليل اليومي:

═══ DAILY SIGNALS ═══
📊 إشارات اليوم — ${date}

جدول المراكز الأكبر من $5,000:
| الرمز | التوصية | السبب | مركزك الحالي |
|---|---|---|---|

⚠️ Stop-Loss للمراكز الأسوأ أداءً:
SYMBOL | الخسارة% | التوصية | السبب

⭐ أعلى صفقة إقناع اليوم:
[SYMBOL] — السبب التقني + التقييم + الزخم

═══ MACRO TODAY ═══
🌍 أبرز تأثير اقتصادي على المحفظة في ${date} — فقرة واحدة مركزة`
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
