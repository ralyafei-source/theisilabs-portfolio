# THEISI LABS — SINGLE SOURCE OF TRUTH (SSOT)
## Arabic Finance Intelligence System
### v1.1 · 2026-06-03 · Supersedes all prior MASTER_RULES, SYSTEM_REFERENCE, and SESSION_SUMMARY files

> **v1.1 changes:** Corrected FMP plan **$69 Premium → $29 Starter** (verified
> live). Added Finnhub free as the planned CP3 second source and the
> definition-matching design rule. Folded in CP3 verification results. The "$69
> upgraded 2026-05-31" claim in older docs was an intent that did not stick —
> the live key is on $29 and returns all needed endpoints anyway.
> Also added (from PROFILE_SYSTEM_PLAN + PHASE2 brief): the **legal tiering rule
> (255 vs 357)**, the **no-hardcoded-identity rule**, the **Profile System
> section §9b**, the **two-schema** portfolio fact, the **portfolio-save
> overwrite bug**, and the **third hardcoded-token file** (`api/update-portfolio.js`).
> Corrected conflicting stock-count/value figures to "computed live, never fixed."
> **Filename rule:** this doc should live as a constant `THEISI_SSOT.md` (version
> inside, not in the filename).

> **What this document is.** One reconciled reference that replaces the
> conflicting set of docs (MASTER_RULES v5–v21, THEISI_SYSTEM_REFERENCE,
> SESSION summaries, the original onboarding note, and the scoring framework).
> Where those documents disagreed, this file states the winning value **and**
> shows what it overrode, so the reconciliation can be audited.
>
> **Authority order used to resolve conflicts** (newest / most authoritative first):
> 1. **CLAUDE.md** — references "Session 23", the most recent marker found. Wins on rules.
> 2. **THEISI_SYSTEM_REFERENCE.md** — "Session 22", most recent operational log.
> 3. **MASTER_RULES v21** — "Session 17" content, 2026-05-31.
> 4. Older master-rules (v5–v20), scoring framework v1, onboarding note — historical.
> 5. **`api_portfolio_for_ai_v2.js`** — treated as an **older code snapshot**, NOT
>    proof of what is deployed (see §7). Used to describe logic, not to confirm secrets.
>
> **Confidence tags used below:**
> - ✅ **Confirmed** — consistent across current docs and/or visible in code.
> - ⚠️ **Verify in production** — only you can confirm (Make.com UI, Vercel env, live deploy).
> - 🔴 **Action required** — a security or correctness item that needs doing.

---

## 1. IDENTITY & ACCESS

| Item | Value | Confidence |
|------|-------|-----------|
| Live dashboard | https://theisilabs.vercel.app | ✅ |
| GitHub repo | github.com/ralyafei-source/theisilabs-portfolio | ✅ |
| Local repo path | C:\Users\user\Documents\theisilabs-portfolio | ✅ |
| Make.com account | eu1.make.com/1748978 | ✅ |
| FMP plan | **Starter, $29/mo** (verified live 2026-06-03). 300 calls/min, US coverage, 20GB/mo bandwidth. **13F NOT included; insider data IS included.** | ✅ verified |
| FMP API base | https://financialmodelingprep.com/stable (legacy `/api/v3/` retired Aug 31 2025 — never use) | ✅ |
| Admin nickname | rashed | ✅ |
| Telegram chat ID | 1365815413 | ✅ |
| Telegram morning bot | @Simplyroninbot | ✅ |
| Telegram security bot | @theisilabs_securitybot | ✅ |
| Tooling | Claude Code installed. **Commit via PowerShell — Claude Code commit prompt hangs on Windows.** | ✅ |

### Secrets — current intended state vs. action needed

| Secret | Intended location (newest doc) | Reality found in project files | Status |
|--------|-------------------------------|-------------------------------|--------|
| `FMP_API_KEY` | Vercel env var (CLAUDE.md, Session 23) | Hardcoded in `api_portfolio_for_ai_v2.js` line 10; also printed in MASTER_RULES v21 line 411; also pasted into a chat session | 🔴 **Rotate now. Confirm deployed code reads `process.env.FMP_API_KEY`. The key value that appears in these files must be considered compromised.** |
| `BRIEFING_API_KEY` (API auth token, default `theisilabs2026`) | Vercel env var | Leaked in git history; endpoint historically accepted no-key requests. **Hardcoded fallback known in at least: `api/update-portfolio.js` (line 5), plus `api_portfolio_for_ai_v2.js`. Brief calls update-portfolio "the 3rd file with it" → grep the whole `api/` folder for all occurrences before rotating.** | 🔴 **Rotate token + close no-key gap + remove ALL hardcoded fallbacks.** |
| Telegram bot tokens | Make.com connections only | Security bot token printed in MASTER_RULES v21 line 61 | 🔴 **Treat as exposed; rotate via BotFather.** |
| Unsplash access key | Make.com Unsplash modules (client_id) | — | ⚠️ Verify not committed elsewhere |

> **Rule going forward:** no live secret in any repo file or any reference doc.
> Secrets live in Vercel env vars (code) or Make.com connections (orchestration) only.

---

## 2. GOLDEN RULES (reconciled — these win over all older docs)

1. **Never start over.** Build on what exists (20+ sessions of work). ✅
2. 🔴 **SPUS is a NORMAL ETF — RECONCILED CONFLICT.**
   - **WINS:** CLAUDE.md (Session 23): *"SPUS is a normal Sharia-compliant ETF;
     it gets NO special treatment, evaluated on merit like any holding, and is
     NOT excluded from sell/reduce recommendations."*
   - **OVERRIDES:** MASTER_RULES v21 (lines 74, 555), THEISI_SYSTEM_REFERENCE
     (line 56), and SCORING_ENGINE_FRAMEWORK v1 (line 222), all of which said
     *"SPUS — never sell under any condition."*
   - **ACTION:** Any Claude prompt module or doc still carrying the old
     "never sell SPUS" rule must be updated to the new rule.
3. **No shorts, no options.** Long positions and ETFs only (platform constraint;
   do not hardcode a broker name in code). ✅
4. **UAE investor — zero capital-gains tax.** Factor into sizing; don't let tax
   thinking block a good decision. ✅
5. 🔴 **LEGAL TIERING — 255 vs 357 (must never be blurred).**
   - **Scenario 255 (Intelligence Engine, Rashed only):** full-freedom,
     specific advice.
   - **Scenario 357 (User Analysis Engine, all other users):** **informational
     only**, restrained, with a **"not financial advice" disclaimer**.
   - The profile system must **NOT** turn 357 into 255. Other users always get
     the informational tier + disclaimer. This is a legal guardrail.
6. **No hardcoded identity.** Investor identity/size/preferences must come from
   the data (the `profile` block + holdings), **never** from prompt text. (See
   §9b Profile System — Phase 4 removes the remaining hardcoded lines.) 🔴 in progress.
7. **All Telegram output = Arabic.** Dashboard EN/AR toggle, default EN. ✅
8. **Explain before doing.** Owner is non-technical; be specific and concrete. ✅
9. **Commit after each working change** (clean rollback points). ✅
10. **Never guess code state** — read the current file before changing it. ✅
11. **Update THIS SSOT whenever anything changes**, version it, present for
    download, replace the old copy in the project. (Replaces the old per-file
    "Rule 0" update rules that created the version sprawl.) ✅

---

## 3. PORTFOLIO

| Item | Value | Confidence |
|------|-------|-----------|
| Holdings | Tech, ETF, Biotech, Mining, Speculative. **Stock count varies by source (44 / 52) and value (~$612K / ~$673K / ~$700K) — do NOT treat any as fixed; both are computed live.** | ✅ |
| Live value | Computed from Yahoo prices, **never hardcoded** | ✅ |
| Broker | Wio Invest, Abu Dhabi UAE (long-only) | ✅ |
| Source of truth | `data/portfolio.json` on GitHub (admin/Rashed schema) | ✅ |
| Notable position | WOLF — critical loss ~-97%, ~$41 remaining | ✅ |

> **TWO PORTFOLIO SCHEMAS (important for any write code):**
> - **Admin/Rashed** → `data/portfolio.json` uses `holdings` / `cash_summary` / `profile`.
> - **Named users** → `data/portfolio-<nickname>.json` uses `stocks`.
> Any save/merge logic must detect which schema and not corrupt the other.

> **RECONCILED:** Old docs gave conflicting fixed figures (44 vs 52 stocks;
> $612,774 / $662K / $673K / ~$700K value). All are stale point-in-time
> snapshots. **Value and count are computed live — never hardcode either.**

---

## 4. SYSTEM STATUS (what works today)

| Component | Status | Schedule (UAE) |
|-----------|--------|----------------|
| 🌅 Morning Brief → Telegram | ✅ Working | 7:00 AM |
| 🧠 Intelligence Engine → Dashboard + Telegram | ✅ Working | ~7:10 AM |
| 👥 User Analysis Engine → per-user analysis | ✅ Working | 7:30 AM |
| 📱 Instagram carousel (5 slides) | ✅ Working (auto, scheduled) | daily |
| Dashboard auth (PIN, invite codes, lockout) | ✅ Working | — |
| Price alerts | ✅ Working | — |
| Deep-analysis scoring engine | ✅ Working | — |
| Live prices (Yahoo) | ✅ Working | — |

> **RECONCILED — Instagram & deep analysis:** The original onboarding note listed
> Instagram as "Pending (Facebook issue)" and deep analysis as "Not built yet."
> Both are now **live** (Instagram Facebook issue fixed 2026-05-31; scoring engine
> built and working). The onboarding note is fully superseded.
>
> **MINOR DRIFT — intelligence run time:** docs show 7:05 vs 7:10. Newest
> (CLAUDE.md / System Reference) say **7:10 AM**. ⚠️ Verify exact schedule in Make.com.

---

## 5. MAKE.COM SCENARIOS (orchestration)

> Make.com **cannot be edited from code or Claude Code.** All prompt/module
> changes are done by hand in the Make UI; there is no version control on this
> layer. Prepare exact text/formulas for the owner to paste.

| Scenario (shorthand) | Make.com ID | Purpose | Schedule (UAE) | Output |
|----------------------|-------------|---------|----------------|--------|
| 🌅 Morning Brief ("977") | **5826977** | Market summary | 7:00 AM | Telegram |
| 🧠 Intelligence Engine / Private Advisor ("255") | **5904255** | Daily/Weekly/Monthly analysis + scoring | ~7:10 AM | Dashboard + Telegram |
| 👥 User Analysis Engine ("357") | **5958357** | Per-user analysis | 7:30 AM | Dashboard per user |
| 📱 Instagram ("754") | **5832754** | 5-slide Arabic carousel | daily | Instagram |

> **RECONCILED — scenario IDs:** The IDs above are **consistent** across all
> current docs; the "977/255/357/754" names are just the last-3-digit shorthands.
> The only stray value, **`5827323` ("Price Alerts")**, comes from the original
> onboarding note and is an **old/retired scenario** — drop it from all references.

**Make.com conventions (use exactly):**
- Claude module output: `{{moduleNumber.content[1].text}}`
- UAE timezone: `addHours(now;4)`
- HTTP body carrying Claude content: **Custom** content type (NOT application/json)
- Claude modules = native Anthropic "Create a Prompt" (NOT HTTP)
- Model string: `claude-sonnet-4-20250514`
- HTTP "Parse response" OFF → data in `{{module.data}}`; ON → fields direct
- hcti.io body type = Custom (avoids JSON validation issues)
- Unsplash image URL = `{{module.urls.regular}}`

**Router day filters (shared by Intelligence Engine + User Analysis Engine):**
- Monthly: `formatDate(addHours(now;4);"dddd") = Sunday` AND `formatDate(addHours(now;4);"D") <= 7`
- Weekly: `formatDate(addHours(now;4);"dddd") = Saturday`
- Daily: fallback (Mon–Fri)

**Claude prompt modules in Intelligence Engine (255):** ⚠️ module numbers below
are from MASTER_RULES v21 — verify against the live scenario before editing.

| Run | Module | Notes |
|-----|--------|-------|
| Daily | 7 | |
| Weekly | 15 | insider framing added (S22) |
| Monthly Part A | 14 | Competitive Edge; insider framing (S22) |
| Monthly Part B | 43 | Long View + Portfolio Health; insider framing (S22) |
| Monthly save | 19 | content: `{{14.content[1].text}}{{43.content[1].text}}` |

> **DISCREPANCY (unresolved, ⚠️):** Older docs reference Monthly Part A as
> Module **44**, newer as Module **14**. Confirm the live module number in Make
> before touching it.

---

## 6. COMPUTE — VERCEL FUNCTIONS

- **Hard limit: 12 serverless functions, currently AT the limit.** A new API
  route requires removing/merging an existing one. Plan around this. ✅
- **`api/portfolio-for-ai.js`** — main data endpoint. Returns the portfolio as
  **formatted plain text** for Claude. Params: `?nickname=NAME` (per-user;
  default = primary user) and `?include=intelligence` (appends FMP technicals,
  earnings, targets, grades, key-metrics-TTM, DCF, insider activity). ✅
- **`api/analysis.js`** (+ related) — saves/serves daily/weekly/monthly analysis. ✅
- Vercel function timeout raised to 60s for portfolio-for-ai.js. ✅
- Live-price source inside the function: **Yahoo Finance chart endpoint** (no key). ✅

> **RECONCILED — top 10 vs top 20:** The code snapshot uses **top 10** non-ETF
> holdings for per-symbol analyst/metrics calls (`slice(0, 10)`), and **all**
> symbols for technical indicators. Some docs say "top 20." ⚠️ Confirm the
> deployed value; treat **top 10** as current unless production shows otherwise.

---

## 7. KNOWN CODE-SNAPSHOT vs PRODUCTION GAP (important)

The file `api_portfolio_for_ai_v2.js` in the project is an **older snapshot** and
must NOT be treated as production truth. Evidence:
- It **hardcodes the FMP key** (line 10) although newer docs say it was moved to
  `process.env.FMP_API_KEY` and rotated.
- It uses `top10` for analyst/metrics, matching v21 but possibly not the latest.
- It does **not** show the insider-activity feature that THEISI_SYSTEM_REFERENCE
  (Session 22) says shipped — so the deployed file is newer than this snapshot.

🔴 **ACTION:** Pull the current `api/portfolio-for-ai.js` from the deployed Vercel
project / GitHub `main`, and re-baseline §6 and the secrets table against it.
Until then, code-level claims here are "best known," not confirmed.

---

## 8. DATA SOURCES

| Source | Used for | Auth |
|--------|----------|------|
| FMP (stable API, **$29 Starter**) | RSI, MACD (or self-calc from EMA12/EMA26), SMA50/200, EMA20, Bollinger, earnings calendar, price-target consensus, analyst grades, key-metrics-TTM (ROE/ROIC/margins), DCF, historical P/E + PEG, insider activity | Vercel env key |
| **Finnhub (free) — second source for CP3 cross-check (planned, not built)** | ROE / P/E / PEG / margins cross-check via `stock/metric?metric=all`. **Price-target gated on free — not used.** | free key (env) |
| Yahoo Finance | Live prices (chart endpoint) | none |
| NewsAPI | News feed (Morning Brief) | key |
| Alpha Vantage | Market data (Morning Brief). **Free tier 25 req/day — too small for fundamentals cross-check; ruled out for CP3.** | key |
| Seeking Alpha RSS | Articles / sentiment | none |
| Unsplash | Instagram background photos | client_id |

> **✅ VERIFIED 2026-06-03 (NVDA spot-check):** On the live **$29 Starter** key,
> these FMP endpoints all return full data — `key-metrics-ttm`,
> `discounted-cash-flow` (DCF works, NOT gated), `ratios-ttm`,
> `price-target-consensus`, `grades-consensus`. So the old docs' claim that
> these need "Premium $69" is **wrong** — they work on $29. Finnhub free returns
> ROE/PE/PEG/margins matching FMP closely (ROE 111.7% vs 111.66%).
>
> 🔴 **DESIGN RULE for the cross-check:** FMP `returnOnInvestedCapitalTTM` (63%)
> ≠ Finnhub `roiTTM` (105%) — **different definitions, never compare them.**
> Only cross-check definition-matched pairs (ROE↔ROE, PE↔PE, etc.). Full detail
> in `THEISI_CP3_SECOND_SOURCE_RESEARCH_v1`.

> **KNOWN ISSUE (⚠️):** Insider feature adds ~30–40 FMP calls/run and has hit
> "Too Many Requests." On $29 Starter the per-minute cap is 300, so this is
> likely a burst/concurrency issue, not the rate cap — confirm. (Open task.)

---

## 9. SCORING ENGINE (analysis logic)

Score = a **"should I act NOW" timing signal, 1–10** — NOT a company-quality
rating. Same stock can score 3 one week and 8 the next.

**Five weighted layers:** Personal Position 15% · Valuation 30% · Technical 20% ·
Fundamental 25% · External 10%.
**Final = L1·0.15 + L2·0.30 + L3·0.20 + L4·0.25 + L5·0.10**, rounded to 1–10.

**Bands:** 9–10 strong buy · 7–8 buy · 5–6 hold · 3–4 reduce (sell 25–50%) ·
1–2 exit.

**Rules:** Buy needs ≥3 institutional buy-signals; any one sell-rule triggers a
reduce. Position sizing: Goldman 25% (first cut 25%, never instant full exit),
max 50%/week unless thesis broken, 2% portfolio-risk for adds, new positions
1–2% and only at score ≥8. Every sell must state exact shares/price/$ and a
destination for freed capital. Institutions cited: Goldman, Renaissance,
Bridgewater, Graham, Lynch, Druckenmiller, Buffett, Marks, McKinsey (moat).

> The full layer-by-layer rule tables live in `SCORING_ENGINE_FRAMEWORK_v1`.
> That file is still valid **except** its line 222 "SPUS never sell" — overridden
> by Golden Rule 2 above.

---

## 9b. PROFILE SYSTEM (active workstream — de-hardcode investor identity)

**Goal:** replace hardcoded investor identity in prompts with a dynamic per-user
`profile`, so adding a user "just works" and no personal data sits in prompt text.
Master plan: `PROFILE_SYSTEM_PLAN.md`. Phase 2 design: `PHASE2_DESIGN_BRIEF.md`.

**Profile data shape** (top-level `profile` key in each user's portfolio JSON,
all fields optional; defaults: riskTolerance=low, timeHorizon=long):
`cashToInvest` (num) · `riskTolerance` (low/med/high) · `timeHorizon`
(short/med/long) · `goals` (text) · `constraints` (text) · `notes` (text).
Guardrail: missing profile/fields → safe defaults, never error.

**Phases:**
- **Phase 1 — API reads & delivers profile** (`api/portfolio-for-ai.js`): appends
  an INVESTOR PROFILE block for all requests. ✅ live (per plan).
- **Phase 2 — Save endpoint** (extend `api/user-portfolio.js`, no new function):
  read-modify-write + merge (must not wipe holdings/profile), schema-aware (two
  schemas), SHA optimistic lock + retry, ~5s per-user rate limit, clear status
  codes/messages. ⏳ design stage (`PHASE2_DESIGN_BRIEF.md`).
- **Phase 3 — Dashboard form** ("My Profile" tab, EN/AR, mobile, JWT auth). ⏳ later.
- **Phase 4 — Make.com prompt cleanup (MANUAL):** remove hardcoded "Rashed",
  fixed portfolio size, identity lines from **255 modules 7/14/43/15** and add
  the "use INVESTOR PROFILE" pointer (+ disclaimer) to **357 modules 13/7/15**. ⏳

**Storage/concurrency reality:** GitHub-as-DB is a known temporary bridge. The
357 batch job also writes user files, so writes must be serial and use the file
SHA as an optimistic lock. Design the profile shape cleanly for a future DB.

> 🔴 **Known overwrite bug (data loss):** the current portfolio POST rebuilds the
> file as `{nickname, stocks, lastUpdated}` and **drops any existing `profile`**.
> Must become read-modify-write. This is exactly the silent-failure class the
> reliability program targets (CP2/CP4). Tracked in Open Tasks.

---

## 10. DASHBOARD

- Single-file `index.html`. Latest versioned name found: `index_v10_2026-05-30.html`. ✅
- **AI-Advisor tab — 10 sub-tabs in 3 groups:**
  - Daily (Mon–Fri): DS (Daily Signals) · EE (Earnings & Events) · MX (Macro Today) · SC (Scoring Engine)
  - Weekly (Sat): RR (Risk Radar) · FV (Fair Value) · MO (Momentum)
  - Monthly (1st Sun): CE (Competitive Edge) · LV (Long View) · PH (Portfolio Health)
- Section markers parsed from analysis text, e.g. `═══ DAILY SIGNALS ═══`, etc. ✅
- **Auth:** nickname + 4-digit PIN (numpad); sign-up via invite code (XXXX-XXXX);
  7-day localStorage session; lockout after 3 attempts then (n−3)×5 min; failed
  logins alert @theisilabs_securitybot; admin `rashed` manages invites/PINs/unlocks. ✅

---

## 11. OPEN TASKS (reconciled, deduped)

🔴 = security/correctness · ⏳ = enhancement

1. 🔴 Rotate FMP key; confirm deployed code uses `process.env.FMP_API_KEY` (§1, §7).
2. 🔴 Rotate `theisilabs2026` auth token; close the no-key auth gap on the endpoint.
3. 🔴 Rotate the Telegram security-bot token (printed in v21).
4. 🔴 Re-baseline this SSOT against the **deployed** `portfolio-for-ai.js` (§7).
5. ⚠️ Confirm Make.com module numbers (Monthly A = 14 vs 44) before editing.
6. ⚠️ FMP burst/concurrency on insider feature (~30–40 calls/run) — confirm it's
   bursting, not the 300/min cap; throttle/batch if needed.
7. ✅ **DONE — FMP $29 endpoint audit** (DCF + TTM metrics all work on $29; "$69"
   docs corrected). Verified 2026-06-03.
8. ⏳ Reliability program (separate doc: ARCHITECTURE_AND_RELIABILITY_REVIEW_v1) —
   monitoring + checkpoints. Build order: CP6 → CP2 → CP3 → CP1 → CP5 → CP4.
9. ⏳ **CP3 build** — add Finnhub free cross-check (ROE/PE/PEG/margins only;
   definition-matched pairs; ROIC/DCF/targets stay FMP-only) inside
   `portfolio-for-ai.js`. Configurable N, start top 10. See CP3 doc §9.
10. 🔴 **Fix portfolio-save overwrite bug** — POST drops existing `profile`;
    make it read-modify-write (Profile System Phase 2). Silent data loss.
11. ⏳ Multi-user `?nickname=` hardening (mind 12-function limit).
12. ⏳ Profile System Phases 2–4 (save endpoint → dashboard form → prompt cleanup).
13. ⏳ Railway migration to replace Make.com orchestration (multi-session).
14. ⏳ Dashboard footer disclaimer text (+ 357 "not financial advice" disclaimer).
15. ⏳ 90-day GitHub data cleanup after API consolidation.
16. ⏳ Favicon / landing page (waiting on logo).

---

## 12. FILE DISPOSITION (what to keep vs archive)

**Archive (superseded by this SSOT — move to `archive/`, do NOT hard-delete; they
contain live secrets, see note):**
- `MASTER_RULES_AND_REFERENCE_v5 … v21` (all versions)
- `THEISI_SYSTEM_REFERENCE.md` (**3 duplicate copies seen in repo — archive all**)
- `SESSION_21_SUMMARY_2026-06-01.md`
- `project_documentation_financial_advisor.md` (original onboarding note)
- `make_com_reference.md` / `make_com_complete_reference.md` — fold needed Make
  conventions into §5 first, then archive.

**Keep active alongside this SSOT:**
- `CLAUDE.md` — Claude Code working contract (points here).
- `SCORING_ENGINE_FRAMEWORK_v1` — scoring tables (valid except SPUS line).
- `THEISI_ARCHITECTURE_AND_RELIABILITY_REVIEW_v1` — reliability proposal.
- `THEISI_CP3_SECOND_SOURCE_RESEARCH_v1` — second-source research (decided).
- `PROFILE_SYSTEM_PLAN.md` — **active** 4-phase plan (Phase 1 live, 2–4 open).
- `PHASE2_DESIGN_BRIEF.md` — **active** Phase 2 design task.
- `BUILD_SPEC_investor_profile.md` / `BUILD_SPEC_insider_activity.md` — keep if
  still referenced by active phases; archive only if fully built + documented here.

**Do NOT touch (running system):** `api/`, `data/`, `index*.html`, `package.json`,
`vercel.json`, icons, `test-profile-save`.

> 🔴 **Rotate before removing.** The archive files print the live FMP key, the
> `theisilabs2026` token, and the Telegram bot token in plaintext. Deleting a
> file does NOT remove it from git history — rotating the secrets is what
> actually protects you. Order: rotate secrets → then archive files.

---

## 13. HOW TO START A NEW SESSION

Tell Claude:
> "I am Rashed, continuing the Theisi Labs Arabic Finance Intelligence System.
> Read THEISI_SSOT.md first, then CLAUDE.md."

Claude must: (1) read this SSOT first; (2) never change code without seeing the
current file; (3) treat ⚠️/🔴 items as unconfirmed until checked in production;
(4) update this SSOT when anything changes — **overwrite the same file
`THEISI_SSOT.md` and bump the internal version; never create a new dated copy**
(that habit caused the original version sprawl).

---

*End of SSOT v1. Reconciliation method and authority chain are stated at the top
so every resolved conflict can be audited. Items tagged ⚠️ require production
confirmation; items tagged 🔴 are outstanding actions.*
