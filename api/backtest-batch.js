// api/backtest-batch.js  v2
// Processes ONE week per request — called repeatedly by the dashboard
// POST /api/backtest-batch
// Body: { date: 'YYYY-MM-DD' }
// Returns: { date, signals, accuracy, portfolioValue } for that one week

const REPO          = 'ralyafei-source/theisilabs-portfolio';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const UA            = 'Mozilla/5.0 (compatible; theisilabs/1.0)';

// ─── GitHub save helper ───────────────────────────────────────────────────────
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
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app', 'Content-Type': 'application/json' },
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

// ─── Get price near a date ────────────────────────────────────────────────────
async function getPriceNear(sym, fromDate, daysAhead = 0) {
  try {
    const base = new Date(fromDate + 'T00:00:00Z');
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

    // Step 1 — Get historical snapshot
    const snapResp = await fetch(
      `https://theisilabs.vercel.app/api/historical-snapshot?date=${date}&format=json`
    );
    if (!snapResp.ok) throw new Error(`Snapshot failed: HTTP ${snapResp.status}`);
    const snap = await snapResp.json();
    if (!snap.portfolioText) throw new Error('Empty snapshot');

    // Step 2 — Run Claude analysis
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: `You are a senior financial analyst. BACKTEST MODE — data is historical as of ${date}. Analyze as if today is ${date} with no knowledge of what happened after. UAE investor — ZERO capital gains tax. No short selling. Output Arabic only.`,
        messages: [{ role: 'user', content: `${snap.portfolioText}\n\nOUTPUT ONLY:\n═══ BACKTEST SCORES ═══\n[[SYM|توصية|X.X/10|السبب]]\nRules: تراكم=7.5+, احتفظ=6-7.4, مراقبة=4-5.9, بيع<4\nSpeculative penalty -1.0: BTBT,MVST,PONY,WOLF,MSTR,SEZL,SERV\nBiotech max 5.0: ATYR,NTLA\nDown>50%: need 8.0+ for تراكم\n[[TOP_BUY|SYM|reason]]\n[[TOP_RISK|SYM|reason]]\n═══ END BACKTEST SCORES ═══` }]
      })
    });
    if (!claudeResp.ok) throw new Error(`Claude failed: HTTP ${claudeResp.status}`);
    const claudeData = await claudeResp.json();
    const claudeText = claudeData?.content?.[0]?.text || '';
    const signals    = parseSignals(claudeText);
    if (!signals.length) throw new Error('No signals parsed from Claude output');

    // Step 3 — Get future prices at all horizons
    const HORIZONS = [{label:'1w',days:7},{label:'2w',days:14},{label:'1m',days:30},{label:'3m',days:90},{label:'6m',days:180}];
    const today    = new Date();
    const enrichedSignals = [];

    for (const sig of signals) {
      const holding     = snap.holdings?.find(h => h.sym === sig.sym);
      const priceOnDate = holding?.priceOnDate || null;
      const horizons    = {};

      for (const h of HORIZONS) {
        const futureDate = new Date(date + 'T00:00:00Z');
        futureDate.setUTCDate(futureDate.getUTCDate() + h.days);
        if (futureDate < today) {
          const futurePrice = await getPriceNear(sig.sym, date, h.days);
          const changePct   = priceOnDate && futurePrice
            ? +((futurePrice - priceOnDate) / priceOnDate * 100).toFixed(2)
            : null;
          horizons[h.label] = { price: futurePrice, changePct, verdict: judgeSignal(sig.rec, priceOnDate, futurePrice) };
        } else {
          horizons[h.label] = { price: null, changePct: null, verdict: 'pending' };
        }
      }
      enrichedSignals.push({ ...sig, priceOnDate, horizons });
    }

    // Step 4 — Calculate accuracy per horizon
    const accuracy = {};
    for (const h of HORIZONS) {
      const judged  = enrichedSignals.filter(s =>
        ['تراكم','بيع'].includes(s.rec) &&
        !['pending','unknown'].includes(s.horizons[h.label]?.verdict)
      );
      const correct = judged.filter(s => s.horizons[h.label]?.verdict === 'correct');
      accuracy[h.label] = judged.length > 0
        ? { correct: correct.length, total: judged.length, pct: Math.round(correct.length / judged.length * 100) }
        : { correct: 0, total: 0, pct: null };
    }

    // Step 5 — Save this week's result to GitHub (merge with existing)
    let existingData = { runs: [], lastUpdated: null };
    const existingFile = await ghGet('data/backtest-extended.json');
    if (existingFile?.content) {
      try { existingData = JSON.parse(Buffer.from(existingFile.content, 'base64').toString()); } catch {}
    }
    const existingSha = existingFile?.sha || null;
    const run = { date, portfolioValue: snap.totalValueOnDate, signalCount: enrichedSignals.length, signals: enrichedSignals, accuracy };
    const allRuns = [...(existingData.runs || []).filter(r => r.date !== date), run]
      .sort((a, b) => a.date > b.date ? 1 : -1);
    await ghPut('data/backtest-extended.json',
      { lastUpdated: new Date().toISOString(), totalRuns: allRuns.length, runs: allRuns },
      `Backtest: add week ${date}`,
      existingSha
    );

    // Return result
    return res.status(200).json({ date, signalCount: enrichedSignals.length, accuracy, portfolioValue: snap.totalValueOnDate });

  } catch (e) {
    return res.status(500).json({ error: e.message, date: req.body?.date });
  }
};
