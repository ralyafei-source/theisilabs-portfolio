// api/download-historical.js  v2
// ONE-TIME endpoint — downloads 2.5 years of OHLC for all portfolio symbols
// Includes data validation and retry for failed symbols
// GET /api/download-historical?from=2024-01-01&to=2026-06-15
// GET /api/download-historical?retry=NVDA,AMZN  (re-download specific symbols only)

const REPO         = 'ralyafei-source/theisilabs-portfolio';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const UA           = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const ALL_SYMBOLS = [
  'NVDA','AMZN','MU','OKTA','MSFT','CRM','PANW','CRWD','AAPL','GOOGL',
  'FTNT','ONTO','NOW','SIMO','APH','IOT','IONQ','PATH','ZETA','CRDO',
  'CLS','PLTR','DUOL','BTBT','MVST','MSTR','PONY','WOLF','SERV','SEZL',
  'ATYR','NTLA','SMMT','NEM','B','QQQ','VOO','SPY','IVV','SMH',
  'VGT','SPUS','XLP','QQQM','IBIT'
];

// ─── GitHub helpers ───────────────────────────────────────────────────────────
async function ghGet(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app' }
  });
  if (!r.ok) return null;
  return r.json();
}

async function ghPut(path, content, message, sha) {
  const encoded = Buffer.from(JSON.stringify(content, null, 1)).toString('base64');
  const body    = { message, content: encoded };
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

// ─── Fetch OHLC from Yahoo ────────────────────────────────────────────────────
async function fetchOHLC(sym, fromDate, toDate) {
  try {
    const fromTs = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
    const toTs   = Math.floor(new Date(toDate   + 'T23:59:59Z').getTime() / 1000);
    const url    = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}` +
                   `?interval=1d&period1=${fromTs}&period2=${toTs}`;
    const r      = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return { sym, bars: [], error: `HTTP ${r.status}` };
    const d      = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return { sym, bars: [], error: 'No data returned' };

    const timestamps = result.timestamp                          || [];
    const opens      = result.indicators?.quote?.[0]?.open      || [];
    const highs      = result.indicators?.quote?.[0]?.high      || [];
    const lows       = result.indicators?.quote?.[0]?.low       || [];
    const closes     = result.indicators?.quote?.[0]?.close     || [];
    const volumes    = result.indicators?.quote?.[0]?.volume    || [];

    const bars = [];
    timestamps.forEach((ts, i) => {
      if (!closes[i] || closes[i] <= 0) return; // skip null/zero prices
      bars.push({
        d: new Date(ts * 1000).toISOString().slice(0, 10),
        o: opens[i]   ? +opens[i].toFixed(4)   : null,
        h: highs[i]   ? +highs[i].toFixed(4)   : null,
        l: lows[i]    ? +lows[i].toFixed(4)    : null,
        c: +closes[i].toFixed(4),
        v: volumes[i] || 0
      });
    });

    return { sym, bars, count: bars.length };
  } catch (e) {
    return { sym, bars: [], error: e.message };
  }
}

// ─── Validate a symbol's data ─────────────────────────────────────────────────
function validateSymbol(sym, bars, fromDate, toDate) {
  const issues = [];

  // 1. Minimum bar count — trading days between dates
  // ~252 trading days per year, 2.5 years = ~630 expected
  // Allow 70% minimum to account for ETFs, new listings, etc.
  const daysBetween = (new Date(toDate) - new Date(fromDate)) / 86400000;
  const expectedBars = Math.round(daysBetween * 252 / 365);
  const minBars      = Math.round(expectedBars * 0.70);

  if (bars.length < minBars) {
    issues.push(`only ${bars.length} bars (expected ~${expectedBars}, minimum ${minBars})`);
  }

  // 2. Check for recent data — last bar should be within 7 days of toDate
  if (bars.length > 0) {
    const lastBar   = bars[bars.length - 1].d;
    const lastDate  = new Date(lastBar);
    const endDate   = new Date(toDate);
    const daysDiff  = Math.round((endDate - lastDate) / 86400000);
    if (daysDiff > 7) {
      issues.push(`last bar is ${lastBar} (${daysDiff} days before end date)`);
    }
  } else {
    issues.push('no bars at all');
  }

  // 3. Check for large gaps — no more than 7 consecutive missing trading days
  // (holidays cause 3-4 day gaps, more than 7 = real data gap)
  if (bars.length > 1) {
    let maxGap = 0;
    let maxGapStart = '';
    for (let i = 1; i < bars.length; i++) {
      const prev    = new Date(bars[i-1].d);
      const curr    = new Date(bars[i].d);
      const gapDays = Math.round((curr - prev) / 86400000);
      if (gapDays > maxGap) {
        maxGap      = gapDays;
        maxGapStart = bars[i-1].d;
      }
    }
    if (maxGap > 10) {
      issues.push(`gap of ${maxGap} days after ${maxGapStart}`);
    }
  }

  // 4. Check for zero/null close prices within bars
  const nullBars = bars.filter(b => !b.c || b.c <= 0).length;
  if (nullBars > 0) {
    issues.push(`${nullBars} bars with null/zero close price`);
  }

  return {
    sym,
    valid:   issues.length === 0,
    bars:    bars.length,
    issues,
    lastBar: bars.length > 0 ? bars[bars.length - 1].d : null,
    firstBar: bars.length > 0 ? bars[0].d : null
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const fromDate    = req.query.from  || '2024-01-01';
  const toDate      = req.query.to    || new Date().toISOString().slice(0, 10);
  const retrySyms   = req.query.retry ? req.query.retry.split(',').map(s => s.trim().toUpperCase()) : null;
  const symbols     = retrySyms || ALL_SYMBOLS;

  send({ type: 'start', symbols: symbols.length, from: fromDate, to: toDate, mode: retrySyms ? 'retry' : 'full' });

  try {
    // Load existing data if this is a retry (merge, don't overwrite)
    let existingData = { data: {}, symbols: ALL_SYMBOLS };
    let existingSha  = null;
    if (retrySyms) {
      const existing = await ghGet('data/historical-ohlc.json');
      if (existing?.content) {
        try {
          existingData = JSON.parse(Buffer.from(existing.content, 'base64').toString());
          existingSha  = existing.sha;
        } catch {}
      }
    }

    const result     = { ...existingData.data };
    const validation = [];
    const failed     = [];

    // Fetch in batches of 5
    for (let i = 0; i < symbols.length; i += 5) {
      const batch   = symbols.slice(i, i + 5);
      const results = await Promise.all(batch.map(sym => fetchOHLC(sym, fromDate, toDate)));

      for (const { sym, bars, error } of results) {
        // Validate
        const v = validateSymbol(sym, bars, fromDate, toDate);
        validation.push(v);

        if (error || bars.length === 0) {
          failed.push({ sym, error: error || 'no data' });
          send({ type: 'progress', sym, status: 'failed', error, validation: v });
        } else if (!v.valid) {
          // Has some data but failed validation
          result[sym] = bars; // save what we have
          failed.push({ sym, error: v.issues.join('; ') });
          send({ type: 'progress', sym, status: 'warning', bars: bars.length, issues: v.issues, validation: v });
        } else {
          result[sym] = bars;
          send({ type: 'progress', sym, status: 'ok', bars: bars.length, validation: v });
        }
      }

      if (i + 5 < symbols.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Build validation summary
    const validCount   = validation.filter(v => v.valid).length;
    const warningCount = validation.filter(v => !v.valid && result[v.sym]?.length > 0).length;
    const failCount    = validation.filter(v => !result[v.sym] || result[v.sym].length === 0).length;

    // Save to GitHub
    send({ type: 'saving', message: 'Validating complete — saving to GitHub...' });

    const existing  = retrySyms ? null : await ghGet('data/historical-ohlc.json');
    const sha       = retrySyms ? existingSha : (existing?.sha || null);

    const ohlcData = {
      generated:  new Date().toISOString(),
      from:       fromDate,
      to:         toDate,
      symbols:    ALL_SYMBOLS,
      validation: validation.reduce((acc, v) => { acc[v.sym] = v; return acc; }, {}),
      barCounts:  Object.fromEntries(ALL_SYMBOLS.map(s => [s, result[s]?.length || 0])),
      failed:     failed,
      data:       result
    };

    const totalBars = Object.values(result).reduce((sum, bars) => sum + (bars?.length || 0), 0);
    const sizeKB    = Math.round(JSON.stringify(ohlcData).length / 1024);

    const saved = await ghPut(
      'data/historical-ohlc.json',
      ohlcData,
      `Historical OHLC: ${fromDate}→${toDate} | ${validCount} valid, ${warningCount} warning, ${failCount} failed`,
      sha
    );

    send({
      type:        'complete',
      saved,
      totalSymbols: symbols.length,
      validCount,
      warningCount,
      failCount,
      failed,
      totalBars,
      sizeKB,
      from: fromDate,
      to:   toDate
    });

    res.end();
  } catch (e) {
    send({ type: 'error', message: e.message });
    res.end();
  }
};
