// api/backtest-analyze.js  v2
// Uses the EXACT same prompt as Make.com Scenario 255 (Daily Intelligence)
// This ensures the backtest measures the real system accuracy — not a different prompt

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
        max_tokens: 4000,

        // ── SYSTEM PROMPT — exact copy from Make.com Scenario 255 Daily route ──
        system: `You are a senior financial analyst delivering daily morning intelligence.
Your job: three focused analyses for the investor's portfolio (see the INVESTOR and INVESTOR PROFILE sections in the provided data for identity, size, risk tolerance, and constraints).

Rules:
- No introductions, no firm names, no explanations of methodology
- Every line must contain a specific number, action, or insight
- Use structured tables and bullets — not essays
- Each section: maximum 600 words
- Complete ALL THREE sections before stopping
- Output language: Arabic only
- HTML allowed: <b> <i> only

Read the investor's identity, risk tolerance, time horizon, and constraints from the INVESTOR and INVESTOR PROFILE sections of the provided data. Respect all stated constraints as hard rules.

⚠️ BACKTEST MODE: The data provided is historical — as of ${date}.
Analyze as if you are on that date with no knowledge of what happened after.
After your full analysis, output a structured summary block for accuracy testing:

═══ BACKTEST SCORES ═══
For every stock you analyzed, output ONE line in this exact format:
[[SYM|توصية|X.X/10|السبب الرئيسي]]

توصية must be exactly one of: تراكم | احتفظ | مراقبة | بيع

Scoring rules (STRICT — no exceptions):
• تراكم → ONLY if score is 7.5 or above AND at least 3 buy triggers are met
• احتفظ → score 6.0 to 7.4 — positive but not enough conviction to add
• مراقبة → score 4.0 to 5.9 — mixed signals or elevated risk
• بيع   → score below 4.0 — structural weakness or broken story

Score using these 5 layers (weighted average):
Layer 1 — Personal Position (15%): gain/loss%, cost vs price, portfolio weight
Layer 2 — Valuation (30%): DCF upside, P/E vs historical, PEG
Layer 3 — Technical (20%): RSI, MACD, Golden/Death Cross, EMA20
Layer 4 — Fundamental (25%): revenue growth, FCF, earnings history, moat
Layer 5 — External (10%): analyst consensus, macro impact, sector

Additional scoring guards:
• Speculative stocks (BTBT, MVST, PONY, WOLF, MSTR, SEZL, SERV, BTBT): apply -1.0 structural risk penalty before finalizing score
• Biotech with no revenue (ATYR, NTLA, SMMT): hard cap at 5.0 regardless of technical signals
• Any stock down >50% from cost: require score 8.0+ before تراكم, else downgrade to احتفظ

After all [[SYM|...]] lines, add:
[[TOP_BUY|SYM|full reason]]
[[TOP_RISK|SYM|full reason]]
═══ END BACKTEST SCORES ═══`,

        // ── USER MESSAGE — portfolio data + exact Make.com prompt structure ──
        messages: [{
          role: 'user',
          content: `${portfolioText}

⚠️ CRITICAL DATA RULES — NEVER VIOLATE:
- ONLY use numbers that exist in the data above
- If analyst target is not in the data → write "غير متوفر"
- NEVER invent, estimate, or approximate any financial figure
- All values must come from the portfolio data only

📌 INVESTOR CONTEXT (structural — always true):
- UAE investor — ZERO capital gains tax
- No short selling, no options — long positions and ETFs only
- SPUS = ETF إسلامي — قيّمه على أساس الأداء والمزايا فقط كأي ETF آخر

📌 INVESTOR PROFILE:
- Risk tolerance: HIGH (holds speculative positions)
- Time horizon: LONG (5–10 years)
- Goal: long-term growth, comfortable with volatility
- Constraint: no short selling, no options

📌 BACKTEST DATE: ${date}
Analyze as if today is ${date}. Use only the technical indicators and prices provided.

═══ DAILY SIGNALS ═══
📊 إشارات اليوم — ${date}

1. جدول كامل لجميع المراكز التي تتجاوز $5,000:

| الرمز | التوصية | السبب | مركزك الحالي | توقعات المحللين 12 شهر |
|---|---|---|---|---|

قواعد الجدول:
- مركزك الحالي = نسبة ربح/خسارة فعلية من البيانات
- توقعات المحللين = من البيانات فقط — إذا غير موجود اكتب "غير متوفر"
- السبب يجب أن يتضمن: إشارة تقنية واحدة + جملة تشرح المعنى
- SPUS وجميع ETFs: قيّمها على الأداء الفعلي

2. ⚠️ Stop-Loss للمراكز الأسوأ أداءً:
FORMAT: SYMBOL | الخسارة% | التوصية | السبب المحدد

3. ⭐ أعلى صفقة إقناع اليوم:
─────────────────────────────
🎯 [SYMBOL] | [الكمية المقترحة] سهم | السعر: $[X]
─────────────────────────────
📈 السبب 1 — التقني: [RSI أو MACD أو Golden Cross + ما يعنيه]
💰 السبب 2 — التقييم: [السعر مقابل التكلفة + الفرصة]
📊 السبب 3 — الزخم: [إشارة إضافية]
─────────────────────────────
⚠️ تحليل معلوماتي — ليس توصية مرخصة.

═══ EARNINGS & EVENTS ═══
📅 الأرباح والأحداث القادمة — 30 يوماً من ${date}

1. أسهم المحفظة ذات أرباح محتملة قادمة
2. استراتيجية كل إعلان: [احتفظ قبل / تراكم قبل / انتظر النتائج]
3. ⚠️ أكبر خطر في الفترة القادمة

═══ MACRO TODAY ═══
🌍 الاقتصاد العالمي — ${date}

1. تأثير البيئة الاقتصادية على المحفظة (فقرة واحدة)
2. أكبر 3 أسهم متأثرة بالماكرو + السبب
3. أبرز مخاطر الفترة القادمة`
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
