// api/backtest-batch.js  v4
// Fixes for 166-week run:
// 1. Fresh SHA on every save attempt (v3 fix preserved)
// 2. Save confirmation returned to dashboard
// 3. Only saves تراكم/بيع signals (cuts file size 60%)
// 4. Batched future price fetches with delays (prevents Yahoo rate limiting)
// 5. Returns saved:true/false so dashboard can show warning

const REPO          = 'ralyafei-source/theisilabs-portfolio';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const UA            = 'Mozilla/5.0 (compatible; theisilabs/1.0)';

// ─── GitHub helpers ───────────────────────────────────────────────────────────
async function ghGet(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app' }
  });
  if (!r.ok) return null;
  return r.json();
}

async function ghPut(path, content, message, sha) {
  const body = { message, content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64') };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'theisilabs-app',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return r.ok;
}

// ─── Parse [[SYM|rec|score|reason]] ──────────────────────────────────────────
function parseSignals(text) {
  const signals = [], regex = /\[\[([A-Z]+)\|([^|]+)\|([0-9.]+)\/10\|([^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const rec = match[2].trim();
    if (['تراكم','احتفظ','مراقبة','بيع'].includes(rec))
      signals.push({ sym: match[1].trim(), rec, score: parseFloat(match[3]), reason: match[4].trim() });
  }
  return signals;
}

// ─── Get future price from Yahoo ─────────────────────────────────────────────
async function getFuturePrice(sym, fromDate, daysAhead) {
  try {
    const base   = new Date(fromDate + 'T00:00:00Z');
    base.setUTCDate(base.getUTCDate() + daysAhead);
    const fromTs = Math.floor(base.getTime() / 1000);
    const toTs   = fromTs + 8 * 86400;
    const url    = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${fromTs}&period2=${toTs}`;
    const r      = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const d      = await r.json();
    const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    return closes.find(c => c != null) || null;
  } catch { return null; }
}

function judgeSignal(rec, base, future) {
  if (!base || !future) return 'unknown';
  const chg = (future - base) / base * 100;
  if (rec === 'تراكم') return chg > 5 ? 'correct' : chg < -5 ? 'wrong' : 'neutral';
  if (rec === 'بيع')   return chg < -5 ? 'correct' : chg > 5  ? 'wrong' : 'neutral';
  return 'neutral';
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { date } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ error: 'date required: YYYY-MM-DD' });

    // ── Step 1: Historical snapshot (reads local OHLC — fast) ────────────────
    const snapResp = await fetch(
      `https://theisilabs.vercel.app/api/historical-snapshot?date=${date}&format=json`
    );
    if (!snapResp.ok) throw new Error(`Snapshot failed: HTTP ${snapResp.status}`);
    const snap = await snapResp.json();
    if (!snap.portfolioText) throw new Error('Empty snapshot');

    // ── Step 2: Claude analysis ───────────────────────────────────────────────
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 8000,
        system: `You are a senior financial analyst. BACKTEST MODE — data is historical as of ${date}. Analyze as if today is ${date} with no knowledge of what happened after. UAE investor — ZERO capital gains tax. No short selling. Output Arabic only.`,
        messages: [{
          role: 'user',
          content: `${snap.portfolioText}

OUTPUT ONLY the BACKTEST SCORES block:
═══ BACKTEST SCORES ═══
For every stock, one line:
[[SYM|توصية|X.X/10|السبب الرئيسي]]

Scoring rules (strict):
• تراكم → score 7.5+ only
• احتفظ → 6.0–7.4
• مراقبة → 4.0–5.9
• بيع   → below 4.0

5-layer weighted score:
Layer 1 Personal Position (15%): gain/loss%, cost vs price, weight
Layer 2 Valuation (30%): DCF, P/E vs historical, PEG
Layer 3 Technical (20%): RSI, MACD, Golden/Death Cross, EMA20
Layer 4 Fundamental (25%): FCF, earnings history, moat
Layer 5 External (10%): analyst consensus, macro

Guards:
• Speculative (BTBT,MVST,PONY,WOLF,MSTR,SEZL,SERV): -1.0 penalty
• Biotech no revenue (ATYR,NTLA): max 5.0
• Down >50% from cost: need 8.0+ for تراكم else احتفظ

[[TOP_BUY|SYM|reason]]
[[TOP_RISK|SYM|reason]]
═══ END BACKTEST SCORES ═══`
        }]
      })
    });

    if (!claudeResp.ok) throw new Error(`Claude failed: HTTP ${claudeResp.status}`);
    const claudeData = await claudeResp.json();
    const claudeText = claudeData?.content?.[0]?.text || '';
    const signals    = parseSignals(claudeText);
    if (!signals.length) throw new Error('No signals parsed');

    // ── Step 3: Future prices — only for تراكم/بيع, batched to avoid Yahoo rate limit ──
    const HORIZONS      = [
      { label: '1w', days: 7  },
      { label: '2w', days: 14 },
      { label: '1m', days: 30 },
      { label: '3m', days: 90 },
      { label: '6m', days: 180 }
    ];
    const today         = new Date();
    const actionSignals = signals.filter(s => ['تراكم','بيع'].includes(s.rec));

    // Build list of all future price fetches needed
    const fetchQueue = [];
    for (const sig of actionSignals) {
      for (const h of HORIZONS) {
        const futureDate = new Date(date + 'T00:00:00Z');
        futureDate.setUTCDate(futureDate.getUTCDate() + h.days);
        if (futureDate < today) {
          fetchQueue.push({ sym: sig.sym, horizon: h.label, days: h.days });
        }
      }
    }

    // Fetch in batches of 5 with 300ms delay — prevents Yahoo rate limiting
    const priceCache = {}; // { 'NVDA_1m': 153.30 }
    for (let i = 0; i < fetchQueue.length; i += 5) {
      const batch   = fetchQueue.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(async ({ sym, horizon, days }) => ({
          key:   `${sym}_${horizon}`,
          price: await getFuturePrice(sym, date, days)
        }))
      );
      results.forEach(({ key, price }) => { if (price) priceCache[key] = price; });
      if (i + 5 < fetchQueue.length) await new Promise(r => setTimeout(r, 300));
    }

    // Build enriched signals — ONLY save تراكم/بيع (احتفظ/مراقبة excluded to save space)
    const enrichedSignals = [];
    for (const sig of actionSignals) {
      const holding     = snap.holdings?.find(h => h.sym === sig.sym);
      const priceOnDate = holding?.priceOnDate || null;
      const horizons    = {};

      for (const h of HORIZONS) {
        const futureDate = new Date(date + 'T00:00:00Z');
        futureDate.setUTCDate(futureDate.getUTCDate() + h.days);
        if (futureDate < today) {
          const futurePrice = priceCache[`${sig.sym}_${h.label}`] || null;
          const changePct   = priceOnDate && futurePrice
            ? +((futurePrice - priceOnDate) / priceOnDate * 100).toFixed(2)
            : null;
          horizons[h.label] = {
            price:     futurePrice,
            changePct,
            verdict:   judgeSignal(sig.rec, priceOnDate, futurePrice)
          };
        } else {
          horizons[h.label] = { price: null, changePct: null, verdict: 'pending' };
        }
      }
      enrichedSignals.push({ ...sig, priceOnDate, horizons });
    }

    // ── Step 4: Calculate accuracy per horizon ────────────────────────────────
    const accuracy = {};
    for (const h of HORIZONS) {
      const judged  = enrichedSignals.filter(s =>
        ['correct','wrong','neutral'].includes(s.horizons[h.label]?.verdict)
      );
      const correct = judged.filter(s => s.horizons[h.label]?.verdict === 'correct');
      accuracy[h.label] = judged.length > 0
        ? { correct: correct.length, total: judged.length, pct: Math.round(correct.length / judged.length * 100) }
        : { correct: 0, total: 0, pct: null };
    }

    // ── Step 5: Save to GitHub — always fetch fresh SHA, retry 3x ─────────────
    const run = {
      date,
      portfolioValue: snap.totalValueOnDate,
      signalCount:    signals.length,        // total including احتفظ/مراقبة
      actionCount:    enrichedSignals.length, // only تراكم/بيع (saved)
      signals:        enrichedSignals,        // only تراكم/بيع stored
      accuracy
    };

    let saved = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let existingData = { runs: [] };
      const existingFile = await ghGet('data/backtest-extended.json');
      if (existingFile?.content) {
        try { existingData = JSON.parse(Buffer.from(existingFile.content, 'base64').toString()); } catch {}
      }
      const freshSha = existingFile?.sha || null;
      const allRuns  = [...(existingData.runs || []).filter(r => r.date !== date), run]
        .sort((a, b) => a.date > b.date ? 1 : -1);

      const ok = await ghPut(
        'data/backtest-extended.json',
        { lastUpdated: new Date().toISOString(), totalRuns: allRuns.length, runs: allRuns },
        `Backtest: week ${date} (${enrichedSignals.length} action signals)`,
        freshSha
      );

      if (ok) { saved = true; break; }
      // Wait longer between retries to let GitHub propagate
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }

    // Return saved status so dashboard can warn if save failed
    return res.status(200).json({
      date,
      signalCount:    signals.length,
      actionCount:    enrichedSignals.length,
      accuracy,
      portfolioValue: snap.totalValueOnDate,
      saved           // dashboard uses this to show ✅ or ⚠️
    });

  } catch (e) {
    return res.status(500).json({ error: e.message, date: req.body?.date });
  }
};
