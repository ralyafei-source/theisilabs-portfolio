// api/historical-snapshot.js
// Returns portfolio snapshot reconstructed for a historical date
// Usage: GET /api/historical-snapshot?date=2025-11-11&format=json
// READ-ONLY — never writes anything anywhere

const REPO    = 'ralyafei-source/theisilabs-portfolio';
const FMP_KEY = 'pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj';
const FMP     = 'https://financialmodelingprep.com/stable';
const API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';

// ─── FMP helper ──────────────────────────────────────────────────────────────
async function fmpGet(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${FMP}${path}${sep}apikey=${FMP_KEY}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.['Error Message'] || d?.error) return null;
    return Array.isArray(d) ? d : d;
  } catch { return null; }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function subtractDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── RSI-14 from array of closes (oldest first) ──────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i-1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i]; else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const g = changes[i] > 0 ? changes[i] : 0;
    const l = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period-1) + g) / period;
    avgLoss = (avgLoss * (period-1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  return +(100 - 100/(1 + avgGain/avgLoss)).toFixed(2);
}

// ─── SMA from closes (oldest first), uses last `period` values ───────────────
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return +(slice.reduce((a,b)=>a+b,0)/period).toFixed(2);
}

// ─── EMA ─────────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2/(period+1);
  let ema = closes.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i = period; i < closes.length; i++) ema = closes[i]*k + ema*(1-k);
  return +ema.toFixed(2);
}

// ─── MACD ────────────────────────────────────────────────────────────────────
function calcMACD(closes, fast=12, slow=26, sigPeriod=9) {
  if (closes.length < slow+sigPeriod) return {macd:null,signal:null,histogram:null};
  const kf=2/(fast+1), ks=2/(slow+1), ksig=2/(sigPeriod+1);
  let ef=closes.slice(0,fast).reduce((a,b)=>a+b,0)/fast;
  let es=closes.slice(0,slow).reduce((a,b)=>a+b,0)/slow;
  const macdLine=[];
  for(let i=slow;i<closes.length;i++){
    ef=closes[i]*kf+ef*(1-kf);
    es=closes[i]*ks+es*(1-ks);
    macdLine.push(ef-es);
  }
  if(macdLine.length<sigPeriod) return {macd:null,signal:null,histogram:null};
  let sig=macdLine.slice(0,sigPeriod).reduce((a,b)=>a+b,0)/sigPeriod;
  for(let i=sigPeriod;i<macdLine.length;i++) sig=macdLine[i]*ksig+sig*(1-ksig);
  const macdVal=macdLine[macdLine.length-1];
  return {macd:+macdVal.toFixed(4), signal:+sig.toFixed(4), histogram:+(macdVal-sig).toFixed(4)};
}

// ─── Get OHLC using the stable historical-price endpoint ─────────────────────
async function getHistoricalPrices(sym, targetDate) {
  const from = subtractDays(targetDate, 300); // 300 days for 200-day SMA
  const to   = targetDate;
  
  // FMP stable endpoint for historical prices
  const data = await fmpGet(`/historical-price-eod/full?symbol=${sym}&from=${from}&to=${to}&limit=300`);
  if (!data || !Array.isArray(data) || data.length === 0) {
    // Try alternative endpoint
    const data2 = await fmpGet(`/historical-prices?symbol=${sym}&from=${from}&to=${to}&limit=300`);
    if (!data2 || !Array.isArray(data2)) return [];
    return data2.sort((a,b)=>a.date>b.date?1:-1);
  }
  return data.sort((a,b)=>a.date>b.date?1:-1); // oldest first
}

// ─── Get current Yahoo price (for "what happened since") ────────────────────
async function getCurrentPrice(sym) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
      {headers:{'User-Agent':'Mozilla/5.0'}}
    );
    if(!r.ok) return null;
    const d = await r.json();
    return d?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
  } catch { return null; }
}

// ─── Signal interpretation ────────────────────────────────────────────────────
function interpretSignals(sym, price, rsi, macd, sma50, sma200, ema20) {
  const s=[];
  if(rsi!=null){ if(rsi>70) s.push(`RSI ${rsi} — OVERBOUGHT`); else if(rsi<30) s.push(`RSI ${rsi} — OVERSOLD`); else s.push(`RSI ${rsi} — neutral`); }
  if(macd.macd!=null&&macd.signal!=null){ if(macd.macd>macd.signal&&macd.histogram>0) s.push('MACD bullish crossover ↑'); else if(macd.macd<macd.signal&&macd.histogram<0) s.push('MACD bearish crossover ↓'); else s.push('MACD neutral'); }
  if(sma50!=null&&sma200!=null){ if(sma50>sma200) s.push(`Golden Cross ✅ (SMA50 ${sma50} > SMA200 ${sma200})`); else s.push(`Death Cross ⚠️ (SMA50 ${sma50} < SMA200 ${sma200})`); }
  if(price&&ema20!=null){ if(price>ema20) s.push(`Price $${price} above EMA20 (${ema20}) — short-term bullish`); else s.push(`Price $${price} below EMA20 (${ema20}) — short-term bearish`); }
  return s;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=7200, stale-while-revalidate=14400');

  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ','').trim();
  if (key && key !== API_KEY) return res.status(401).json({error:'Unauthorized'});

  const {date, format} = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({error:'date required: YYYY-MM-DD'});
  const today = new Date().toISOString().slice(0,10);
  if (date >= today) return res.status(400).json({error:'date must be in the past'});
  if (date < '2020-01-01') return res.status(400).json({error:'date must be after 2020-01-01'});

  try {
    // Load portfolio
    const raw = await fetch(`https://raw.githubusercontent.com/${REPO}/main/data/portfolio.json?t=${Date.now()}`);
    if (!raw.ok) throw new Error('Cannot read portfolio.json');
    const portfolio = await raw.json();
    const holdings  = portfolio.holdings || [];
    const symbols   = holdings.map(h=>h.sym);

    // Fetch historical OHLC for all symbols in parallel (batches of 5 to avoid timeouts)
    const allOHLC = {};
    for (let i=0; i<symbols.length; i+=5) {
      const batch = symbols.slice(i, i+5);
      const results = await Promise.all(batch.map(async sym => ({
        sym, ohlc: await getHistoricalPrices(sym, date)
      })));
      results.forEach(({sym,ohlc}) => { allOHLC[sym]=ohlc; });
    }

    // Also fetch SPY and current prices
    const [spyOHLC, currentPriceResults] = await Promise.all([
      getHistoricalPrices('SPY', date),
      Promise.all(symbols.slice(0,20).map(async sym => ({ // limit to top 20 for speed
        sym, price: await getCurrentPrice(sym)
      })))
    ]);
    const currentPrices = {};
    currentPriceResults.forEach(({sym,price}) => { if(price) currentPrices[sym]=price; });

    // Calculate technicals from OHLC
    const priceMap  = {};
    const techMap   = {};
    symbols.forEach(sym => {
      const ohlc = allOHLC[sym] || [];
      // Find price on or just before targetDate
      const entry = [...ohlc].reverse().find(d=>d.date<=date);
      priceMap[sym] = entry?.close || null;
      const closes = ohlc.map(d=>d.close).filter(Boolean);
      const price  = priceMap[sym];
      const rsi    = calcRSI(closes);
      const sma50  = calcSMA(closes,50);
      const sma200 = calcSMA(closes,200);
      const ema20  = calcEMA(closes,20);
      const macd   = calcMACD(closes);
      techMap[sym] = {
        rsi, sma50, sma200, ema20,
        macd:macd.macd, signal:macd.signal, histogram:macd.histogram,
        signals: interpretSignals(sym,price,rsi,macd,sma50,sma200,ema20)
      };
    });

    // SPY price on date
    const spyEntry = spyOHLC.length ? [...spyOHLC].reverse().find(d=>d.date<=date) : null;
    const spyPrice = spyEntry?.close;

    // Portfolio value on that date
    let totalValue = 0;
    const enriched = holdings.map(h=>{
      const price = priceMap[h.sym] || h.cost;
      const value = Math.round(h.shares*price);
      const glPct = ((price-h.cost)/h.cost*100);
      totalValue += value;
      return {...h, livePrice:price, value, glPct};
    }).sort((a,b)=>b.value-a.value);

    // Build sectors
    const sectors={tech:{label:'TECHNOLOGY',items:[]},spec:{label:'SPECULATIVE',items:[]},bio:{label:'BIOTECH',items:[]},mining:{label:'MINING',items:[]},etf:{label:'ETFs',items:[]},other:{label:'OTHER',items:[]}};
    enriched.forEach(h=>{(sectors[h.sector]||sectors.other).items.push(h);});

    // Build text (same format as portfolio-for-ai)
    let text='';
    text+=`═══════════════════════════════════════════════════════\n`;
    text+=`RASHED'S PORTFOLIO — HISTORICAL SNAPSHOT: ${date}\n`;
    text+=`⚠️  BACKTEST MODE — All data as of ${date}\n`;
    text+=`Portfolio Value on ${date}: $${totalValue.toLocaleString()} | ${holdings.length} positions\n`;
    text+=`Historical prices: ${Object.values(priceMap).filter(Boolean).length}/${symbols.length} stocks\n`;
    if(spyPrice) text+=`SPY on ${date}: $${spyPrice}\n`;
    text+=`═══════════════════════════════════════════════════════\n`;
    text+=`INVESTOR RULES:\n- UAE investor — ZERO capital gains tax\n- Cannot short/options (Wio Invest)\n- SPUS = Sharia ETF — never sell\n- Long-term growth, high risk tolerance\n`;
    text+=`═══════════════════════════════════════════════════════\n\n`;

    Object.values(sectors).forEach(sec=>{
      if(!sec.items.length) return;
      text+=`${sec.label}:\n`;
      sec.items.forEach(h=>{
        const gl=h.glPct>=0?'+':'';
        text+=`${h.sym.padEnd(6)} ${String(h.shares).padEnd(8)} sh  cost $${h.cost.toFixed(2).padEnd(8)}  price $${(h.livePrice||0).toFixed(2).padEnd(8)}  $${h.value.toLocaleString().padEnd(8)}  ${gl}${h.glPct.toFixed(1)}%\n`;
      });
      text+='\n';
    });

    text+=`TOTAL: $${totalValue.toLocaleString()}\n\n`;

    text+=`═══ MARKET INTELLIGENCE — ${date} (HISTORICAL) ═══\n\n`;
    text+=`TECHNICAL INDICATORS:\n`;
    text+=`${'SYM'.padEnd(7)} ${'RSI'.padEnd(8)} ${'MACD'.padEnd(10)} ${'SMA50'.padEnd(9)} ${'SMA200'.padEnd(9)} EMA20\n`;
    text+=`─────────────────────────────────────────────────────\n`;
    symbols.forEach(sym=>{
      const t=techMap[sym];
      text+=`${sym.padEnd(7)} ${(t.rsi!=null?String(t.rsi):'N/A').padEnd(8)} ${(t.macd!=null?String(t.macd):'N/A').padEnd(10)} ${(t.sma50!=null?String(t.sma50):'N/A').padEnd(9)} ${(t.sma200!=null?String(t.sma200):'N/A').padEnd(9)} ${t.ema20!=null?String(t.ema20):'N/A'}\n`;
    });
    text+='\nSIGNAL INTERPRETATION:\n';
    symbols.forEach(sym=>{
      const t=techMap[sym];
      if(t.signals?.length) text+=`${sym}: ${t.signals.join(' | ')}\n`;
    });
    text+=`\n═══ END HISTORICAL SNAPSHOT ═══\n`;

    if(format==='json'){
      return res.status(200).json({
        snapshotDate:date,
        totalValueOnDate:totalValue,
        spyPriceOnDate:spyPrice,
        holdings:enriched.map(h=>({
          sym:h.sym, shares:h.shares, cost:h.cost,
          priceOnDate:h.livePrice, valueOnDate:h.value, glPctAtDate:h.glPct,
          currentPrice:currentPrices[h.sym]||null,
          sector:h.sector
        })),
        technicals:techMap,
        currentPrices,
        portfolioText:text
      });
    }

    res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.status(200).send(text);

  } catch(e) {
    res.status(500).json({error:e.message});
  }
};
