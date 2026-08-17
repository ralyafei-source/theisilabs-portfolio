// api/risk.js — portfolio risk read (Vercel Cron trigger + manual)
// ---------------------------------------------------------------------------
// The exposure/exit defense the analysis pipeline never had. For each user it
// computes concentration, measured correlation, effective INDEPENDENT bets,
// beta-implied drawdown scenarios, and thesis-exit flags — then commits
// data/risk-{nick}-{date}.json. The dashboard risk card renders that file.
//
// Runs server-side: FMP works fine from Vercel (7 of your endpoints already
// call it). No dependency on any personal machine.
//
// Trigger: Vercel Cron GETs this weekly (see vercel.json). POST also works for
// manual/curl runs. Optional CRON_SECRET gate, same as cron-weekly.js.
//
// Env (all already in your project): FMP_API_KEY, GITHUB_TOKEN.
// Optional: CRON_SECRET.
// ---------------------------------------------------------------------------
'use strict';

const REPO         = 'ralyafei-source/theisilabs-portfolio';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const FMP          = process.env.FMP_API_KEY || process.env.FMP_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';
const DAYS         = 180;
const BENCH        = 'SPY';

const { holdingsFromWorkbook, buildReport } = require('./_lib/risk-core');

const uaeDate = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);

async function ghRead(path) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function ghWrite(path, data) {
  const check = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app' } });
  let sha = null;
  if (check.ok) { const ex = await check.json(); sha = ex.sha; }
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'theisilabs-app', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Risk read ${path}`, content, ...(sha && { sha }) })
  });
  return r.ok;
}

/** Latest SA workbook for a nick: prefer sa-portfolio-{nick}-{date}, fall back
 *  to the shared sa-portfolio-{date}. Returns { date, workbook } or null. */
async function latestWorkbook(nick) {
  for (let o = 0; o < 30; o++) {
    const d = new Date(Date.now() + 4 * 3600000 - o * 86400000).toISOString().slice(0, 10);
    const wb = (await ghRead(`data/sa-portfolio-${nick}-${d}.json`)) || (await ghRead(`data/sa-portfolio-${d}.json`));
    if (wb) return { date: d, workbook: wb };
  }
  return null;
}

/** Daily closes from FMP — the proven /light endpoint the rest of the code uses. */
async function fmpCloses(sym) {
  if (!FMP) return null;
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${sym}&apikey=${FMP}`,
      { headers: { 'User-Agent': 'theisi' } });
    if (!r.ok) return null;
    const j = await r.json();
    const hist = Array.isArray(j) ? j : (j.historical || []);
    const closes = hist.map(h => ({ d: h.date, c: +(h.close ?? h.price) })).filter(x => isFinite(x.c))
      .sort((a, b) => a.d < b.d ? -1 : 1).slice(-DAYS).map(x => x.c);
    return closes.length > 20 ? closes : null;
  } catch { return null; }
}

async function runOne(nick) {
  const found = await latestWorkbook(nick);
  if (!found) return { nick, ok: false, error: 'no SA workbook in 30 days' };
  const { rows } = holdingsFromWorkbook(found.workbook);
  if (!rows.length) return { nick, ok: false, error: 'no owned holdings' };

  // fetch history (concentration still works if this yields nothing)
  const closes = {};
  const syms = [...rows.map(h => h.sym), BENCH];
  const CONC = 6;
  for (let i = 0; i < syms.length; i += CONC) {
    const batch = syms.slice(i, i + CONC);
    const got = await Promise.all(batch.map(s => fmpCloses(s).then(c => [s, c])));
    got.forEach(([s, c]) => { if (c) closes[s] = c; });
  }

  const report = buildReport(rows, closes, found.workbook, { asOf: uaeDate(), saDate: found.date, bench: BENCH });
  const path = `data/risk-${nick}-${report.as_of}.json`;
  const saved = await ghWrite(path, report);
  return { nick, ok: saved, path: saved ? path : null,
           effective_independent_bets: report.correlation.effective_independent_bets ?? null,
           beta: report.concentration.portfolio_beta_24m, exits: report.exits.length };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });
  if (CRON_SECRET) {
    const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (auth !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN missing' });

  // ?nick=foo runs just one; otherwise users.json + rashed
  const only = (req.query && req.query.nick) || (req.body && req.body.nick) || null;
  let nicks;
  if (only) nicks = [String(only).toLowerCase()];
  else {
    const usersData = await ghRead('data/users.json');
    const list = Array.isArray(usersData) ? usersData : ((usersData && usersData.users) || []);
    nicks = Array.from(new Set(['rashed', ...list.map(u => String(u.nickname || u.nick || '').toLowerCase()).filter(Boolean)]));
  }

  const results = [];
  for (const nick of nicks) {
    try { results.push(await runOne(nick)); }
    catch (e) { results.push({ nick, ok: false, error: String(e && e.message || e).slice(0, 160) }); }
  }
  const ok = results.filter(x => x.ok).length;
  return res.status(200).json({ ran: nicks.length, ok, failed: nicks.length - ok, results });
};
