// api/backtest-batch.js  v1
// Runs the backtest across multiple historical dates (30 weeks)
// POST /api/backtest-batch
// Body: { startDate, weeks, nickname }
// Saves results to data/backtest-extended.json in GitHub

const REPO          = 'ralyafei-source/theisilabs-portfolio';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FMP_KEY       = process.env.FMP_API_KEY;
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
  const body = {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64')
  };
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

// ─── Get Monday dates going back N weeks ─────────────────────────────────────
function getMondayDates(weeksBack, endDate) {
  const dates = [];
  const end = endDate ? new Date(endDate + 'T12:00:00Z') : new Date();
  // Find most recent Monday
  const day = end.getUTCDay();
  const daysToMonday = day === 0 ? 6 : day - 1;
  end.setUTCDate(end.getUTCDate() - daysToMonday - 7); // Start from last complete week

  for (let i = 0; i < weeksBack; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (i * 7));
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates.sort(); // oldest first
}

// ─── Fetch price on a specific date from Yahoo ────────────────────────────────
async function getPriceOnDate(sym, targetDate) {
  try {
    const toTs   = Math.floor(new Date(targetDate + 'T23:59:59Z').getTime() / 1000);
    const fromTs = toTs - 5 * 86400; // 5 days lookback to find nearest trading day
    const url    = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${fromTs}&period2=${toTs}`;
    const r      = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const d      = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;
    const timestamps = result.timestamp || [];
    const closes     = result.indicators?.quote?.[0]?.close || [];
    // Find the last close on or before targetDate
    let price = null;
    timestamps.forEach((ts, i) => {
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      if (date <= targetDate && closes[i]) price = closes[i];
    });
    return price;
  } catch { return null; }
}

// ─── Fetch prices at multiple future horizons ─────────────────────────────────
async function getFuturePrice(sym, fromDate, daysAhead) {
  try {
    const fromTs = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000) + (daysAhead * 86400);
    const toTs   = fromTs + 7 * 86400; // 7-day window to find a trading day
    const url    = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${fromTs}&period2=${toTs}`;
    const r      = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const d      = await r.json();
    const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const price  = closes.find(c => c != null);
    return price || null;
  } catch { return null; }
}

// ─── Parse [[SYM|rec|score|reason]] from Claude output ───────────────────────
function parseSignals(text) {
  const signals = [];
  const regex   = /\[\[([A-Z]+)\|([^|]+)\|([0-9.]+)\/10\|([^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const rec = match[2].trim();
    if (['تراكم','احتفظ','مراقبة','بيع'].includes(rec)) {
      signals.push({
        sym:    match[1].trim(),
        rec,
        score:  parseFloat(match[3]),
        reason: match[4].trim()
      });
    }
  }
  return signals;
}

// ─── Judge a signal at a given horizon ───────────────────────────────────────
function judgeSignal(rec, priceOnDate, futurePrice) {
  if (!priceOnDate || !futurePrice) return 'unknown';
  const changePct = ((futurePrice - priceOnDate) / priceOnDate) * 100;
  if (rec === 'تراكم') {
    if (changePct > 5)  return 'correct';
    if (changePct < -5) return 'wrong';
    return 'neutral';
  }
  if (rec === 'بيع') {
    if (changePct < -5) return 'correct';
    if (changePct > 5)  return 'wrong';
    return 'neutral';
  }
  return 'neutral'; // احتفظ and مراقبة not judged
}

// ─── Run analysis for one date ────────────────────────────────────────────────
async function analyzeDate(date, portfolioSymbols) {
  // Step 1: Get historical snapshot
  const snapResp = await fetch(
    `https://theisilabs-portfolio.vercel.app/api/historical-snapshot?date=${date}&format=json`
  );
  if (!snapResp.ok) return null;
  const snap = await snapResp.json();
  if (!snap.portfolioText) return null;

  // Step 2: Run Claude analysis
  const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: `You are a senior financial analyst. This is a BACKTEST — data is historical as of ${date}. Analyze as if today is ${date} with no knowledge of what happened after. UAE investor — ZERO capital gains tax. No short selling, no options. Output language: Arabic only.`,
      messages: [{
        role: 'user',
        content: `${snap.portfolioText}

OUTPUT ONLY the BACKTEST SCORES block — no other text:

═══ BACKTEST SCORES ═══
For every stock, one line exactly:
[[SYM|توصية|X.X/10|السبب الرئيسي]]

توصية must be: تراكم | احتفظ | مراقبة | بيع

Scoring rules:
• تراكم → score 7.5+ only
• احتفظ → score 6.0–7.4
• مراقبة → score 4.0–5.9
• بيع → score below 4.0

5-layer weighted score:
Layer 1 — Personal Position (15%): gain/loss%, cost vs price
Layer 2 — Valuation (30%): DCF upside, P/E vs historical
Layer 3 — Technical (20%): RSI, MACD, Golden/Death Cross
Layer 4 — Fundamental (25%): FCF, earnings history, moat
Layer 5 — External (10%): analyst consensus, macro

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

  if (!claudeResp.ok) return null;
  const claudeData = await claudeResp.json();
  const claudeText = claudeData?.content?.[0]?.text || '';
  const signals    = parseSignals(claudeText);
  if (!signals.length) return null;

  // Step 3: Get prices on the date for each signal
  const priceOnDateMap = {};
  for (const s of signals) {
    priceOnDateMap[s.sym] = snap.holdings?.find(h => h.sym === s.sym)?.priceOnDate || null;
  }

  return { date, signals, priceOnDateMap, portfolioValue: snap.totalValueOnDate };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Use streaming to send progress updates
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const { weeks = 30, endDate, nickname = 'rashed' } = req.body || {};

    // Get the Monday dates to test
    const dates = getMondayDates(Math.min(weeks, 52), endDate);
    send({ type: 'start', total: dates.length, dates });

    // Load existing results from GitHub
    let existingData = { runs: [], lastUpdated: null };
    const existingFile = await ghGet(`data/backtest-extended.json`);
    if (existingFile?.content) {
      try {
        existingData = JSON.parse(Buffer.from(existingFile.content, 'base64').toString());
      } catch {}
    }
    const existingSha      = existingFile?.sha || null;
    const existingDates    = new Set(existingData.runs.map(r => r.date));

    // Process each date
    const newRuns = [];
    const HORIZONS = [
      { label: '1w',  days: 7   },
      { label: '2w',  days: 14  },
      { label: '1m',  days: 30  },
      { label: '3m',  days: 90  },
      { label: '6m',  days: 180 }
    ];

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];

      // Skip if already processed
      if (existingDates.has(date)) {
        send({ type: 'skip', date, index: i + 1, total: dates.length, reason: 'already processed' });
        continue;
      }

      send({ type: 'progress', date, index: i + 1, total: dates.length, status: 'analyzing' });

      const result = await analyzeDate(date);
      if (!result) {
        send({ type: 'progress', date, index: i + 1, total: dates.length, status: 'failed' });
        continue;
      }

      // For each signal, get future prices at all horizons
      const enrichedSignals = [];
      for (const sig of result.signals) {
        const priceOnDate = result.priceOnDateMap[sig.sym];
        const horizonResults = {};

        for (const h of HORIZONS) {
          // Only fetch if the future date is in the past (can't measure future)
          const futureDate = new Date(date + 'T00:00:00Z');
          futureDate.setUTCDate(futureDate.getUTCDate() + h.days);
          const today = new Date();

          if (futureDate < today) {
            const futurePrice = await getFuturePrice(sig.sym, date, h.days);
            const changePct   = priceOnDate && futurePrice
              ? ((futurePrice - priceOnDate) / priceOnDate * 100)
              : null;
            horizonResults[h.label] = {
              price:     futurePrice,
              changePct: changePct ? +changePct.toFixed(2) : null,
              verdict:   judgeSignal(sig.rec, priceOnDate, futurePrice)
            };
          } else {
            horizonResults[h.label] = { price: null, changePct: null, verdict: 'pending' };
          }
        }

        enrichedSignals.push({
          ...sig,
          priceOnDate,
          horizons: horizonResults
        });
      }

      // Calculate accuracy for this date across horizons
      const accuracy = {};
      for (const h of HORIZONS) {
        const judged  = enrichedSignals.filter(s =>
          ['تراكم','بيع'].includes(s.rec) && s.horizons[h.label]?.verdict !== 'pending' && s.horizons[h.label]?.verdict !== 'unknown'
        );
        const correct = judged.filter(s => s.horizons[h.label]?.verdict === 'correct');
        accuracy[h.label] = judged.length > 0
          ? { correct: correct.length, total: judged.length, pct: Math.round(correct.length / judged.length * 100) }
          : { correct: 0, total: 0, pct: null };
      }

      const run = {
        date,
        portfolioValue:  result.portfolioValue,
        signalCount:     enrichedSignals.length,
        signals:         enrichedSignals,
        accuracy
      };

      newRuns.push(run);
      send({ type: 'progress', date, index: i + 1, total: dates.length, status: 'done', accuracy: accuracy['1m'] });

      // Small pause between dates to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));
    }

    // Merge new runs with existing and save
    const allRuns = [...existingData.runs, ...newRuns]
      .sort((a, b) => a.date > b.date ? 1 : -1)
      .filter((r, i, arr) => arr.findIndex(x => x.date === r.date) === i); // deduplicate

    const finalData = {
      lastUpdated: new Date().toISOString(),
      totalRuns:   allRuns.length,
      runs:        allRuns
    };

    const saved = await ghPut(
      'data/backtest-extended.json',
      finalData,
      `Backtest extended: ${newRuns.length} new weeks added`,
      existingSha
    );

    send({
      type:     'complete',
      newRuns:  newRuns.length,
      totalRuns: allRuns.length,
      saved,
      summary: {
        avgAccuracy1m: Math.round(
          allRuns
            .filter(r => r.accuracy['1m']?.pct != null)
            .reduce((sum, r) => sum + r.accuracy['1m'].pct, 0) /
          allRuns.filter(r => r.accuracy['1m']?.pct != null).length
        )
      }
    });

    res.end();

  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
  }
};
