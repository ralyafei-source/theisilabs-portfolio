// api/portfolio-for-ai.js 
// Returns portfolio as formatted plain text for Claude
// Supports ?nickname=ahmed for per-user portfolios
// Supports ?include=intelligence for smart FMP data (earnings, targets, grades, metrics, technicals)
// Supports ?mode=build-universe (GET ?date=YYYY-MM-DD) — universe dedup/filter for scenario 922
// Default (no nickname): reads Rashed's portfolio.json
 
const REPO    = 'ralyafei-source/theisilabs-portfolio';
const UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const FMP_KEY = process.env.FMP_API_KEY || process.env.FMP_KEY || 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
const FMP     = 'https://financialmodelingprep.com/stable';

// ─── FMP helper ──────────────────────────────────────────────────────────────
async function fmpGet(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000); // 8s timeout per FMP call
    const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`, { signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) {
      if (r.status === 429) console.error(`fmpGet 429 RATE LIMIT: ${path.split('?')[0]}`);
      else if (r.status === 401) console.error(`fmpGet 401 INVALID KEY: ${path.split('?')[0]}`);
      else console.error(`fmpGet ${r.status}: ${path.split('?')[0]}`);
      return null;
    }
    const d = await r.json();
    return Array.isArray(d) ? d : (d?.Error ? null : d);
  } catch (e) {
    console.error(`fmpGet TIMEOUT/ERR: ${e.message} — ${path.split('?')[0]}`);
    return null;
  }
}

function todayUAE() {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysAheadUAE(n) {
  return new Date(Date.now() + 4 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);
}

// ─── Extract latest value from FMP indicator response ────────────────────────
function latest(arr, field) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[0]?.[field] ?? null;
}

// ─── main ────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  // ── MODE: build-universe ──────────────────────────────────────────────────
  if (req.query.mode === 'build-universe') {
    try {
      const date = req.query.date || todayUAE();

      // Read raw screener file that Make.com saved to GitHub
      const rawUrl = `https://raw.githubusercontent.com/${REPO}/main/data/market/screener-raw-${date}.json?t=${Date.now()}`;
      const rawRes = await fetch(rawUrl);
      if (!rawRes.ok) {
        console.error(`build-universe: screener-raw-${date}.json not found (${rawRes.status})`);
        return res.status(404).json({ error: `screener-raw-${date}.json not found — run screener step first` });
      }
      const rawData = await rawRes.json();
      let large    = Array.isArray(rawData.large)    ? rawData.large    : [];
      let mid      = Array.isArray(rawData.mid)      ? rawData.mid      : [];
      let momentum = Array.isArray(rawData.momentum) ? rawData.momentum : [];
      console.log(`build-universe: read from GitHub — large:${large.length} mid:${mid.length} momentum:${momentum.length}`);

      const MIN_DOLLAR_VOLUME = 5_000_000;
      const MAX_UNIVERSE      = 800;

      // Step 1: Union
      const all = [...large, ...mid, ...momentum];
      console.log(`build-universe: raw union=${all.length} (large:${large.length} mid:${mid.length} momentum:${momentum.length})`);

      // Debug: log first stock to verify field names
      if (all.length > 0) {
        console.log(`build-universe: sample stock fields = ${Object.keys(all[0]).join(', ')}`);
        console.log(`build-universe: sample price=${all[0].price} volume=${all[0].volume}`);
      }

      // Step 2: Dedupe by symbol (drop foreign listings with '.')
      const bySymbol = {};
      for (const stock of all) {
        const sym = stock.symbol;
        if (!sym || sym.includes('.')) continue;
        const existing = bySymbol[sym];
        if (!existing || (stock.volume || 0) > (existing.volume || 0)) {
          bySymbol[sym] = stock;
        }
      }
      const afterDedup = Object.values(bySymbol);
      console.log(`build-universe: after dedupe=${afterDedup.length}`);

      // Step 3: Dollar-volume floor ($5M/day)
      const filtered = afterDedup.filter(s =>
        (s.price || 0) * (s.volume || 0) >= MIN_DOLLAR_VOLUME
      );
      console.log(`build-universe: after dollar-vol=${filtered.length}`);

      // Step 4: Fail loud if oversized
      if (filtered.length > MAX_UNIVERSE) {
        console.error(`build-universe OVERSIZED: ${filtered.length} — gate too loose?`);
      }

      // Step 5: Sort stable — marketCap desc, ties broken alphabetically
      filtered.sort((a, b) => {
        const d = (b.marketCap || 0) - (a.marketCap || 0);
        return d !== 0 ? d : (a.symbol || '').localeCompare(b.symbol || '');
      });

      // Step 6: Clean output
      const universe = filtered.slice(0, MAX_UNIVERSE).map(s => ({
        symbol:      s.symbol,
        companyName: s.companyName || '',
        marketCap:   s.marketCap   || 0,
        price:       s.price       || 0,
        volume:      s.volume      || 0,
        sector:      s.sector      || '',
        industry:    s.industry    || '',
        beta:        s.beta        || 0,
        exchange:    s.exchange    || ''
      }));

      const today = date || todayUAE();

      return res.status(200).json({
        date:  today,
        count: universe.length,
        source_counts: {
          large:            large.length,
          mid:              mid.length,
          momentum:         momentum.length,
          raw_union:        all.length,
          after_dedup:      afterDedup.length,
          after_dollar_vol: filtered.length
        },
        universe
      });

    } catch (err) {
      console.error('build-universe FATAL:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────


  // ── MODE: get-chunks ─────────────────────────────────────────────────────
  // GET ?mode=get-chunks&date=YYYY-MM-DD
  // Reads universe-{date}.json, returns array of 100-symbol batch strings
  // Step 2 of Build Spec v1.1 — called once by Make.com before Iterator
  if (req.query.mode === 'get-chunks') {
    try {
      const date = req.query.date || todayUAE();
      const url = `https://raw.githubusercontent.com/${REPO}/main/data/market/universe-${date}.json?t=${Date.now()}`;
      const r = await fetch(url);
      if (!r.ok) return res.status(404).json({ error: `universe-${date}.json not found` });
      const universe = await r.json();
      const symbols = (universe.universe || []).map(s => s.symbol).filter(Boolean);
      if (symbols.length === 0) return res.status(400).json({ error: 'universe is empty' });

      const CHUNK_SIZE = parseInt(req.query.chunk_size || '25', 10);
      const chunks = [];
      for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
        chunks.push(symbols.slice(i, i + CHUNK_SIZE).join(','));
      }
      console.log(`get-chunks: ${symbols.length} symbols → ${chunks.length} chunks of ${CHUNK_SIZE}`);
      return res.status(200).json({ date, total_symbols: symbols.length, chunk_count: chunks.length, chunks });
    } catch (err) {
      console.error('get-chunks FATAL:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── MODE: deep-chunk ─────────────────────────────────────────────────────
  // GET ?mode=deep-chunk&symbols=SYM1,...,SYM50&date=YYYY-MM-DD
  // Lean fetch: only what the scorer needs. Fast enough for 50 symbols in <10s.
  // Merges into deep-{date}.json on GitHub directly.
  if (req.query.mode === 'deep-chunk') {
    try {
      const date         = req.query.date    || todayUAE();
      const symbolsParam = req.query.symbols || '';
      if (!symbolsParam) return res.status(400).json({ error: 'symbols parameter required' });

      const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
      if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN env var not set' });

      const syms = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);
      console.log(`deep-chunk: fetching ${syms.length} symbols for ${date}`);

      // ── Fetch scorer-critical fields only — 5 FMP calls per symbol ────────
      // Keeping calls minimal to stay within Vercel 60s timeout
      // Yahoo price fetched separately (non-FMP, fast)
      const results = await Promise.all(syms.map(async s => {

        // Price + 5d change from Yahoo — with 5s timeout to prevent hangs
        let price = null, change5d = null;
        try {
          const controller = new AbortController();
          const yahooTimeout = setTimeout(() => controller.abort(), 5000);
          const yr = await fetch(
            `https://query2.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=5d`,
            { headers: { 'User-Agent': UA }, signal: controller.signal }
          );
          clearTimeout(yahooTimeout);
          if (yr.ok) {
            const yd = await yr.json();
            const result = yd?.chart?.result?.[0];
            price = result?.meta?.regularMarketPrice || null;
            const closes = result?.indicators?.quote?.[0]?.close || [];
            const validCloses = closes.filter(c => c != null);
            if (validCloses.length >= 2)
              change5d = +((validCloses[validCloses.length-1] - validCloses[0]) / validCloses[0] * 100).toFixed(2);
          }
        } catch { /* silent — timeout or error, price stays null */ }

        // 8 FMP calls per symbol — all parallel
        // Includes Step 3 additions: ADX, Williams, 52w high/low, volume ratio
        const [rsiD, sma50D, sma200D, adxD, williamsD, histD, ratiosD, metricsD] = await Promise.all([
          fmpGet(`/technical-indicators/rsi?symbol=${s}&periodLength=14&timeframe=1day&limit=3`),
          fmpGet(`/technical-indicators/sma?symbol=${s}&periodLength=50&timeframe=1day&limit=1`),
          fmpGet(`/technical-indicators/sma?symbol=${s}&periodLength=200&timeframe=1day&limit=1`),
          fmpGet(`/technical-indicators/adx?symbol=${s}&periodLength=14&timeframe=1day&limit=1`),
          fmpGet(`/technical-indicators/williams?symbol=${s}&periodLength=14&timeframe=1day&limit=3`),
          fmpGet(`/historical-price-eod/light?symbol=${s}&limit=252`),  // ~1 year of trading days
          fmpGet(`/ratios-ttm?symbol=${s}`),
          fmpGet(`/key-metrics-ttm?symbol=${s}`)
        ]);

        const sma50  = latest(sma50D,  'sma');
        const sma200 = latest(sma200D, 'sma');
        const r = Array.isArray(ratiosD)  ? ratiosD[0]  : ratiosD;
        const m = Array.isArray(metricsD) ? metricsD[0] : metricsD;

        // ── Compute 52w high/low pct from historical prices ─────────────────
        let from_52w_high_pct = null, from_52w_low_pct = null, volume_ratio_20d = null;
        // FMP historical endpoint returns {symbol, historical:[...]} not plain array
        const histArr = Array.isArray(histD) ? histD : (histD?.historical || []);
        if (histArr.length > 0 && price) {
          const prices = histArr.map(d => d.close || d.adjClose).filter(Boolean);
          const volumes = histArr.map(d => d.volume).filter(v => v != null && v > 0);
          if (prices.length > 0) {
            const high52 = Math.max(...prices);
            const low52  = Math.min(...prices);
            from_52w_high_pct = +((price - high52) / high52 * 100).toFixed(2);
            from_52w_low_pct  = +((price - low52)  / low52  * 100).toFixed(2);
          }
          // Volume ratio: today vs 20-day average
          if (volumes.length >= 20) {
            const avg20 = volumes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
            const todayVol = volumes[0];
            if (avg20 > 0) volume_ratio_20d = +(todayVol / avg20).toFixed(3);
          }
        }

        return [s, {
          symbol:    s,
          price,
          change5d,
          rsi:       latest(rsiD, 'rsi'),
          sma50,
          sma200,
          above_sma50:  price && sma50  ? price > sma50  : null,
          above_sma200: price && sma200 ? price > sma200 : null,
          golden_cross: sma50 && sma200 ? sma50 > sma200 : null,
          // Step 3 additions
          adx:              latest(adxD,      'adx')     ?? null,
          williams:         latest(williamsD, 'williams') ?? null,
          from_52w_high_pct,
          from_52w_low_pct,
          volume_ratio_20d,
          // Ratios TTM
          pe_ratio:       r?.priceToEarningsRatioTTM        ?? null,
          peg:            r?.priceToEarningsGrowthRatioTTM  ?? null,
          pb:             r?.priceToBookRatioTTM            ?? null,
          net_margin:     r?.netProfitMarginTTM             ?? null,
          gross_margin:   r?.grossProfitMarginTTM           ?? null,
          debt_to_equity: r?.debtToEquityRatioTTM          ?? null,
          current_ratio:  r?.currentRatioTTM               ?? null,
          interest_coverage: r?.interestCoverageRatioTTM   ?? null,
          // Key metrics TTM
          roic:      m?.returnOnInvestedCapitalTTM ?? null,
          roe:       m?.returnOnEquityTTM          ?? null,
          fcf_yield: m?.freeCashFlowYieldTTM       ?? null,
          ev_ebitda: m?.evToEBITDATTM              ?? null
        }];
      }));

      const batchData = Object.fromEntries(results);

      const nullPrices = results.filter(([,d]) => d.price === null).length;
      if (nullPrices > 0) console.error(`deep-chunk: ${nullPrices}/${syms.length} symbols missing price`);
      console.log(`deep-chunk: batch done — ${syms.length} symbols, ${nullPrices} missing price`);

      // ── Read existing deep file ───────────────────────────────────────────
      const deepPath = `data/market/deep-${date}.json`;
      const ghUrl    = `https://api.github.com/repos/${REPO}/contents/${deepPath}`;
      const ghRes    = await fetch(ghUrl, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}` } });

      let existingData = {}, sha = null;
      if (ghRes.ok) {
        const ghJson = await ghRes.json();
        sha = ghJson.sha;
        try {
          const decoded = Buffer.from(ghJson.content.replace(/\n/g, ''), 'base64').toString('utf-8');
          existingData = JSON.parse(decoded).data || {};
        } catch (e) { console.error('deep-chunk: parse error on existing file:', e.message); }
      }

      // ── Merge and save ────────────────────────────────────────────────────
      const merged  = { ...existingData, ...batchData };
      const outJson = JSON.stringify({ date, count: Object.keys(merged).length, data: merged });

      const saveRes = await fetch(ghUrl, {
        method:  'PUT',
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message: `Deep data ${date} (${Object.keys(merged).length} symbols)`,
          content: Buffer.from(outJson).toString('base64'),
          ...(sha ? { sha } : {})
        })
      });

      if (!saveRes.ok) {
        const errText = await saveRes.text();
        console.error('deep-chunk: GitHub save failed:', errText.slice(0, 300));
        return res.status(500).json({ error: 'GitHub save failed', detail: errText.slice(0, 300) });
      }

      return res.status(200).json({ ok: true, date, batch_size: syms.length, total_so_far: Object.keys(merged).length });

    } catch (err) {
      console.error('deep-chunk FATAL:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Auth check
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ', '').trim();
  if (key && key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { nickname, include } = req.query;
  const wantIntelligence = include === 'intelligence';

  try {
    let holdings = [];
    let cash = {};
    let investorName = 'Rashed';
    let isGenericUser = false;

    if (nickname && nickname !== 'rashed') {
      // ── Per-user portfolio ──
      investorName = nickname.charAt(0).toUpperCase() + nickname.slice(1);
      isGenericUser = true;
      const FILE = `data/portfolio-${nickname}.json`;
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/${FILE}?t=${Date.now()}`
      );
      if (!raw.ok) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(`Portfolio for ${investorName} is empty or not found.\nNo stocks to analyze.`);
      }
      const portfolio = await raw.json();
      const userStocks = portfolio.stocks || [];
      if (userStocks.length === 0) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(`Portfolio for ${investorName} is empty.\nNo stocks to analyze.`);
      }
      holdings = userStocks.map(s => ({
        sym: s.sym, shares: s.shares || (s.mv / s.cost),
        cost: s.cost, sector: s.sec || 'tech', name: s.en || s.sym
      }));

    } else {
      // ── Rashed's portfolio (default) ──
      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/data/portfolio.json?t=${Date.now()}`
      );
      if (!raw.ok) throw new Error('Cannot read portfolio.json');
      const portfolio = await raw.json();
      holdings = portfolio.holdings || [];
      cash = portfolio.cash_summary || {};
    }

    const symbols  = holdings.map(h => h.sym);
    const ownedSet = new Set(symbols);

    // ── Live prices (Yahoo Finance) ──────────────────────────────────────────
    const priceMap = {};
    const priceResults = await Promise.all(
      symbols.map(async sym => {
        try {
          const r = await fetch(
            `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
            { headers: { 'User-Agent': UA } }
          );
          if (!r.ok) return { sym, price: null };
          const d = await r.json();
          return { sym, price: d?.chart?.result?.[0]?.meta?.regularMarketPrice || null };
        } catch { return { sym, price: null }; }
      })
    );
    priceResults.forEach(({ sym, price }) => { priceMap[sym] = price; });

    // ── Calculate totals ─────────────────────────────────────────────────────
    let totalValue = 0;
    const enriched = holdings.map(h => {
      const price = priceMap[h.sym] || h.cost;
      const value = Math.round(h.shares * price);
      const glPct = ((price - h.cost) / h.cost * 100);
      totalValue += value;
      return { ...h, livePrice: price, value, glPct };
    });
    enriched.sort((a, b) => b.value - a.value);

    // ── Group by sector ──────────────────────────────────────────────────────
    const sectors = {
      tech:   { label: 'TECHNOLOGY',  items: [] },
      spec:   { label: 'SPECULATIVE', items: [] },
      bio:    { label: 'BIOTECH',     items: [] },
      mining: { label: 'MINING',      items: [] },
      etf:    { label: 'ETFs',        items: [] },
      other:  { label: 'OTHER',       items: [] },
    };
    enriched.forEach(h => { (sectors[h.sector] || sectors.other).items.push(h); });

    // ── Format portfolio text ────────────────────────────────────────────────
    const pricesAvailable = Object.values(priceMap).filter(Boolean).length;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    let text = '';
    text += `═══════════════════════════════════════════════════════\n`;
    text += `${investorName.toUpperCase()}'S PORTFOLIO — Live as of ${timestamp}\n`;
    text += `Total Value: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
    text += `Live prices: ${pricesAvailable}/${symbols.length} stocks updated\n`;
    text += `═══════════════════════════════════════════════════════\n`;

    if (!isGenericUser) {
      text += `INVESTOR RULES (apply to all recommendations):\n`;
      text += `- UAE investor — ZERO capital gains tax on profits\n`;
      text += `- Cannot short sell or trade options (Wio Invest)\n`;
      text += `- SPUS = Sharia-compliant ETF — never recommend selling\n`;
      text += `- US market opens 5:30pm UAE time\n`;
      text += `- Long-term growth investor, high risk tolerance\n`;
    } else {
      text += `INVESTOR: ${investorName}, UAE investor\n`;
      text += `- Long-term growth focus\n`;
    }
    text += `═══════════════════════════════════════════════════════\n\n`;

    Object.values(sectors).forEach(sec => {
      if (sec.items.length === 0) return;
      text += `${sec.label}:\n`;
      sec.items.forEach(h => {
        const glSign = h.glPct >= 0 ? '+' : '';
        text += `${h.sym.padEnd(6)} ${String(h.shares).padEnd(10)} sh  `;
        text += `cost $${String(h.cost.toFixed(2)).padEnd(8)}  `;
        text += `now $${String(h.livePrice.toFixed(2)).padEnd(8)}  `;
        text += `value $${h.value.toLocaleString().padEnd(8)}  `;
        text += `${glSign}${h.glPct.toFixed(1)}%\n`;
      });
      text += '\n';
    });

    text += `═══════════════════════════════════════════════════════\n`;
    text += `TOTAL PORTFOLIO VALUE: $${totalValue.toLocaleString()}\n`;
    if (!isGenericUser && cash.fresh_cash_deposited) {
      text += `Fresh cash available: $${cash.fresh_cash_deposited?.toLocaleString() || 0}\n`;
      text += `Investable cash: $${cash.investable_cash?.toLocaleString() || 0}\n`;
    }
    text += `═══════════════════════════════════════════════════════\n`;

    // ── Intelligence block ───────────────────────────────────────────────────
    if (wantIntelligence) {
      const allSyms  = symbols;
      const moverSyms = [];
      const top10    = symbols.slice(0, 10);

      const [
        earningsRaw,
        targetResults,
        gradeResults,
        metricResults,
        rsiResults,
        macdResults,
        sma50Results,
        sma200Results,
        ema20Results,
        bbResults
      ] = await Promise.all([

        // Analyst & fundamental data
        fmpGet(`/earnings-calendar?from=${todayUAE()}&to=${daysAheadUAE(60)}&symbol=${allSyms.join(',')}`),
        Promise.all(top10.map(sym => fmpGet(`/price-target-consensus?symbol=${sym}`))),
        Promise.all(top10.map(sym => fmpGet(`/grades?symbol=${sym}&limit=3`))),
        Promise.all(top10.map(sym => fmpGet(`/key-metrics-ttm?symbol=${sym}`))),

        // Technical indicators — ALL portfolio stocks
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/rsi?symbol=${sym}&periodLength=14&timeframe=1day&limit=1`)
            .then(d => ({ sym, rsi: latest(d, 'rsi') }))
        )),
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/macd?symbol=${sym}&fastPeriod=12&slowPeriod=26&signalPeriod=9&timeframe=1day&limit=1`)
            .then(d => ({ sym, macd: latest(d, 'macd'), signal: latest(d, 'signal'), histogram: latest(d, 'histogram') }))
        )),
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=50&timeframe=1day&limit=1`)
            .then(d => ({ sym, sma50: latest(d, 'sma') }))
        )),
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/sma?symbol=${sym}&periodLength=200&timeframe=1day&limit=1`)
            .then(d => ({ sym, sma200: latest(d, 'sma') }))
        )),
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/ema?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`)
            .then(d => ({ sym, ema20: latest(d, 'ema') }))
        )),
        Promise.all(symbols.map(sym =>
          fmpGet(`/technical-indicators/standardDeviation?symbol=${sym}&periodLength=20&timeframe=1day&limit=1`)
            .then(d => ({ sym, stddev: latest(d, 'standardDeviation') }))
        ))

      ]);

      // ── Build technical signals summary per stock ─────────────────────────
      const techMap = {};
      symbols.forEach(sym => { techMap[sym] = {}; });

      rsiResults.forEach(   ({ sym, rsi })                     => { if (techMap[sym]) techMap[sym].rsi = rsi !== null ? +rsi.toFixed(2) : null; });
      macdResults.forEach(  ({ sym, macd, signal, histogram }) => {
        if (techMap[sym]) {
          techMap[sym].macd      = macd      !== null ? +macd.toFixed(4)      : null;
          techMap[sym].signal    = signal    !== null ? +signal.toFixed(4)    : null;
          techMap[sym].histogram = histogram !== null ? +histogram.toFixed(4) : null;
        }
      });
      sma50Results.forEach( ({ sym, sma50 })  => { if (techMap[sym]) techMap[sym].sma50  = sma50  !== null ? +sma50.toFixed(2)  : null; });
      sma200Results.forEach(({ sym, sma200 }) => { if (techMap[sym]) techMap[sym].sma200 = sma200 !== null ? +sma200.toFixed(2) : null; });
      ema20Results.forEach( ({ sym, ema20 })  => { if (techMap[sym]) techMap[sym].ema20  = ema20  !== null ? +ema20.toFixed(2)  : null; });
      bbResults.forEach(    ({ sym, stddev }) => {
        if (techMap[sym] && stddev !== null && priceMap[sym]) {
          const mid = techMap[sym].sma20 || priceMap[sym];
          techMap[sym].bb_upper = +(priceMap[sym] + 2 * stddev).toFixed(2);
          techMap[sym].bb_lower = +(priceMap[sym] - 2 * stddev).toFixed(2);
          techMap[sym].bb_stddev = +stddev.toFixed(4);
        }
      });

      // ── Add plain-language signal interpretation ──────────────────────────
      Object.entries(techMap).forEach(([sym, t]) => {
        const price = priceMap[sym];
        const signals = [];

        if (t.rsi !== null) {
          if (t.rsi > 70)      signals.push(`RSI ${t.rsi} — OVERBOUGHT`);
          else if (t.rsi < 30) signals.push(`RSI ${t.rsi} — OVERSOLD`);
          else                 signals.push(`RSI ${t.rsi} — neutral`);
        }

        if (t.macd !== null && t.signal !== null) {
          if (t.macd > t.signal && t.histogram > 0) signals.push('MACD bullish crossover ↑');
          else if (t.macd < t.signal && t.histogram < 0) signals.push('MACD bearish crossover ↓');
          else signals.push('MACD neutral');
        }

        if (t.sma50 !== null && t.sma200 !== null) {
          if (t.sma50 > t.sma200) signals.push('Golden Cross ✅ (SMA50 > SMA200)');
          else signals.push('Death Cross ⚠️ (SMA50 < SMA200)');
        }

        if (price && t.ema20 !== null) {
          if (price > t.ema20) signals.push(`Price above EMA20 (${t.ema20}) — short-term bullish`);
          else signals.push(`Price below EMA20 (${t.ema20}) — short-term bearish`);
        }

        if (t.bb_upper && t.bb_lower && price) {
          const bbWidth = t.bb_upper - t.bb_lower;
          if (price >= t.bb_upper)      signals.push(`At BB upper band (${t.bb_upper}) — extended`);
          else if (price <= t.bb_lower) signals.push(`At BB lower band (${t.bb_lower}) — compressed`);
          else {
            const bbPct = ((price - t.bb_lower) / bbWidth * 100).toFixed(0);
            signals.push(`BB position: ${bbPct}% (lower=${t.bb_lower}, upper=${t.bb_upper})`);
          }
        }

        t.signals = signals;
      });

      // ── Flatten analyst results ───────────────────────────────────────────
      const earnings = earningsRaw || [];
      const targets  = targetResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));
      const grades   = gradeResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));
      const metrics  = metricResults.flat().filter(Boolean).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}));

      const earningsSorted = (earnings || []).map(i => ({...i, inPortfolio: ownedSet.has(i.symbol)}))
        .sort((a, b) => {
          if (a.inPortfolio && !b.inPortfolio) return -1;
          if (!a.inPortfolio && b.inPortfolio) return 1;
          return new Date(a.date) - new Date(b.date);
        });

      // ── Append intelligence block ─────────────────────────────────────────
      text += `\n═══════════════════════════════════════════════════════\n`;
      text += `MARKET INTELLIGENCE — ${todayUAE()}\n`;
      text += `Portfolio symbols: ${symbols.join(', ')}\n`;
      text += `Market movers tracked: ${moverSyms.join(', ') || 'none yet'}\n`;
      text += `═══════════════════════════════════════════════════════\n\n`;

      // Technical indicators — formatted as a readable table for Claude
      text += `TECHNICAL INDICATORS (all ${symbols.length} portfolio stocks):\n`;
      text += `${'SYM'.padEnd(7)} ${'RSI'.padEnd(8)} ${'MACD'.padEnd(10)} ${'SMA50'.padEnd(9)} ${'SMA200'.padEnd(9)} ${'EMA20'.padEnd(9)} BB_UPPER / BB_LOWER\n`;
      text += `─────────────────────────────────────────────────────────────────────────────\n`;
      symbols.forEach(sym => {
        const t = techMap[sym];
        text += `${sym.padEnd(7)} `;
        text += `${(t.rsi    !== null ? String(t.rsi)    : 'N/A').padEnd(8)} `;
        text += `${(t.macd   !== null ? String(t.macd)   : 'N/A').padEnd(10)} `;
        text += `${(t.sma50  !== null ? String(t.sma50)  : 'N/A').padEnd(9)} `;
        text += `${(t.sma200 !== null ? String(t.sma200) : 'N/A').padEnd(9)} `;
        text += `${(t.ema20  !== null ? String(t.ema20)  : 'N/A').padEnd(9)} `;
        text += `${t.bb_upper || 'N/A'} / ${t.bb_lower || 'N/A'}\n`;
      });
      text += `\n`;

      // Signal interpretation — plain English for Claude
      text += `SIGNAL INTERPRETATION:\n`;
      symbols.forEach(sym => {
        const t = techMap[sym];
        if (t.signals && t.signals.length > 0) {
          text += `${sym}: ${t.signals.join(' | ')}\n`;
        }
      });
      text += `\n`;

      text += `EARNINGS CALENDAR (next 60 days — portfolio stocks first):\n`;
      text += JSON.stringify({
        portfolio: earningsSorted.filter(e => e.inPortfolio),
        movers:    earningsSorted.filter(e => !e.inPortfolio).slice(0, 10)
      }, null, 2) + '\n\n';

      text += `ANALYST PRICE TARGETS:\n`;
      text += JSON.stringify(targets, null, 2) + '\n\n';

      text += `ANALYST GRADES (recent):\n`;
      text += JSON.stringify(grades, null, 2) + '\n\n';

      text += `KEY METRICS TTM (P/E, ROE, margins etc):\n`;
      text += JSON.stringify(metrics, null, 2) + '\n';

      text += `\n═══════════════════════════════════════════════════════\n`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch (e) {
    res.status(500).send(`Portfolio data unavailable: ${e.message}`);
  }
};
