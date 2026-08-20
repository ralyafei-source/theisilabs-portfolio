#!/usr/bin/env node
/**
 * THEISI watchdog — asserts the invariants that would have caught every problem
 * found in the 2026-08-16 audit, on the day it started rather than weeks later.
 *
 * WHY THIS SHAPE
 * THEISI's characteristic failure is not a crash. It is a component that returns
 * HTTP 200, writes nothing, and is never noticed:
 *   · five `?mode=` calls in 922 silently fell through to a plain-text response
 *     — the universe/scoring subsystem has been dead since 2026-06-17
 *   · deep-read threw a TypeError swallowed by a try/catch — dead ~6 weeks
 *   · a 977 route silently stopped committing its output in June
 *   · the SA workbook went 13 days stale with nothing complaining
 * Uptime checks would have reported all four as healthy. Artifact assertions do not.
 *
 * WHERE IT RUNS
 * GitHub Actions, deliberately — NOT the local node and NOT Vercel. A monitor that
 * shares a failure domain with the thing it monitors is not a monitor. Actions is
 * free, always on, and cannot be asleep.
 *
 * NO SECRETS NEEDED for the checks: every read is a public raw.githubusercontent
 * fetch. Only the Telegram alert uses a secret. Nothing sensitive is printed —
 * this repo is public, so Actions logs are public too.
 *
 *   node watchdog/watchdog.js            # human output, exit 1 on failure
 *   node watchdog/watchdog.js --json     # machine output
 */

'use strict';

const REPO = process.env.THEISI_REPO_SLUG || 'ralyafei-source/theisilabs-portfolio';
const BRANCH = process.env.THEISI_BRANCH || 'main';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const API = `https://api.github.com/repos/${REPO}`;

const UAE_OFFSET_MS = 4 * 3600 * 1000;
const uaeDate = (offsetDays = 0) =>
  new Date(Date.now() + UAE_OFFSET_MS - offsetDays * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const results = [];
const add = (severity, name, ok, detail) => results.push({ severity, name, ok, detail });
const FAIL = 'fail', WARN = 'warn';

async function raw(path) {
  try {
    const r = await fetch(`${RAW}/${path}?t=${Date.now()}`);
    if (!r.ok) return null;
    const txt = await r.text();
    try { return JSON.parse(txt); } catch { return txt; }
  } catch { return null; }
}

/**
 * List a directory via the contents API.
 * Unauthenticated GitHub allows only 60 requests/hour, which silently returns 403
 * and made three checks report "none found" on the first live run. Actions supplies
 * GITHUB_TOKEN automatically (1000/hr); locally set GH_TOKEN. Returns null — NOT an
 * empty array — when the listing genuinely could not be fetched, so a rate limit is
 * never mistaken for "the file does not exist".
 */
async function listDir(path) {
  const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  try {
    const r = await fetch(`${API}/contents/${path}?ref=${BRANCH}`, {
      headers: Object.assign({ 'Accept': 'application/vnd.github+json' },
                             tok ? { Authorization: `Bearer ${tok}` } : {})
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j.map(x => x.name) : null;
  } catch { return null; }
}

/** Fallback when listing is unavailable: probe dated filenames backwards over raw. */
async function probeNewest(makePath, maxDays) {
  for (let o = 0; o <= maxDays; o++) {
    const d = uaeDate(o);
    if (await raw(makePath(d)) !== null) return { latest: d, ageDays: o };
  }
  return { latest: null, ageDays: null };
}

/** Newest dated file matching `prefix` in `dir`, and its age in days. */
function newestDated(names, prefix) {
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d{4}-\\d{2}-\\d{2})');
  const dates = names.map(n => (n.match(re) || [])[1]).filter(Boolean).sort();
  const latest = dates[dates.length - 1] || null;
  return { latest, ageDays: latest ? daysBetween(latest, uaeDate()) : null };
}

// ── 1. Daily pipeline produced today's artifacts ───────────────────────────
async function checkDaily() {
  // Check the last cycle that SHOULD have completed, not the wall-clock date.
  // 922 runs 03:00 and 977 07:00 UAE; before ~08:00 today's cycle isn't done, so
  // a manual run at 00:50 would otherwise false-alarm on files that aren't due yet.
  const uaeHour = Number(new Date(Date.now() + UAE_OFFSET_MS).toISOString().slice(11, 13));
  const today = uaeHour < 8 ? uaeDate(1) : uaeDate();
  // the file wraps its payload: {current:{date,status,ready_for_consumers},recent_healthy:[]}
  const raw0 = await raw('data/system/collector-status.json');
  const status = (raw0 && raw0.current) || raw0;
  add(FAIL, 'collector status is today and ready',
      !!(status && status.ready_for_consumers && String(status.date || '').startsWith(today)),
      status ? `date=${status.date} ready=${status.ready_for_consumers}` : 'file missing');

  for (const [label, path] of [['market data', `data/market/market-${today}.json`],
                               ['news feed',   `data/market/news-${today}.json`]]) {
    add(FAIL, `922 wrote today's ${label}`, !!(await raw(path)), path);
  }

  // per-user brief + narrative from 977
  const users = await raw('data/users.json');
  const nicks = Array.isArray(users) ? users.map(u => u.nickname)
              : (users && users.users || []).map(u => u.nickname);
  for (const n of nicks.filter(Boolean)) {
    const brief = await raw(`data/market/brief-${n}-${today}.json`);
    add(FAIL, `977 wrote today's brief for ${n}`, !!brief, `brief-${n}-${today}.json`);
  }
}

// ── 2. Inputs are fresh, not merely present ────────────────────────────────
async function checkFreshness() {
  const root = await listDir('data');
  const sa = root ? newestDated(root, 'sa-portfolio-')
                  : await probeNewest(d => `data/sa-portfolio-${d}.json`, 45);
  add(sa.ageDays !== null && sa.ageDays > 14 ? FAIL : WARN,
      'SA workbook is fresh (manual upload)',
      sa.ageDays !== null && sa.ageDays <= 7,
      sa.latest ? `latest ${sa.latest} · ${sa.ageDays}d old (warn >7, fail >14)` : 'none found');

  // CORRECTED 2026-08-16 after reading the 977 blueprint. The brief (M51->M11)
  // and the dashboard (index.html) BOTH read data/market/news-{date}.json — the
  // fresh feed 922 writes. The earlier belief that 977 consumed the stale
  // data/news.json was wrong: that file is an orphan (977 Route 0 writes it,
  // nothing live reads it). So the check that matters is that TODAY's real feed
  // exists — already covered by checkDaily — plus a low-severity note if the
  // orphan is still lying around, since a future edit could wire it back in.
  // The brief reads news-{date}. checkDaily already asserts TODAY strictly (it
  // runs post-pipeline); here we only confirm the feed is RECENT, so running the
  // watchdog before 922's daily run doesn't false-alarm. A 2-day gap is real trouble.
  let feedFound = null;
  for (let o = 0; o <= 2 && !feedFound; o++) {
    const d = uaeDate(o);
    const f = await raw(`data/market/news-${d}.json`);
    const a = Array.isArray(f) ? f : (f && (f.news || f.items)) || [];
    if (a.length) feedFound = { date: d, n: a.length };
  }
  add(FAIL, 'the news feed the brief reads is present within 2 days',
      !!feedFound,
      feedFound ? `news-${feedFound.date}.json · ${feedFound.n} items` : 'no news feed in the last 3 days');

  const orphan = await raw('data/news.json');
  if (orphan) {
    const st = (Array.isArray(orphan) ? orphan : []).map(a => Date.parse(String(a.time || a.date || '')))
                 .filter(n => !isNaN(n));
    const oldest = st.length ? daysBetween(new Date(Math.max(...st)).toISOString().slice(0,10), uaeDate()) : null;
    add(WARN, 'orphan data/news.json is gone or nobody reads it',
        false, `still present, ${oldest ?? '?'}d stale — written by 977 Route 0, read by nothing live; safe to delete`);
  }

  const dists = await raw('data/distributions.json');
  const meta = dists && dists._meta;
  const built = meta && (meta.built || meta.date || meta.updated);
  // The Sunday cron rebuilds this. A WARN sat here for two weeks in Aug 2026
  // while the cron 401'd on every run, so age is now escalated: >8d warns (one
  // missed Sunday could be a blip), >15d fails (two misses means it is broken).
  const distAge = built ? daysBetween(String(built).slice(0, 10), uaeDate()) : null;
  add(WARN, 'distributions rebuilt within 8 days', distAge != null && distAge <= 8,
      built ? `built ${String(built).slice(0, 10)} · ${distAge}d old` : 'no _meta timestamp');
  add(FAIL, 'distributions cron has not missed two Sundays', distAge != null && distAge <= 15,
      built ? `${distAge}d old (fail >15 — the weekly cron is not running)` : 'no _meta timestamp');
}

// ── 3. The weekly report's own accounting closes ───────────────────────────
async function checkWeekly() {
  const root = await listDir('data');
  let latest = null, doc = null;
  if (root) {
    const weeklies = root.filter(n => /^analysis-weekly-.*\.json$/.test(n)).sort();
    latest = weeklies[weeklies.length - 1] || null;
    if (latest) doc = await raw(`data/${latest}`);
  } else {
    const users = await raw('data/users.json');
    const list = Array.isArray(users) ? users : (users && users.users) || [];
    const nick = (list.find(u => u.isAdmin) || list[0] || {}).nickname || 'rashed';
    const p = await probeNewest(d => `data/analysis-weekly-${nick}-${d}.json`, 20);
    if (p.latest) { latest = `analysis-weekly-${nick}-${p.latest}.json`; doc = await raw(`data/${latest}`); }
  }
  if (!doc) { add(FAIL, 'a recent weekly analysis exists', false,
                  latest ? `${latest} unreadable` : 'none found in the last 20 days'); return; }
  const v = (doc && doc.verdict) || {};
  const shown = (doc && doc.stocks || []).length;
  const total = (v.silent_count || 0) + (v.cut_count || 0) + shown;

  add(FAIL, 'weekly accounting closes (shown + silent + cut == holdings)',
      v.holdings != null && total === v.holdings,
      `${latest}: ${shown} + ${v.silent_count} + ${v.cut_count} = ${total} vs ${v.holdings}`);

  const age = daysBetween((doc && doc.date) || '1970-01-01', uaeDate());
  add(FAIL, 'weekly analysis ran in the last 8 days', age <= 8, `${latest} · ${age}d old`);

  // present only once the narrative gate is deployed
  if (doc && doc.guard) {
    add(FAIL, 'narrative gate passed on the latest weekly', doc.guard.ok === true,
        `mode=${doc.guard.mode} violations=${(doc.guard.violations || []).length}`);
  }
}

// ── 4. Security regressions ────────────────────────────────────────────────
// These assert the 2026-08-16 fixes STAY fixed. Only booleans and counts are
// printed — never a token, never a hash. Actions logs on a public repo are public.
async function checkSecurity() {
  const users = await raw('data/users.json');
  const list = Array.isArray(users) ? users : (users && users.users) || [];

  // A populated sessions[] is NORMAL now — entries hold only tokenHash. What must
  // never appear is a REPLAYABLE value: a legacy top-level sessionToken, or a
  // session entry still carrying the raw token.
  const plaintext = list.filter(u =>
    (u.sessionToken && String(u.sessionToken).length > 0) ||
    (Array.isArray(u.sessions) && u.sessions.some(s => s && s.sessionToken)));
  add(FAIL, 'no plaintext session tokens committed to the repo', plaintext.length === 0,
      plaintext.length ? `${plaintext.length} of ${list.length} users carry a raw token`
                       : `${list.length} users clean (sessions store tokenHash only)`);

  // Every session entry must actually be hashed, not merely missing the old field.
  const unhashed = list.flatMap(u => (u.sessions || []).filter(s => !s || !s.tokenHash));
  add(FAIL, 'every stored session is hashed', unhashed.length === 0,
      unhashed.length ? `${unhashed.length} session entries lack tokenHash` : 'all sessions hashed');

  // pinHash was SHA-256(pin + a salt public in index.html), compared literally —
  // the stored value WAS the credential. It must never come back.
  const withPinHash = list.filter(u => 'pinHash' in u);
  add(FAIL, 'no pinHash field on any user', withPinHash.length === 0,
      withPinHash.length ? `${withPinHash.length} users carry the replayable pinHash field`
                         : `${list.length} users clean`);

  // Verifiers are safe to publish but must be well formed; absent = fail-closed
  // (that user simply cannot log in), which is acceptable, so it is not an error.
  const V = /^v2:[0-9a-f]{64}$/;
  const malformed = list.filter(u => u.pinVerifier != null && !V.test(String(u.pinVerifier)));
  add(FAIL, 'every pinVerifier is well formed', malformed.length === 0,
      malformed.length ? `${malformed.length} malformed (expected v2:<64 hex>)`
                       : `${list.filter(u => u.pinVerifier).length} set, ${list.filter(u => !u.pinVerifier).length} fail-closed`);

  // Identical verifiers mean two users share a PIN — or a paste error copied one
  // user's value over another's, which is how a real mix-up showed up in Aug 2026.
  const vs = list.map(u => u.pinVerifier).filter(Boolean);
  const dupes = vs.length - new Set(vs).size;
  add(FAIL, 'no two users share a pinVerifier', dupes === 0,
      dupes ? `${dupes} duplicate verifier value(s)` : 'all distinct');

  for (const f of ['api/portfolio-for-ai.js', 'api/historical-snapshot.js']) {
    const src = await raw(f);
    if (typeof src !== 'string') { add(WARN, `${f} readable`, false, 'not fetched'); continue; }
        const hasLiteral = src.includes("'theisilabs2026'");
    add(FAIL, `${f} has no hardcoded key fallback`, !hasLiteral,
        hasLiteral ? 'literal fallback present' : 'env only');
    const failsOpen = /if\s*\(\s*key\s*&&\s*key\s*!==\s*API_KEY\s*\)/.test(src);
    add(FAIL, `${f} auth does not fail open`, !failsOpen,
        failsOpen ? 'pattern `if (key && key !== API_KEY)` lets a request with no key through'
                  : 'strict key comparison');
  }

  // Cron endpoints must authenticate on CRON_SECRET, which Vercel sends as
  // `Authorization: Bearer <value>`. `x-vercel-cron` is NOT a real Vercel header
  // (the documented one is x-vercel-cron-schedule) and is client-settable, so
  // gating on it both let anyone in AND made every real cron run 401.
  for (const f of ['api/cron-distributions.js', 'api/cron-weekly.js', 'api/risk.js']) {
    const src = await raw(f);
    if (typeof src !== 'string') { add(WARN, `${f} readable`, false, 'not fetched'); continue; }
    const badHeader = /headers\s*\[\s*['"]x-vercel-cron['"]\s*\]/.test(src);
    add(FAIL, `${f} does not trust the x-vercel-cron header`, !badHeader,
        badHeader ? 'gates on a client-settable header' : 'no x-vercel-cron gate');
    add(FAIL, `${f} authenticates cron via CRON_SECRET`, src.includes('CRON_SECRET'),
        src.includes('CRON_SECRET') ? 'CRON_SECRET referenced' : 'no CRON_SECRET check');
  }
}

// ── report ─────────────────────────────────────────────────────────────────
async function main() {
  await checkDaily();
  await checkFreshness();
  await checkWeekly();
  await checkSecurity();

  const failures = results.filter(r => !r.ok && r.severity === FAIL);
  const warnings = results.filter(r => !r.ok && r.severity === WARN);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ date: uaeDate(), failures: failures.length,
                                 warnings: warnings.length, results }, null, 2));
  } else {
    for (const r of results) {
      const mark = r.ok ? '  ok  ' : (r.severity === FAIL ? ' FAIL ' : ' warn ');
      console.log(`[${mark}] ${r.name}${r.ok ? '' : '\n           ' + r.detail}`);
    }
    console.log(`\n${results.length} checks · ${failures.length} failed · ${warnings.length} warnings`);
  }

  // Telegram, on failure only. Silence means healthy.
  const TG = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
  if (TG && CHAT && (failures.length || warnings.length)) {
    const lines = [...failures.map(r => `❌ ${r.name}\n   ${r.detail}`),
                   ...warnings.map(r => `⚠️ ${r.name}\n   ${r.detail}`)];
    const text = `THEISI watchdog — ${uaeDate()}\n\n${lines.join('\n')}`;
    try {
      await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT, text: text.slice(0, 3900) })
      });
    } catch (e) { console.error('telegram send failed'); }
  }

  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error('watchdog crashed:', e.message); process.exit(1); });
