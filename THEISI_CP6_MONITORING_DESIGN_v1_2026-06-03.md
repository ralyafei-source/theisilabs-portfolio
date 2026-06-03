# CP6 DESIGN BRIEF — Monitoring & Health Alerts
## Theisi Labs — Arabic Finance Intelligence System
### v1 · 2026-06-03 · For review — NO code until approved

> **What this is.** A reviewable design for CP6 (monitoring) — the first
> checkpoint in the reliability build order. Same format as the Phase 2 brief:
> design only, hand back for approval, then build. Nothing here is built yet.
>
> **Why CP6 first.** The system today has nothing watching it. The NVDA data
> problem ran unseen for weeks. CP6's job is to turn every silent failure into a
> visible one — a health log every run + a Telegram alert only when something is
> wrong. It has the highest RPN (640) in the FMEA precisely because its absence
> makes every other failure invisible.

---

## 1. CONFIRMED DECISIONS (from this session)
- **Alert language:** English (operator/diagnostic message — exempt from the
  "Telegram = Arabic" rule, which governs user-facing content).
- **Health log:** single rolling file `data/health-log.json`, capped to last ~30
  entries.
- **Home for the logic:** fold into `api/analysis.js` (the existing save
  endpoint). No new Vercel function (12-function limit). It already reads/writes
  GitHub and already runs at save time, so the check is a natural extension.
- **Runs on:** every save — daily, weekly, monthly.
- **TWO outputs (confirmed):** (1) admin-only diagnostic alert; (2) user-facing
  transparency line inside the analysis, with **graduated severity** as more
  fields go missing ("full transparency"). Users — even deep-tier — get only the
  transparency line, never the operator alert. Design carries a **role field**
  so future multi-user Telegram routes by role. (§6b)
- **Heartbeat:** **v1 INCLUDES it** — one short **admin-only** message per day,
  on the daily run. Healthy → one-line "all healthy" confirmation; problems →
  the fuller degraded/failed alert instead. Exactly one admin ping/day either
  way, so **silence now means the system didn't run** (itself the alarm). (§6c)
- **Read-back verification:** deferred to CP4 but **required** (not optional).
- **Section matching:** mirror the dashboard's exact keyword logic (§3 Check A).

---

## 2. SCENARIO STRUCTURE THIS MUST FIT (confirmed)
- **Weekly / Monthly (255):** … → final **save HTTP** module (last step).
- **Daily (255):** … → save → Telegram **summary (Claude)** → Telegram **send**.
- Make.com cannot be edited from code; any new Make module is added by hand.

**Implication:** the health *check* runs inside the save endpoint for all three.
The health *alert* is triggered from Make by reading a new field in the save
response. Daily already has a Telegram connection wired; weekly/monthly need one
small Telegram module added after the save.

---

## 3. WHAT THE HEALTH CHECK INSPECTS (on each save)

The POST handler in `analysis.js` already has the `content` it's about to save
and knows the `type`/`nickname`. After the write, it evaluates three things:

### Check A — Analysis completeness (from `content`)
**Mirror the dashboard's own matching logic exactly** (confirmed in
`index_v10` `parseAnalysisSections`) so "section present" means the same thing to
CP6 as to the UI — otherwise false alerts. The dashboard matches by **keyword
presence** (English + Arabic variants), per type:
- **Daily:** `DAILY SIGNALS` (+ ar إشارات اليوم), `EARNINGS & EVENTS`/`EARNINGS`
  (+ الأرباح والأحداث), `MACRO TODAY`/`MACRO` (+ ماكرو اليوم). (Scoring is shown
  daily but the SC sub-tab pulls from the scoring block.)
- **Weekly:** uses the divider form — `═══ RISK RADAR`, `═══ FAIR VALUE`,
  `═══ MOMENTUM`, `═══ SCORING ENGINE`.
- **Monthly:** `COMPETITIVE EDGE` (+ الميزة التنافسية), `LONG VIEW`
  (+ النظرة طويلة المدى), `PORTFOLIO HEALTH` (+ صحة المحفظة).

CP6 should reuse these exact keyword arrays (copy them from the dashboard, or
better, factor them into a shared constant later). Also:
- At least one score in `X/10` format where scoring is expected.
- Content length above a floor (e.g. > 500 chars) — catches truncated/empty LLM output.

### Check B — Data quality signals (from `content`)
- Detect missing fields per stock by counting failure sentinels the upstream
  should have written: `غير متوفر` ("not available"), `N/A`, `null`, `Error`,
  `Legacy`, `Too Many Requests` — attributed to the stock + field where possible.
- This is the cheap proxy until CP2's structured `DATA_QUALITY` block exists;
  once CP2 ships, CP6 reads that block directly instead of counting sentinels.

### Check C — Write verification (the save itself)
- The existing `writeFile()` returns `r.ok`. Capture it. If the PUT failed, that
  is a hard failure regardless of content quality.
- (Optional, stronger — CP4 territory: read the file back and confirm it exists.
  Flag as a later upgrade, not required for CP6 v1.)

### Status roll-up
- **Per-stock** missing-field counts → the user-facing transparency line (§6b).
- **Per-system** proportion of stocks missing a given field → admin
  `ok`/`degraded`/`failed` status (§6b "Status roll-up — per-SYSTEM").
- A failed write (Check C) forces `failed` regardless of content.

(Thresholds are first-draft and calibrated after the first week — see §6b + §7.)

---

## 4. THE HEALTH LOG (`data/health-log.json`)

Single rolling JSON array, newest last, capped to ~30 entries (drop oldest on
write). One entry per save:

```json
{
  "ts": "2026-06-03T07:12:00Z",
  "type": "daily",
  "nickname": "rashed",
  "status": "degraded",
  "checks": {
    "writeOk": true,
    "contentLength": 4120,
    "sectionsFound": ["DAILY SIGNALS","EARNINGS & EVENTS","MACRO TODAY","SCORING ENGINE"],
    "sectionsMissing": [],
    "scoresFound": 12,
    "sentinelHits": { "غير متوفر": 4, "N/A": 1, "Error": 0 }
  },
  "note": "4 fields unavailable — likely a source returned partial data"
}
```

Write logic: read `health-log.json` (or `[]` if absent) → push new entry →
slice to last 30 → write back. Uses the same `writeFile()`/SHA pattern already
in the file. This write must be defensive — **a failure to write the health log
must never break the analysis save** (wrap in try/catch; the analysis save is
the priority, the log is secondary).

---

## 5. THE RESPONSE FIELD (how Make reads status)

The POST response currently returns the save result. Add a `health` object:

```json
{ "ok": true, "saved": "data/analysis-daily-rashed-2026-06-03.json",
  "health": { "status": "degraded", "summary": "4 fields unavailable; saved OK" } }
```

Make reads `health.status`. This is the only contract Make depends on — keep it
stable.

---

## 6. THE ALERT (Make.com side — added by hand)

After the save module, in each route:
1. A **filter**: continue only if `{{save.health.status}}` ≠ `ok`.
2. A **Telegram send** module to the operator chat (`1365815413`), English,
   e.g.:
   ```
   ⚠️ THEISI health — DAILY (rashed)
   Status: DEGRADED
   4 fields unavailable; analysis saved OK.
   2026-06-03 07:12 UAE
   ```
- **Daily:** a Telegram connection already exists — add one alert module behind
  the filter (separate from the user-facing Arabic summary; this one is for you).
- **Weekly / Monthly:** add one Telegram module after the save, same filter.
- **Healthy runs send nothing.** Silence = healthy. (Optional later: a once-a-day
  "all green" heartbeat so silence isn't ambiguous — not in v1.)

> Note: this is the only hand-edited Make work. Keep it minimal — Make does the
> dumb "if not ok, send text" part; all real logic stays in version-controlled
> code.

---

## 6b. TWO OUTPUTS — admin alert vs user transparency (full transparency model)

CP6's checks now feed **two distinct outputs**, by audience. This pulls part of
CP5 (presentation transparency) forward, by design.

### Output 1 — Admin health alert (diagnostic, English, operator-only)
As in §6. Goes to **admins only** — never to regular users, even deep-tier.
Diagnostic detail ("FMP returned 3 nulls, write OK"). Today there's one admin
chat (`1365815413`); the design must carry a **role field** so that when other
users get Telegram access, routing is by role: `admin → health alert`,
`user → never`.

### Output 2 — User-facing transparency line (in the analysis, the user's language)
The user does **not** get the operator alert — instead the analysis itself
carries a transparency note telling them what was **not considered**, computed
**per-stock** (a gap on AAPL must never dim TSLA's score). Each stock pulls ~6
fields (ROE, ROIC, PEG, P/E, DCF, price target):

| Missing FOR THAT STOCK | User sees on that stock | Why |
|------------------------|-------------------------|-----|
| 0 | nothing | full data |
| 1 | ℹ️ quiet note naming the field ("ROE not considered for NVDA") | one gap is common/harmless — just be honest |
| 2–3 | ⚠️ caution on that stock | half the valuation inputs gone |
| 4+ | 🔴 low-confidence flag on that stock's score | score barely supported |

- Attaches to the **specific stock**, in the surface's language (Arabic on Telegram).
- Names **what** was missing so the user can judge for themselves.

### Status roll-up — per-SYSTEM (drives admin alert/heartbeat), proportion-based
The tell-tale of a dead source is **the same field missing across many stocks at
once**, so use **proportions, not raw counts** (survives adding/removing stocks):

| Condition | Status | Why |
|-----------|--------|-----|
| No single field missing for >25% of stocks | `ok` | scattered gaps = normal |
| Any one field missing for 25–60% of stocks | `degraded` | that source is flaky/partial |
| Any one field missing for >60% of stocks, OR write failed, OR content < length floor | `failed` | a source is down, or the save broke |

Example: Finnhub dies → ROE missing for ~all stocks → one field >60% → `failed` →
admin paged. Two random stocks lack PEG → under 25% → stays `ok`.

> 🔧 **CALIBRATE AFTER FIRST WEEK.** These cutoffs (per-stock 1/2–3/4+; per-system
> 25%/60%) are **first-draft guesses**. Some stocks legitimately lack DCF/analyst
> coverage every run — the health log will reveal the real background rate after
> ~a week, then tune thresholds to sit just above normal. (CP6 generates the data
> that tunes CP6.) **Do not over-engineer before real data exists.**
>
> **Known simplification (not in v1):** these treat all fields as equally
> important. A missing price target (Layer 5, 10%) matters less than a missing
> ROE (Layer 4, 25%). Weighting by scoring-layer importance is a possible later
> refinement — defer until simple proportions prove insufficient.

**Why this split is right:** the admin needs *diagnostics* ("a source failed");
the user needs *honesty about the product* ("this score didn't include X"). Same
underlying checks, two aggregations — per-stock for the user, per-system % for
the admin. A user is never paged about plumbing — they're told, transparently,
what the analysis could and couldn't see.

---

## 6c. HEARTBEAT (admin-only, daily, very short)

One admin-only status message per day, triggered on the **daily** run (it runs
every day; weekly/monthly don't, so daily is the natural daily pulse).

**One message per day, content varies by status** (not two separate messages):
- Healthy → `✅ THEISI daily — all healthy (rashed · 2026-06-03 07:12 UAE)`
- Degraded/failed → the fuller alert from §6 (the heartbeat slot *becomes* the
  alert). Still one ping.

**Why:** with a heartbeat, **silence is now meaningful** — if the daily ping
doesn't arrive, the system didn't run (scheduler down, scenario disabled). That
is the alarm. Without it, you couldn't tell "healthy" from "dead."

**Honest limit:** the heartbeat is sent *by* the system, so it only proves the
system got far enough to send it, and a *missing* heartbeat requires **you to
notice its absence**. A true external watchdog (something outside the system
that checks "did today's heartbeat arrive?" and escalates if not) is a stronger
later layer — **noted as future, not v1.**

**Scope:** admin-only. Users never receive the heartbeat (they only ever get the
in-analysis transparency line, §6b). Carried on the same role field.

**Implementation:** the daily route already ends with a Telegram leg. The
heartbeat is a Telegram send to the admin chat using the save response's
`health.status` to pick the message. Weekly/monthly do **not** send a heartbeat
(only an alert if not `ok`), to keep it to one daily pulse.

---

## 7. OPEN QUESTIONS / TUNING (decide at review)
1. ✅ **Section markers** — confirmed from `index_v10` (§3 Check A). Reuse the
   dashboard's keyword arrays verbatim.
2. ✅ **Severity thresholds** — resolved (§6b): per-stock 1 / 2–3 / 4+ for the
   user line; per-system 25% / 60% (proportion of stocks missing a field) for
   admin status. Calibrate after first week from the health log.
3. ✅ **Alert routing** — admin chat `1365815413`; English alert sharing that chat
   with the Arabic brief is fine. Role field carried for future multi-user.
4. ✅ **Heartbeat** — INCLUDED in v1: admin-only, daily, one ping (§6c). External
   watchdog for missing heartbeats noted as future.
5. ✅ **Read-back (CP4)** — deferred to CP4 but **required**, not optional.
6. **Transparency line placement** — recommend appending to `content` before save
   (persists in file + dashboard + Telegram), vs Make weaving it in. Confirm (b).

---

## 8. WHAT CP6 DOES AND DOESN'T DO
**Does:** makes every run's health visible (log) and alerts you when a run fails
or degrades. Closes the "nobody knew" gap.
**Doesn't:** fix the data itself (that's CP2), cross-check numbers (CP3), or stop
the LLM hallucinating (CP3 + CP5 disclaimer). CP6 is the *eyes*, not the cure —
but with eyes on, every later fix becomes verifiable.

---

## 9. BUILD STEPS (once approved)
1. In `api/analysis.js` POST handler, after the existing write: run Checks A/B/C,
   build the `health` object, append to `health-log.json` (defensive), add
   `health` to the response. Show the diff before applying.
2. Commit via PowerShell, push, verify on the live URL with one manual POST.
3. In Make 255: **daily route** — add one Telegram-to-admin module using
   `health.status` (healthy → short ✅ heartbeat; not-ok → fuller alert).
   **Weekly/monthly** — add a filter + Telegram alert that fires only when
   status ≠ ok (no heartbeat on these).
4. Test: (a) force a `degraded` (save short content) → confirm the alert fires +
   log entry appears; (b) a healthy daily run → confirm the short ✅ heartbeat
   arrives; (c) a healthy weekly run → confirm it stays silent.
5. Update the SSOT (mark CP6 built; note the health-log location + response contract).

---

*End of CP6 design v1. Review §7 especially — section markers and thresholds
need your confirmation before build. No code until approved.*
