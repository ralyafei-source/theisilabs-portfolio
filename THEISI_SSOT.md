# THEISI LABS — SINGLE SOURCE OF TRUTH

**Arabic Finance Intelligence System.** This file is the current truth about the system.

> **Living document. No version number, on purpose.**
> Git is the version: `git log --format='%h %ad %s' -- THEISI_SSOT.md` tells you exactly which
> revision you are reading and `git diff` shows what changed. Earlier numbered copies (v1.7,
> v1.8, and `THEISI_SSOT_v1_14/15/16.md` in the claude.ai project) were snapshots that got
> edited in place anyway, which made the number a lie. Do not create another numbered copy.
> Edit this file and commit.
>
> **It lives in the repo, not in the claude.ai project**, because Claude Code sessions —
> including the ones Dispatch spawns from a phone — read the repo and `CLAUDE.md`. They cannot
> see project docs. Anything written only in the project is invisible to the agent doing the work.
>
> Last substantive revision: **2026-08-21** (portfolio-input check, watchdog 30→38 checks).
> Watchdog at that point: 38 checks, 0 failures, 2 warnings.

---

## 1. PRODUCT
THEISI receives professional grades (Seeking Alpha) + market data (FMP/Yahoo) + news, and explains to Khaleeji Arabic investors what is happening to their portfolio, why, and what the analysis says — data shown, never invented, never financial advice.

## 2. PORTFOLIO
**53 holdings (as of 2026-08-20).** Broker: Wio Invest, Abu Dhabi UAE.
Source of truth: `data/portfolio.json`. Multi-user: `portfolio-{nickname}.json`.
Users: rashed (admin), tester, asma, ahmed.

2026-08-20 trades: SOLD TEAM and IBIT in full; BOUGHT GEV 25 @ $944.25 (sector `energy`) and
BSX 100 @ $50.43 (sector `bio`). Sector choices are judgement calls — they drive the exposure
donut and `opportunity.js`'s diversifier.
NOTE: BSX at $50.43 was not price-verified. Boston Scientific traded near $100 through 2025;
confirm no split-adjustment error — a wrong cost basis silently corrupts every P/L downstream.

**How portfolio edits work.** `api/update-portfolio.js` BUY recomputes a weighted average:
`newCost = (oldShares*oldCost + shares*price) / (oldShares+shares)`. SELL leaves the cost basis
untouched (correct for average-cost accounting, matching the Wio export). Verified against
TEAM's real history to the cent. Caveats: `cost` rounds to 2 decimals per buy so repeat
purchases drift a few cents; `shares` rounds to 4 decimals; selling below 0.01 shares removes
the holding.

## 3. GOLDEN SEPARATION (non-negotiable — now ENFORCED, see §4)
Code computes ALL numbers, scores, verdicts, selections. Claude writes ONLY the Arabic
narrative from provided fields. Banned: invented numbers, invented rule names, company
descriptions not in the data, linking news to a stock unless explicit in the data.

## 4. NARRATIVE GUARD (2026-08-20)

**The evidence is the cluster note.** The 2026-07-21 weekly says a cluster is worth **$114,500**
where code computed **$121,379** — a fabricated figure in a report Rashed reads and acts on.

**CORRECTION, recorded because the wrong version was believed twice.** An earlier revision
claimed a weekly reported TEAM at 20.5% when it was 0.16%. **That was wrong.** On 2026-08-05
Rashed genuinely held 1,211.99 TEAM shares at $109.95 = $133,258 = 20.4%. The report was
correct. He then sold 1,000 shares (Aug 9) and 200 more (by Aug 19). Every step checks out: the
Aug 4 purchase of 1,082.52 shares at $93.71 produces exactly the recorded $92.11 average, and
both sells left the cost basis unchanged. The failure was **a stale note in this document**, not
bad data and not bad code.

`api/_lib/narrative-guard.js` traces every number in Claude-written prose back to a computed
field; `generate-analysis.js` stamps `doc.guard` — the field `watchdog.js` had been checking for
and never finding. Wired into weekly AND monthly.

Built against all 30 existing reports, because **a guard that cries wolf gets switched off.**
2,684 numbers → 1 violation, the real one above. Most of the work was making it NOT fire on
correct writing: dates, index names ("S&P 500") and MA periods ("متوسط 200 يوم") are labels not
measurements; the Arabic comma is a thousands separator ("95،627" is one number); derived
aggregates are legitimate analysis (top-N and pairwise sums are precomputed as traceable);
"تجاوزت 57%" states a bound that −57.9 satisfies.

Two bugs found by testing rather than reading: adding rounded variants AND allowing 0.5
absolute slack double-counted, letting a claimed 20.5% match a computed 21.1% (tolerance is now
1.5% relative, 0.05 floor); and the index lookup searched for `88000` in text reading `88,000`,
never found it, and classified using the wrong surrounding words.

Violations gate. Low-stakes untraceable figures (invented support levels, numbers from the
week's news) go to `unverified` and do NOT gate. **Ships in `warn`** — set `GUARD_MODE=block`
after a few clean weeks. A gate that fires on launch day gets disabled.

LIMIT: it checks prose against computed fields. It CANNOT catch bad input — correct arithmetic
on a wrong share count passes cleanly. That gap is now covered from the other side by the
portfolio-input check in §7 (2026-08-21), which validates the INPUT rather than the prose.

## 5. AUTH & CREDENTIALS — v2 model (2026-08-20)

**The repo is PUBLIC and must stay public.** `index.html` makes 17 unauthenticated
raw.githubusercontent fetches and 15 API files make more. Private breaks the dashboard.
Everything below follows: anything committed is world-readable, so nothing replayable may be
committed.

**What was wrong.** `data/users.json` stored `pinHash` = SHA-256(pin + PIN_SALT), computed IN
THE BROWSER and compared literally by the server. PIN_SALT is a constant in `index.html`. The
stored value WAS the credential — POST it to `/api/auth?action=login` and you got a session as
any user, admin included. Raw `sessionToken` values were stored in plaintext too.

**What replaced it** — `api/_lib/pin.js`:
```
pinVerifier          = HMAC-SHA256(PIN_PEPPER, nickname + ':' + clientPinHash)
sessions[].tokenHash = SHA-256(rawToken)
```
`PIN_PEPPER` is a server-only env var. Without it the public file yields nothing.
**`index.html` was NOT changed** — the browser still sends SHA-256(pin + PIN_SALT); peppering is
server-side. Constant-time compare via `crypto.timingSafeEqual`. Legacy `pinHash` values are
NEVER accepted — they were public, so all are burned.

Files touched: `api/_lib/pin.js` (new), `auth.js`, `_auth.js`, `admin.js`, plus inline session
checks in `generate-analysis`, `user-portfolio`, `briefing`, `sa-grades`, `risk`, `analysis` —
all six had their own copy and would have rejected every login once tokens were hashed. Also
fixed: `admin.js verifyAdmin()` read `u.sessionToken`, a field the sessions[] model never
writes — admin auth had been broken.

**Operational rules:**
- A user with no `pinVerifier` is FAIL-CLOSED. Correct and deliberate. Do NOT "fix" it by
  setting `needsPinSetup:true` broadly — nicknames are public in the same file, so whoever logs
  in first claims the account, including admin.
- `tools/make-verifier.js` mints a verifier locally; the PIN never leaves the machine. Paste
  ONLY the printed `v2:...` value into users.json.
- Env required: `PIN_PEPPER` (>=32 chars), `CRON_SECRET`, `BRIEFING_API_KEY`, `GITHUB_TOKEN`,
  `FMP_API_KEY`, `FRED_API_KEY`, `TELEGRAM_TOKEN`, `MARKETAUX_TOKEN`, `ANTHROPIC_API_KEY`.
  Optional `GUARD_MODE`. Missing `PIN_PEPPER` => every login 503s. Intentional, not a bug.

**Cron auth (fixed 2026-08-20).** `api/cron-distributions.js` gated on
`req.headers['x-vercel-cron']`. That header does not exist (the documented one is
`x-vercel-cron-schedule`) and is client-settable, so the gate simultaneously let anyone trigger
the job AND made every genuine cron run 401. Now uses `CRON_SECRET`. Verified live: both
unauthenticated and `x-vercel-cron: 1` return 401.

## 6. SYSTEM — LIVE STATE

- **6087922 Data Collector (922)**: ON. Daily 3:00 AM UAE.
- **5826977 Morning Brief v2 (977)**: ON. One Claude call → brief + narrative → Telegram + dashboard.
- **Price Target Alert: EXISTS and RUNS.** An earlier revision claimed it did not exist — WRONG,
  and the clearest example of why this document loses to the repo. Rebuilt 2026-08-20: API key
  moved to a Make **keychain** (exports carry no secret), timeout 300, `sequential:true`,
  `dlq:true`.
- 250 Opportunity Scanner, 255 Private Advisor, 754 Instagram, 357 User Analysis: all OFF, none deleted.

**FMP: STARTER.** Index symbols excluded → VIX from Yahoo, momentum uses SPY. economic-calendar
excluded → `mode=macro` uses a static schedule (update yearly). FMP `changePercentage` is NOT
trustworthy for indices.

**Vercel: PRO.** 40 crons and 300s maxDuration available.

**Key endpoints:**
- **`mode=sentiment` — F&G v5.** VIX vs 50-day MA (20%), SPY-vs-125d momentum (20%), SPY-TLT
  safe-haven (20%), SPY strength (15%), HY OAS credit (15%), RSP-SPY breadth (10%).
  v5 removed the 40% 252-day-percentile component: the two disagreed and the average cancelled
  the signal — VIX at the 21st percentile of its year (calm → 79) while 3.85% ABOVE its 50-day
  MA (fear → 44) blended to 58 and the fear vanished. Effect: volatility 58→44, composite 66→63,
  gap to CNN 11→8. The 90-day trend got the IDENTICAL change — if the two formulas diverge the
  chart steps at the join. Reweighting is a DEAD END (equal weights gives 65).
  **The residual 8 points is missing data, not arithmetic** — CNN's other three indicators
  (52-week highs/lows, McClellan breadth, put/call) are not on FMP Starter.
  Writes `data/system/sentiment-status.json` once per UAE day so the watchdog can assert the gap.
- **`generate-analysis.js` v3.1** — weekly STRUCTURED (schema:2). Verdict rules in code.
  dayPct/weekPct SELF-COMPUTED from the close array. Accounting must close:
  shown + silent + cut = holdings. Weight math VERIFIED CORRECT 2026-08-20. Stamps `doc.guard`.
- **`portfolio-for-ai`** — PLAIN TEXT default. PUBLIC_MODES browser-callable without a key;
  portfolio text and all write modes require `BRIEFING_API_KEY`. No fallback, no fail-open.
- **`api/target-alerts.js`** — `?scan=1` scans all users. **Writes
  `data/system/alerts-status.json` every scan.** The per-user state file is written only when a
  level changes, so its age is not a liveness signal — a quiet week looks exactly like a dead
  scenario, and Make disables a scenario after 3 consecutive errors silently.
- **`api/update-portfolio.js`** — BUY/SELL/ADD/REMOVE, commits via `GITHUB_TOKEN`, auth by admin
  session OR `BRIEFING_API_KEY`. **Anything holding that key has full authority over the
  portfolio without a PC, a clone, or git.**
- `data/opportunities/today.json` and `data/news.json`: DELETED (the dashboard reads
  `data/market/news-{date}.json`).

## 7. WATCHDOG (`watchdog/watchdog.js` — GitHub Actions, 38 checks, 04:17 UTC daily)

Runs in Actions deliberately: a monitor sharing a failure domain with what it monitors is not a
monitor. Silence means healthy.

THEISI's characteristic failure is not a crash — it is a component returning HTTP 200, writing
nothing, and never being noticed. Every check asserts an ARTIFACT, not uptime.

Design notes worth preserving:
- A populated `sessions[]` is NORMAL now (entries hold only `tokenHash`). The old check flagged
  any non-empty array and would have false-alarmed the moment anyone logged in.
- Detail strings must be CONDITIONAL on the outcome. The earlier version printed "literal
  fallback" whether the check passed or failed, which read as a live vulnerability on a PASSING
  check and produced a confident wrong diagnosis before the code was read.
- distributions escalates: >8d WARN, >15d FAIL. It sat at WARN for two weeks while the cron 401'd.
- F&G drift is WARN not FAIL above 15 points: THEISI is portfolio-flavoured and SHOULD differ.
- **Portfolio-input check (2026-08-21)** closes the §8 gap: the narrative guard checks prose
  against computed fields, so correct arithmetic on a wrong share count passed cleanly. Two
  tiers, both tuned against ALL 101 commit pairs in the portfolio files' history:
  **FAIL** when shares move ≥1.5x while `shares*cost` stays within 10% — the split/units-error
  signature, ZERO historical hits, and no real trade does it (a buy adds book value; a sell
  removes it and leaves cost untouched). It needs the low 1.5x threshold because a 2:1 split
  error only moves shares 2x — the 5x rule would sail straight past it.
  **WARN** when shares move ≥5x and the commit message names neither ticker nor company —
  2 historical hits, roughly one alert every six weeks.
  Matching the COMPANY NAME matters: "Update shares value for Atlassian" is a genuine TEAM
  trade and ticker-only matching flags it. Verified by stubbing `fetch` and running the real
  code path — not a reimplementation, which is how the narrative guard's first test lied.
  LIMITS: per-user files are committed by Make with generic "Update data/portfolio-{nick}.json"
  messages, so the WARN tier can never excuse a legitimate large move there. It compares only
  commits from the last 8 days, so an alert ages out rather than shouting forever. If the
  commits API is unreachable it reports "input NOT verified" — never a silent pass.
- The two portfolio formats are NOT the same shape: `portfolio.json` is
  `{profile, holdings[], meta}` with `name`; `portfolio-{nick}.json` is
  `{nickname, stocks[], lastUpdated}` with `en`. Reading only `holdings` silently checked
  nothing on four of the five files — caught only because unparsed revisions WARN.

## 8. KNOWN OPEN ITEMS
*Each line is a claim about the world, and claims rot. Re-verify before acting — a stale entry
here caused a wrong diagnosis on 2026-08-20. Delete items when they close.*

- **Vercel crons have never once fired successfully.** `distributions.json` was only ever written
  2026-08-05 and 2026-08-20, both manual. `risk-*` and `analysis-weekly-*` show the same pattern
  — every write Wed/Thu, never Sunday, though all three crons are Sunday. The `CRON_SECRET` fix
  is the leading candidate; **first real test is Sunday 2026-08-23 ~01:00 UTC.** If no commit
  lands, check Deployment Protection, which blocks cron invocations on Pro without a bypass.
- `users.json` still lives in the public repo. With the v2 model it leaks nothing usable, so not
  urgent — but `api/_auth.js` rewrites it on every sliding-session renewal, so it churns.
- `BRIEFING_API_KEY` exposed in chat 2026-08-05, not rotated. A second key was exposed in the
  Price Target Alert blueprint 2026-08-20; verified NOT in the repo or its history.
- `GUARD_MODE` is `warn`. Move to `block` after a few clean weeks.
- `vercel.json` declares functions for `historical-snapshot`, `backtest-batch`, `backtest-save`,
  `download-historical`. `historical-snapshot.js` EXISTS and is clean; confirm the other three.
- 357 User Analysis Engine: audit before turning ON.
- Yearly: refresh the SCHEDULE array in `mode=macro` (Fed/BLS dates).
- `silent_note_ar` is in the saved weekly doc but NOT rendered on the AI Advisor page.
- `index.new.html` sits untracked — decide whether it is wanted.

## 9. DASHBOARD, MARKET PULSE, PRICE READ
Unchanged as of 2026-08-20. Key gotcha: FMP `changePercentage` and Yahoo `chartPreviousClose`
are both untrustworthy — pull 5 days of closes and diff the last two valid entries yourself.

## 10. WORKING FROM A PHONE (2026-08-20)

**Use Dispatch and Routines. Do not build a custom bridge.**

- **Dispatch** (Cowork tab, Pro/Max): message it a task from the phone; it spawns a Claude Code
  session for development work. Push notification when it finishes or needs approval, and
  approvals happen on the phone.
- **Cloud routine**: scheduled work that runs **with the computer off**. Fresh clone, no local
  files, 1-hour minimum. Right home for the weekly digest and monthly audit.
- **Desktop routine**: needs the app open and the machine awake; has local files; 1-minute
  minimum. A missed run is SKIPPED, then one catch-up fires on wake — a 9am task can run at
  11pm, so put a time guard in the prompt. A task in Manual permission mode stalls awaiting
  approval; hit **Run now** once and "always allow" each tool.
- **Remote Control** (`/remote-control`): drive a running local session from the phone.
- **The watchdog stays in GitHub Actions** — it monitors this system, so it must not share a
  failure domain with it.

**Rejected alternative, recorded so nobody rebuilds it:** a custom Telegram bridge
(`theisi-agent.js`, long-poll → `claude -p` headless) was built 2026-08-20 and superseded by
Dispatch the same day, before it was ever installed. Dispatch is better on the axis that
matters: approvals land on the phone, so there is no choice between "cannot act" and "acts
unsupervised at 3am". An `api/telegram-webhook.js` from the same effort was never committed.

Capability roadmap, researched but not built:
- Hooks — `PreToolUse` exit code 2 BLOCKS an action, turning principles into mechanisms: block
  edits to `data/users.json`; run `node --check` + watchdog after any `api/` edit; validate JSON
  parses and has no BOM before a commit.
- Skills for procedures that keep biting: `/trade`, `/deploy`, `/audit`.
- A read-only auditor subagent (`allowed-tools: Read Grep`) physically cannot write.
- Risk framing (Willison's "lethal trifecta"): private data + untrusted content + exfiltration.
  THEISI has all three. Add MCP data sources AFTER a PR gate, not before.

## 11. WORKING WITH THE REPO (learned the hard way, 2026-08-20)
- Make scenarios commit to `main` continuously. ALWAYS `git pull --rebase origin main` before
  editing a data file.
- During a REBASE, `--ours` means the UPSTREAM branch, not your work — inverted from a merge.
  Using it on a `users.json` conflict silently discarded a full set of verifiers. When a rebase
  conflicts, edit the file by hand and delete the markers.
- PowerShell: `VAR=value command` is bash and fails — set `$env:VAR='...'` on its own line.
  `Set-Content -Encoding utf8` writes a BOM that breaks `JSON.parse`; use
  `[System.IO.File]::WriteAllText($path,$text,(New-Object System.Text.UTF8Encoding $false))`.
  `npm` and `claude` may be blocked by execution policy — use `npm.cmd` / `claude.cmd`.
- Edit JSON as DATA, never as text. Hand-editing produced a doubled `"pinVerifier":` key, a BOM,
  and a pepper pasted into four user records. Validate with `node -e "JSON.parse(...)"` BEFORE
  committing.
- raw.githubusercontent caches aggressively and `?t=` is NOT always enough. It served a stale
  copy that caused a wrong "the push didn't work" diagnosis. Verify through git
  (`git show origin/main:path`), not raw.
- Verify a push by inspecting the file, not by trusting "Everything up-to-date" — an unstaged
  edit makes git report success while pushing nothing.

## 12. LANGUAGE & APPROACH
English unless Rashed writes Arabic. All Telegram/dashboard output Arabic (Khaleeji,
professional, explain-don't-recommend, ends "القرار في النهاية عندك يا {name}"،
disclaimer "تحليل معلوماتي — ليست نصيحة مالية").
Give fixes directly; never start over — build on what exists; update this file when something
new is built.

**When this document conflicts with the repo, the repo wins and this document is wrong.**
Three times in one day: it said Price Alerts did not exist while it ran in production; it
carried a TEAM concentration Rashed had already traded away; and a watchdog detail string was
read as a live vulnerability on a PASSING check.

**Test against real data before declaring something works.** The narrative guard's first passing
test was a false pass caused by the fixture.

---

## APPENDIX — what the 2026-06-04 (v1.8) revision contained

This file was rewritten on 2026-08-20 from verified live state. The previous revision had
sections NOT carried forward, because they predate the July/August rewrites (bucket-scorer v2,
generate-analysis v3.1, the auth rewrite) and were not re-verified:

  §8 Data Sources · §9 Scoring Engine · §9b Profile System · §12 File Disposition
  §13 How to start a new session

They are not gone — they are in git:

    git log --oneline -- THEISI_SSOT.md
    git show fb3dee01:THEISI_SSOT.md

Treat anything recovered that way as a 2026-06-04 claim and verify against the code before
relying on it. That is the whole reason this file lives in git rather than being versioned by hand.
