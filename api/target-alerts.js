// api/target-alerts.js
// Price-target proximity alerts, driven by the per-user notes targets
// (data/notes-{nick}.json → notes[SYM].target).
//
// Two modes:
//   GET /api/target-alerts                (Authorization: Bearer <session token>)
//       → { alerts:[...] } for the logged-in user. Read-only, for the dashboard.
//
//   GET /api/target-alerts?scan=1         (Authorization: Bearer <BRIEFING_API_KEY>
//                                          or  x-api-key: <BRIEFING_API_KEY>)
//       → scans ALL users, sends a Telegram message for each NEW escalation
//         (far→approaching→hit), deduped via data/target-alerts-{nick}.json.
//         Add &debug=1 to see the exact Telegram API reply per alert.
//
// Trigger: within 5% of the target ("approaching") and again when it is
// reached/crossed ("hit"). Direction (up/down target) is inferred once and
// remembered in the state file so a target set below price also works.

const https = require('https');
const { verifySession } = require('./_auth');

const REPO = 'ralyafei-source/theisilabs-portfolio';
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const NEAR_PCT = 5;
const LEVEL_RANK = { far: 0, approaching: 1, hit: 2 };

// ── GitHub JSON read (returns {json, sha}; json=null when missing) ──
function ghGetJson(path, token) {
  return new Promise((resolve) => {
    https.get({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${path}`,
      headers: { 'Authorization': `token ${token}`, 'User-Agent': 'theisilabs-app', 'Accept': 'application/vnd.github.v3+json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const f = JSON.parse(d);
          if (f && f.content) return resolve({ json: JSON.parse(Buffer.from(f.content, 'base64').toString()), sha: f.sha });
          resolve({ json: null, sha: null });
        } catch (e) { resolve({ json: null, sha: null }); }
      });
    }).on('error', () => resolve({ json: null, sha: null }));
  });
}

function ghPutJson(path, content, sha, token) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      message: `Update ${path}`,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
      ...(sha && { sha })
    });
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${path}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`, 'User-Agent': 'theisilabs-app',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
      }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.write(body); req.end();
  });
}

// ── Live price from Yahoo (no key needed) ──
function yahooPrice(sym) {
  return new Promise((resolve) => {
    https.get({
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
      headers: { 'User-Agent': UA }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(Number(JSON.parse(d).chart.result[0].meta.regularMarketPrice) || null); }
        catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Returns the ACTUAL Telegram API reply: { ok, description, error_code, status }.
function sendTelegram(chatId, text, token) {
  return new Promise((resolve) => {
    if (!chatId) return resolve({ ok: false, description: 'no telegram_chat_id on user' });
    if (!token)  return resolve({ ok: false, description: 'TELEGRAM_TOKEN env not set' });
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve({ ok: !!j.ok, description: j.description || null, error_code: j.error_code || null, status: res.statusCode }); }
        catch (e) { resolve({ ok: false, description: 'unparseable telegram response', status: res.statusCode }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, description: e.message }));
    req.write(body); req.end();
  });
}

function evaluate(price, target, prevSide) {
  const side = prevSide || (price <= target ? 'up' : 'down');
  const distPct = Math.abs(target - price) / target * 100;
  let level = 'far';
  if (side === 'up') { if (price >= target) level = 'hit'; else if (distPct <= NEAR_PCT) level = 'approaching'; }
  else               { if (price <= target) level = 'hit'; else if (distPct <= NEAR_PCT) level = 'approaching'; }
  return { side, level, distPct: +distPct.toFixed(1) };
}

function alertMsg(nick, sym, level, price, target, distPct, thesis) {
  const name = nick.charAt(0).toUpperCase() + nick.slice(1);
  const head = level === 'hit'
    ? `✅ <b>${sym} وصل هدفك السعري</b>`
    : `🎯 <b>${sym} اقترب من هدفك السعري</b>`;
  let m = `${head}\n\n`;
  m += `السعر الآن: <b>$${price.toLocaleString()}</b>\n`;
  m += `هدفك: <b>$${(+target).toLocaleString()}</b>`;
  if (level === 'approaching') m += ` (باقي ${distPct}%)`;
  m += `\n`;
  if (thesis) m += `\n📝 ${thesis}\n`;
  m += `\n<i>تنبيه معلوماتي — ليست نصيحة مالية. القرار في النهاية عندك يا ${name}.</i>`;
  return m;
}

// Build alerts for one user; in scan mode (doSend) send Telegram + persist state.
async function processUser(nick, chatId, token, tgToken, doSend, debug) {
  const { json: notesFile } = await ghGetJson(`data/notes-${nick}.json`, token);
  const notes = (notesFile && notesFile.notes) || {};
  const syms = Object.keys(notes).filter(s => notes[s] && notes[s].target != null);
  if (!syms.length) return { alerts: [], sent: 0, debug: [] };

  let stateWrap = { json: null, sha: null };
  if (doSend) stateWrap = await ghGetJson(`data/target-alerts-${nick}.json`, token);
  const states = (stateWrap.json && stateWrap.json.states) || {};

  const prices = {};
  await Promise.all(syms.map(async s => { prices[s] = await yahooPrice(s); }));

  const now = new Date().toISOString();
  const alerts = [];
  const dbg = [];
  let sent = 0, changed = false;

  for (const sym of syms) {
    const price = prices[sym];
    if (price == null) { if (debug) dbg.push({ sym, skipped: 'no price' }); continue; }
    const target = Number(notes[sym].target);
    const prev = states[sym] || null;
    const { side, level, distPct } = evaluate(price, target, prev && prev.side);

    if (level === 'approaching' || level === 'hit') {
      alerts.push({ sym, level, price: +price.toFixed(2), target, distancePct: distPct, direction: side === 'up' ? 'upside' : 'downside', thesis: notes[sym].thesis || null });
    }

    if (doSend) {
      const prevLevel = (prev && prev.level) || 'far';
      const escalated = LEVEL_RANK[level] > LEVEL_RANK[prevLevel];
      let newLevel = level, tg = null;
      if (escalated && level !== 'far') {
        tg = await sendTelegram(chatId, alertMsg(nick, sym, level, +price.toFixed(2), target, distPct, notes[sym].thesis), tgToken);
        if (tg.ok) sent++;
        else newLevel = prevLevel;   // send failed → don't advance, retry next run
      }
      states[sym] = { side, level: newLevel, price: +price.toFixed(2), sentAt: (tg && tg.ok) ? now : (prev && prev.sentAt) || null };
      changed = true;
      if (debug) dbg.push({ sym, price: +price.toFixed(2), target, level, prevLevel, escalated, telegram: tg });
    } else if (debug) {
      dbg.push({ sym, price: +price.toFixed(2), target, level });
    }
  }

  if (doSend && changed) {
    await ghPutJson(`data/target-alerts-${nick}.json`, { nickname: nick, updated: now, states }, stateWrap.sha, token);
  }
  return { alerts, sent, debug: dbg };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const githubToken = process.env.GITHUB_TOKEN;
  const BRIEFING_API_KEY = process.env.BRIEFING_API_KEY;
  const tgToken = process.env.TELEGRAM_TOKEN;
  const debug = req.query.debug === '1';

  try {
    // ── SCAN MODE (scheduled): all users, sends Telegram ──
    if (req.query.scan === '1') {
      const key = req.headers['x-api-key'] || (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!BRIEFING_API_KEY || key !== BRIEFING_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

      const { json: users } = await ghGetJson('data/users.json', githubToken);
      const list = Array.isArray(users) ? users : ((users && users.users) || []);
      let totalSent = 0; const perUser = [];
      for (const u of list) {
        const nick = (u.nickname || '').toLowerCase().trim();
        if (!nick) continue;
        const chatId = u.telegram_chat_id || null;
        const r = await processUser(nick, chatId, githubToken, tgToken, !!chatId, debug);
        totalSent += r.sent;
        const entry = { nick, alerts: r.alerts.length, sent: r.sent, telegram: !!chatId, chatId: chatId || null };
        if (debug) entry.detail = r.debug;
        perUser.push(entry);
      }
      return res.status(200).json({ ok: true, tgTokenSet: !!tgToken, scanned: list.length, sent: totalSent, users: perUser, asOf: new Date().toISOString() });
    }

    // ── DASHBOARD MODE: this user's current alerts (read-only) ──
    const user = await verifySession(req, githubToken);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const nick = (user.nickname || '').toLowerCase().trim();
    const r = await processUser(nick, null, githubToken, tgToken, false, debug);
    const out = { alerts: r.alerts, asOf: new Date().toISOString() };
    if (debug) out.detail = r.debug;
    return res.status(200).json(out);
  } catch (e) {
    console.error('target-alerts error:', e);
    return res.status(500).json({ error: e.message });
  }
};
