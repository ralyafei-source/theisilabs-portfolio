// api/score-engine.js
// THEISI Deterministic Scoring Engine — standalone Vercel route
// Reads deep-{date}.json + universe-{date}.json from the repo, scores everything,
// returns the scored JSON as plain text (Make saves it straight to scored-{date}.json).
//
// Matches the style of api/portfolio-for-ai.js (CommonJS, todayUAE, raw github fetch).
// Deploy: add this file as api/score-engine.js in the same Vercel project, then redeploy.
// Call:   POST  https://theisilabs.vercel.app/api/score-engine
//         body  {"date":"YYYY-MM-DD"}   (date optional; defaults to today UAE)
//         header Authorization: Bearer <SCORE_KEY>   (optional, set SCORE_KEY env var)

const REPO = 'ralyafei-source/theisilabs-portfolio';
const RAW  = `https://raw.githubusercontent.com/${REPO}/main`;

function todayUAE() {
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

async function getJSON(url) {
  try {
    const r = await fetch(`${url}?t=${Date.now()}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ─── ENGINE (identical math to scoring_engine.js — verified deterministic) ────
/* ============================================================================
 * THEISI DETERMINISTIC SCORING ENGINE  v1.0
 * Implements THEISI_SCORING_STANDARD_v1.md §4–§5 and OPPORTUNITY_ENGINE_BUILD_SPEC §4.
 *
 * THE GOLDEN SEPARATION: CODE computes scores. LLM only explains them.
 * This file produces scored-{date}.json. Zero API calls. Pure function of inputs.
 *
 * RUNTIME: Make.com "Run JavaScript" module (tools / "Execute JavaScript").
 *   Inputs are injected as the variable `input` (an object you map in the module):
 *     input.deep      = parsed deep-{date}.json   -> { date, count, data: { SYM: {...} } }
 *     input.universe  = parsed universe-{date}.json (eligible list + sector tags)
 *     input.portfolio = parsed portfolio holdings (array of {symbol, sector})
 *     input.date      = "YYYY-MM-DD" (UAE date string)
 *   Returns: a JSON-stringified scored payload via `output`.
 *
 * DETERMINISM RULES (Standard §4.4):
 *   - No Date.now(), no Math.random(), no Object key-order dependence in sorts.
 *   - Ties broken by symbol (stable, alphabetical) so two runs are byte-identical.
 * ========================================================================== */

// ----- CONFIG (Standard §4.3; never edit weights without amending the Standard) ----
var CONFIG = {
  LAYER_WEIGHTS: { L1: 0.30, L2: 0.20, L3: 0.20, L4: 0.15, L5: 0.15 }, // Technical, Momentum/Persistence, External/Sentiment, Valuation, Fundamental
  FIT_MODIFIER_MAX: 5,          // ± points for sector overlap with portfolio
  DISPLAY_TOP: 50,
  HIGHLIGHT_TOP: 5,
  RSI_IDEAL_UPTREND: 60,        // momentum regime sweet spot
  RSI_IDEAL_RANGE: 40,          // mean-reversion / recovery sweet spot
  CHANGE5D_IDEAL: 2.0,          // % — mild positive drift is ideal, not a spike
  SMA50_DIST_IDEAL: 3.0,        // % above SMA50 is ideal (not far extended)
  MIN_LAYERS_FOR_SCORE: 2       // need at least 2 non-NA layers to be ranked
};

// ----- helpers ---------------------------------------------------------------
function isNum(v){ return typeof v === "number" && isFinite(v); }

// cross-sectional percentile rank in [0,1]; NA values excluded, then mapped back as null
// rank = (count of values strictly less) / (N-1). Ties share the average position is avoided
// for determinism; we use "fraction below" which is stable and outlier-immune.
function percentileRank(values){
  // values: array of {sym, v} where v may be null (NA)
  var present = values.filter(function(x){ return isNum(x.v); });
  var n = present.length;
  var out = {};
  if (n === 0){ values.forEach(function(x){ out[x.sym] = null; }); return out; }
  if (n === 1){ values.forEach(function(x){ out[x.sym] = isNum(x.v) ? 1 : null; }); return out; }
  // sort ascending by value, tie-break by symbol for determinism
  present.sort(function(a,b){ return a.v - b.v || (a.sym < b.sym ? -1 : 1); });
  // assign rank by index position (lowest=0 -> 0.0, highest -> 1.0)
  for (var i=0;i<present.length;i++){ out[present[i].sym] = i/(n-1); }
  values.forEach(function(x){ if (!(x.sym in out)) out[x.sym] = null; });
  return out;
}

// shape transforms (Standard §1.2)
function distFromIdeal(v, ideal){ return isNum(v) ? -Math.abs(v - ideal) : null; } // higher (closer to 0) = better
function invert(v){ return isNum(v) ? -v : null; } // monotonic-down -> negate so higher=better

// trend-conditional RSI ideal (Standard §1.3 / §3.2)
function rsiIdeal(stock){
  var up = stock.above_sma50 === true && stock.above_sma200 === true;
  return up ? CONFIG.RSI_IDEAL_UPTREND : CONFIG.RSI_IDEAL_RANGE;
}

// ----- MAIN ------------------------------------------------------------------
function run(input){
  var date = input.date;
  var deep = (input.deep && input.deep.data) ? input.deep.data : {};
  var portfolio = Array.isArray(input.portfolio) ? input.portfolio : [];
  var portSectors = {};
  portfolio.forEach(function(p){ if(p && p.sector) portSectors[p.sector] = true; });
  var portSyms = {};
  portfolio.forEach(function(p){ if(p && p.symbol) portSyms[String(p.symbol).toUpperCase()] = true; });

  var syms = Object.keys(deep).filter(function(s){ return deep[s] && typeof deep[s]==="object"; });
  syms.sort(); // deterministic base ordering

  if (syms.length === 0){
    return JSON.stringify({ date: date, count: 0, generated_by:"theisi-scoring-engine-v1", stocks: [], error:"no deep data" });
  }

  // ---- 1. build raw indicator arrays (apply shape transforms) ----
  // Layer membership (Standard §4.3):
  // L1 Technical: rsi(sweet), dist_sma50(sweet), above_sma200(bool->1/0 monotonic-up via adx), adx(up)
  // L2 Momentum/Persistence: change5d(sweet), volume_ratio_20d(up), streak(up)
  // L3 External/Sentiment: analyst_upside_pct(up), grade_score(up), earnings_surprise(up)
  // L4 Valuation: peg(down), pe(down), ps(down), fcf_yield(up), earnings_yield(up)
  // L5 Fundamental/Quality: roic(up), net_profit_margin(up), debt_to_equity(down), interest_coverage(up), current_ratio(up)
  function col(transform){ return syms.map(function(s){ return { sym:s, v: transform(deep[s]) }; }); }

  var ind = {
    // L1
    rsi:        percentileRank(col(function(d){ return distFromIdeal(d.rsi, rsiIdeal(d)); })),
    dist_sma50: percentileRank(col(function(d){ return isNum(d.price)&&isNum(d.sma50)&&d.sma50!==0 ? distFromIdeal(((d.price-d.sma50)/d.sma50)*100, CONFIG.SMA50_DIST_IDEAL) : null; })),
    adx:        percentileRank(col(function(d){ return isNum(d.adx)? d.adx : null; })),
    williams:   percentileRank(col(function(d){ return distFromIdeal(d.williams, -50); })),
    trend:      percentileRank(col(function(d){ return (d.above_sma50===true?1:0)+(d.above_sma200===true?1:0); })),
    // L2
    change5d:   percentileRank(col(function(d){ return distFromIdeal(d.change5d, CONFIG.CHANGE5D_IDEAL); })),
    vol_ratio:  percentileRank(col(function(d){ return isNum(d.volume_ratio_20d)? d.volume_ratio_20d : null; })),
    streak:     percentileRank(col(function(d){ return isNum(d.streak)? d.streak : null; })),
    // L3 — analyst signals
    upside:     percentileRank(col(function(d){ return isNum(d.analyst_upside_pct)? d.analyst_upside_pct : null; })),
    grade:      percentileRank(col(function(d){ return isNum(d.grade_score)? d.grade_score : null; })),
    upgrade:    percentileRank(col(function(d){ return (d.recent_upgrade===true)?1:(d.recent_upgrade===false?0:null); })),
    // L4
    peg:        percentileRank(col(function(d){ return (isNum(d.peg)&&d.peg>0)? invert(d.peg) : null; })),
    pe:         percentileRank(col(function(d){ return (isNum(d.pe_ratio)&&d.pe_ratio>0)? invert(d.pe_ratio) : null; })),
    pb:         percentileRank(col(function(d){ return (isNum(d.pb)&&d.pb>0)? invert(d.pb) : null; })),
    fcf_yield:  percentileRank(col(function(d){ return isNum(d.fcf_yield)? d.fcf_yield : null; })),
    ev_ebitda:  percentileRank(col(function(d){ return (isNum(d.ev_ebitda)&&d.ev_ebitda>0)? invert(d.ev_ebitda) : null; })),
    // L5
    roic:       percentileRank(col(function(d){ return isNum(d.roic)? d.roic : null; })),
    npm:        percentileRank(col(function(d){ return isNum(d.net_margin)? d.net_margin : null; })),
    roe:        percentileRank(col(function(d){ return isNum(d.roe)? d.roe : null; })),
    de:         percentileRank(col(function(d){ return (isNum(d.debt_to_equity)&&d.debt_to_equity>=0)? invert(d.debt_to_equity) : null; })),
    int_cov:    percentileRank(col(function(d){ return isNum(d.interest_coverage)? d.interest_coverage : null; })),
    cur_ratio:  percentileRank(col(function(d){ return isNum(d.current_ratio)? d.current_ratio : null; }))
  };

  var LAYERS = {
    L1: ["rsi","dist_sma50","adx","trend","williams"],
    L2: ["change5d","vol_ratio","streak"],
    L3: ["upside","grade","upgrade"],
    L4: ["peg","pe","pb","fcf_yield","ev_ebitda"],
    L5: ["roic","npm","roe","de","int_cov","cur_ratio"]
  };

  // ---- 2. per-stock layer scores + renormalized composite (Standard §4.2 steps 4–7) ----
  var stocks = syms.map(function(sym){
    var d = deep[sym];
    var breakdown = { indicators:{}, layers:{}, na:[], renormalized_from:[] };
    var layerScores = {};
    Object.keys(LAYERS).forEach(function(L){
      var members = LAYERS[L];
      var sum=0, cnt=0;
      members.forEach(function(key){
        var p = ind[key][sym];
        if (p === null || p === undefined){ breakdown.na.push(key); breakdown.indicators[key]=null; }
        else { var pct = Math.round(p*1000)/10; breakdown.indicators[key]=pct; sum+=p; cnt++; }
      });
      if (cnt>0){ layerScores[L] = sum/cnt; breakdown.layers[L]=Math.round((sum/cnt)*1000)/10; }
      else { layerScores[L] = null; breakdown.layers[L]=null; }
    });

    // renormalize over non-NA layers only
    var wsum=0, score=0, used=0;
    Object.keys(CONFIG.LAYER_WEIGHTS).forEach(function(L){
      if (layerScores[L] !== null){ wsum += CONFIG.LAYER_WEIGHTS[L]; score += CONFIG.LAYER_WEIGHTS[L]*layerScores[L]; used++; breakdown.renormalized_from.push(L); }
    });
    var base = (wsum>0)? (score/wsum)*100 : null;

    // fit modifier (Standard §4.2 step 7): + if sector overlaps portfolio
    var fit = 0;
    if (d.sector && portSectors[d.sector]) fit = CONFIG.FIT_MODIFIER_MAX;
    var final_score = (base===null)? null : Math.round((base + fit)*10)/10;

    // classification (build spec §4.2 step 8) — descriptive tags, not scoring
    var tags = classify(d);

    return {
      symbol: sym,
      sector: d.sector || null,
      price_at_score: isNum(d.price)? d.price : null,
      final_score: final_score,
      base_score: (base===null)?null:Math.round(base*10)/10,
      fit_modifier: fit,
      pattern: tags,
      in_portfolio: !!portSyms[sym.toUpperCase()],
      data_completeness: Math.round(((22 - breakdown.na.length)/22)*100),
      layers_used: used,
      score_breakdown: breakdown
    };
  });

  // ---- 3. drop unscorable, rank deterministically (Standard §4.2 step 9) ----
  var ranked = stocks.filter(function(s){ return s.final_score!==null && s.layers_used>=CONFIG.MIN_LAYERS_FOR_SCORE; });
  ranked.sort(function(a,b){ return b.final_score - a.final_score || (a.symbol<b.symbol?-1:1); });
  ranked.forEach(function(s,i){ s.rank = i+1; s.display = i < CONFIG.DISPLAY_TOP; s.highlight = i < CONFIG.HIGHLIGHT_TOP; });

  return JSON.stringify({
    date: date,
    count: ranked.length,
    universe_size: syms.length,
    generated_by: "theisi-scoring-engine-v1",
    methodology: "cross-sectional-percentile; layers L1..L5; renormalized; deterministic",
    weights: CONFIG.LAYER_WEIGHTS,
    stocks: ranked
  });
}

// classification from real data (build spec §4.2 step 8)
function classify(d){
  var tags=[];
  var fromHigh = isNum(d.from_52w_high_pct)? d.from_52w_high_pct : null;
  var volr = isNum(d.volume_ratio_20d)? d.volume_ratio_20d : null;
  var up = d.above_sma50===true && d.above_sma200===true;
  if (fromHigh!==null && fromHigh<=-30 && fromHigh>=-80 && volr!==null && volr>1) tags.push("Recovery");
  if (fromHigh!==null && fromHigh>-10 && volr!==null && volr>1.5 && isNum(d.rsi) && d.rsi>=50 && d.rsi<=65 && up) tags.push("Breakout");
  if (up && isNum(d.rsi) && d.rsi>=50 && d.rsi<=70 && isNum(d.adx) && d.adx>25) tags.push("Momentum");
  if (isNum(d.peg) && d.peg>0 && d.peg<1.2 && isNum(d.fcf_yield) && d.fcf_yield>0) tags.push("Value");
  if (isNum(d.revenue_growth) && d.revenue_growth>0.15 && isNum(d.roic) && d.roic>0.15) tags.push("Growth");
  return tags;
}



// ─── handler ──────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // optional auth (only enforced if SCORE_KEY env var is set)
  const SCORE_KEY = process.env.SCORE_KEY;
  if (SCORE_KEY) {
    const key = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (key !== SCORE_KEY) return res.status(401).json({ error: 'Unauthorized' });
  }

  // date can come from POST body or ?date=, else today
  let date = (req.body && req.body.date) || (req.query && req.query.date) || todayUAE();

  try {
    const deep     = await getJSON(`${RAW}/data/market/deep-${date}.json`);
    const universe = await getJSON(`${RAW}/data/market/universe-${date}.json`);

    // portfolio holdings for the fit modifier + in_portfolio flag
    const port = await getJSON(`${RAW}/data/portfolio.json`);
    const portfolio = Array.isArray(port) ? port
                      : (port && port.holdings) ? port.holdings : [];

    if (!deep) {
      return res.status(404).send(JSON.stringify({ error: `deep-${date}.json not found` }));
    }

    const out = run({ date: date, deep: deep, universe: universe, portfolio: portfolio });
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(out);   // raw JSON string -> saved as-is by Make
  } catch (e) {
    return res.status(500).send(JSON.stringify({ error: e.message }));
  }
};
