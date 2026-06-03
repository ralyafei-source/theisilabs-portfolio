# CP6 BUILD — Code Changes for `api/analysis.js` + Make.com Steps
## v1 · 2026-06-03 · Hand to Claude Code. Review diff before applying.

> **Scope of this build:** add health-checking to the POST (save) path of
> `api/analysis.js`. Three additive helper functions + one modified block (the
> write-and-respond tail). Nothing else in the file changes. Then 3 small
> Make.com module additions (by hand).
>
> **Guardrails (from project rules):**
> - Show the diff before applying. Commit via PowerShell (Claude Code commit
>   hangs on Windows). Push triggers Vercel.
> - The health-log write must NEVER break the analysis save (wrapped in
>   try/catch; analysis save is the priority).
> - No new Vercel function (folded into existing `analysis.js`).
> - This is CP6 **v1** — thresholds are first-draft, calibrated after ~1 week.

---

## PART A — CODE CHANGES TO `api/analysis.js`

### A1. Add three helper functions (place them near the top, after the existing
`writeFile` function, before `module.exports`).

```javascript
// ───────────────────────── CP6: Health check helpers ─────────────────────────

// Section keyword arrays MUST mirror the dashboard's parseAnalysisSections
// (index.html) so "section present" means the same to CP6 as to the UI.
const HEALTH_SECTIONS = {
  daily: [
    ['DAILY SIGNALS', 'إشارات اليوم', 'الإشارات اليومية'],
    ['EARNINGS & EVENTS', 'EARNINGS', 'الأرباح والأحداث'],
    ['MACRO TODAY', 'MACRO', 'ماكرو اليوم', 'الاقتصاد العالمي']
  ],
  weekly: [
    ['═══ RISK RADAR', 'RISK RADAR'],
    ['═══ FAIR VALUE', 'FAIR VALUE'],
    ['═══ MOMENTUM', 'MOMENTUM']
  ],
  monthly: [
    ['COMPETITIVE EDGE', 'الميزة التنافسية'],
    ['LONG VIEW', 'النظرة طويلة المدى'],
    ['PORTFOLIO HEALTH', 'صحة المحفظة']
  ]
};

// Sentinels that indicate a missing/failed data point in the analysis text.
const HEALTH_SENTINELS = ['غير متوفر', 'N/A', 'null', 'Error', 'Legacy', 'Too Many Requests'];

// Build the health object from the content we just saved.
// writeOk = result of writeFile(); type = run type.
function buildHealth(content, type, writeOk) {
  const text = typeof content === 'string' ? content : JSON.stringify(content || '');
  const runType = (type || 'daily').toLowerCase();
  const expected = HEALTH_SECTIONS[runType] || HEALTH_SECTIONS.daily;

  // Check A — sections present (any keyword variant counts as found)
  const sectionsFound = [];
  const sectionsMissing = [];
  for (const variants of expected) {
    const hit = variants.some(k => text.includes(k));
    (hit ? sectionsFound : sectionsMissing).push(variants[0]);
  }

  // Check A — scores present (X/10 format) + length floor
  const scoresFound = (text.match(/\b(?:10|[0-9])\s*\/\s*10\b/g) || []).length;
  const contentLength = text.length;

  // Check B — count sentinel hits (proxy until CP2's structured DATA_QUALITY block)
  const sentinelHits = {};
  let totalSentinels = 0;
  for (const s of HEALTH_SENTINELS) {
    const n = (text.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (n > 0) { sentinelHits[s] = n; totalSentinels += n; }
  }

  // Status roll-up.
  // failed: write failed, OR no sections at all, OR content clearly truncated.
  // degraded: some sections missing, OR notable sentinel count, OR no scores where expected.
  // ok: otherwise.
  // NOTE v1: per-system proportion thresholds (25%/60%) require per-stock field
  // parsing which the structured DATA_QUALITY block (CP2) will provide. Until then
  // we approximate with sentinel count + section completeness. Calibrate after 1 week.
  let status = 'ok';
  const scoringExpected = (runType !== 'monthly'); // monthly Part B is narrative-heavy
  if (!writeOk) {
    status = 'failed';
  } else if (contentLength < 500 || sectionsFound.length === 0) {
    status = 'failed';
  } else if (sectionsMissing.length > 0 || totalSentinels > 8 || (scoringExpected && scoresFound === 0)) {
    status = 'degraded';
  }

  const summary =
    status === 'ok' ? 'all healthy' :
    [
      sectionsMissing.length ? `${sectionsMissing.length} section(s) missing` : null,
      totalSentinels ? `${totalSentinels} unavailable field(s)` : null,
      !writeOk ? 'write failed' : null,
      contentLength < 500 ? 'content too short' : null
    ].filter(Boolean).join('; ') || 'see checks';

  return {
    status, summary,
    checks: { writeOk, contentLength, scoresFound, sectionsFound, sectionsMissing, totalSentinels, sentinelHits }
  };
}

// Append the new entry to data/health-log.json, capped to last 30. Defensive:
// any failure here is swallowed so it can NEVER break the analysis save.
async function appendHealthLog(entry) {
  try {
    const log = (await readFile('data/health-log.json')) || [];
    const arr = Array.isArray(log) ? log : [];
    arr.push(entry);
    const capped = arr.slice(-30);
    await writeFile('data/health-log.json', capped);
  } catch (e) {
    // swallow — monitoring must never take down the thing it monitors
  }
}
// ──────────────────────── end CP6 helpers ────────────────────────
```

### A2. Modify the write-and-respond tail (the current last lines of the POST block)

**BEFORE (current code):**
```javascript
    const ok = await writeFile(path, data);
    if (ok) return res.json({ success: true, path });
    return res.status(500).json({ error: 'Failed to save' });
```

**AFTER (replace with):**
```javascript
    const ok = await writeFile(path, data);

    // CP6 — evaluate health, log it, attach to response (defensive: never throw)
    let health = null;
    try {
      health = buildHealth(content, type, ok);
      await appendHealthLog({
        ts: new Date().toISOString(),
        type: type || 'daily',
        nickname: nick || null,
        status: health.status,
        checks: health.checks,
        note: health.summary
      });
    } catch (e) {
      health = { status: 'unknown', summary: 'health check error', checks: {} };
    }

    if (ok) return res.json({ success: true, path, health });
    return res.status(500).json({ error: 'Failed to save', health });
```

That's the entire code change: 3 helpers added, 3 lines swapped for ~16. The
`readFile` and `writeFile` functions it uses already exist in the file.

---

## PART B — TEST THE ENDPOINT (before touching Make)

After Claude Code applies the diff, commits via PowerShell, and pushes (Vercel
redeploys), test with two manual POSTs (use your rotated `BRIEFING_API_KEY`):

1. **Healthy:** POST a normal daily content string (with the section keywords +
   a few `X/10` scores). Expect response `health.status: "ok"`.
2. **Degraded:** POST a short content missing sections. Expect
   `health.status: "failed"` or `"degraded"`.
3. Check `data/health-log.json` now exists in the repo with your test entries
   (capped at 30).

(You can POST via the dashboard's existing save flow, or a quick curl/Postman
call to `/api/analysis` with `Authorization: Bearer <key>`.)

---

## PART C — MAKE.COM (scenario 255, by hand — 3 additions)

The save HTTP module's response now contains `health.status`. Add:

### Daily route (ends: save → Telegram summary → Telegram send)
- After the save module, add a **Telegram → admin chat (1365815413)** module that
  ALWAYS runs once per day (the heartbeat), using `{{save.health.status}}`:
  - If `ok` → short text:
    `✅ THEISI daily — all healthy ({{nickname}} · {{formatDate(addHours(now;4);"YYYY-MM-DD HH:mm")}} UAE)`
  - If not `ok` → fuller alert:
    `⚠️ THEISI daily — {{upper(save.health.status)}} ({{nickname}})%0A{{save.health.summary}}%0A{{formatDate(addHours(now;4);"YYYY-MM-DD HH:mm")}} UAE`
  - Simplest build: one Telegram module whose text is an `if({{save.health.status}} = "ok"; <healthy text>; <alert text>)` formula. (Heartbeat + alert in one module.)

### Weekly route (ends: save)
- Add a **filter** after save: continue only if `{{save.health.status}} ≠ ok`.
- Then a **Telegram → admin** module with the alert text (no heartbeat on weekly).

### Monthly route (ends: save)
- Same as weekly: filter (`status ≠ ok`) → Telegram admin alert.

**Notes:**
- Heartbeat is daily-only (one pulse/day). Weekly/monthly only speak up on problems.
- English text (operator/diagnostic). The user-facing Arabic summary modules are
  unchanged — this admin message is separate.
- Confirm the exact reference path for the save module's output
  (`{{<moduleNumber>.health.status}}` — Make may wrap it under `.data`; check with
  one run and adjust).

---

## PART D — NOT IN THIS BUILD (deferred, tracked)

- **User-facing transparency line** (§6b of the design — per-stock "did not
  consider X"): needs per-stock field parsing, which is cleanest after CP2's
  structured `DATA_QUALITY` block exists. **Build with/after CP2.** The current
  build gives the admin signal + log; the per-stock user line follows.
- **Per-system proportion thresholds (25%/60%)**: same dependency on per-stock
  parsing (CP2). v1 approximates with sentinel count + section completeness.
- **Read-back verification** (CP4): confirm file exists after write. Required, deferred.
- **External watchdog** for missing heartbeats: future.

---

## PART E — AFTER IT WORKS
- Update the SSOT: mark CP6 v1 built; record the `health` response contract, the
  `data/health-log.json` location, and that thresholds need first-week calibration.
- Add `health-log.json` to the "90-day data cleanup" mental model (it self-caps
  at 30, so it won't grow — no action needed, just note it).

---

*End of CP6 build v1. The code in Part A is the reviewable diff — Claude Code
should show it in place before applying. Part C is hand-work in Make. Parts of
the design (user transparency line, % thresholds) intentionally wait for CP2.*
