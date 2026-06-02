# THEISI LABS — SYSTEM REFERENCE & SESSION LOG
**Keep this updated each session. This is the catch-up doc — read it first.**
Last updated: 2026-06-02 (Session 23)

---

## SYSTEM FACTS
| Item | Value |
|------|-------|
| Live URL | https://theisilabs.vercel.app |
| GitHub | github.com/ralyafei-source/theisilabs-portfolio |
| Local repo | C:\Users\user\Documents\theisilabs-portfolio |
| Make.com | eu1.make.com/1748978 |
| FMP Plan | Premium $69/mo (13F NOT included; insider IS included) |
| FMP Base | https://financialmodelingprep.com/stable |
| Vercel functions | 12 (AT limit — no new functions) |
| Tooling | Claude Code installed (Code tab). Commit via PowerShell — Claude Code commit prompt hangs on Windows. |

---

## SCENARIO WORKFLOWS

### Scenario 255 — 🧠 Intelligence Engine (main, ~7:10 AM UAE)
Flow (left→right):
1. Top Users / Top Gainers / Sector Performance / Seeking Alpha → market data
2. Save New Market Data
3. **Module 12 — Portfolio Data** → calls `/api/portfolio-for-ai?include=intelligence`
   - Auth header: `Authorization: Bearer theisilabs2026` *(being added Session 22)*
4. **Router** splits by date:
   - Monthly (Sunday + day ≤7): Monthly Analysis A → Monthly Analysis B → Save Monthly
   - Daily (fallback): Daily Analysis → Save Daily → Instagram Summary → Telegram Send
   - Weekly (Saturday): Weekly Analysis → Save Weekly

### Scenario 5826977 — 🌅 Morning Brief (7:00 AM UAE) → Telegram
### Scenario 5958357 — 👥 User Analysis Engine (7:30 AM UAE)
### Scenario 5832754 — 📱 Instagram (daily)

---

## CLAUDE PROMPT MODULES (in Scenario 255)
| Run | Module(s) | Notes |
|-----|-----------|-------|
| Daily | 7 | |
| Weekly | 15 | insider framing added (Session 22) |
| Monthly Part A | 14 | Competitive Edge. insider framing added (Session 22) |
| Monthly Part B | 43 | Long View + Portfolio Health. insider framing added (Session 22) |
| Monthly save | 19 | content: `{{14.content[1].text}}{{43.content[1].text}}` |

Model string (Make.com): `claude-sonnet-4-20250514`
Claude module output: `{{module.content[1].text}}`
UAE time: `addHours(now;4)`

---

## GOLDEN RULES
- SPUS = normal ETF, evaluate on merits, NOT excluded from sells (changed S23 — was "never sell").
- No shorts/options — long + ETFs only (don't hardcode broker name).
- UAE investor, zero capital gains tax.
- Telegram output = Arabic. Dashboard EN/AR (default EN).
- Never start over — build on what exists.
- Don't commit secrets.

---

## OPEN TASKS
1. **Auth gap** — endpoint accepts NO-key requests. Fix to require key.
   Blocked until Module 12 sends the Authorization header (in progress S22).
2. **Token rotation** — `theisilabs2026` leaked in git history; rotate
   (new value in Vercel + all Make.com modules + scrub from docs).
3. **FMP rate limit** — insider feature adds ~30-40 calls/run; hit "Too Many
   Requests" on FMP modules. May need throttling or fewer symbols.
4. Multi-user (`?nickname=`), Railway migration, dashboard footer disclaimer.
5. **Track loose docs** — THEISI_SYSTEM_REFERENCE.md, BUILD_SPEC_*, PROFILE_SYSTEM_PLAN.md,
   test-profile-save.ps1 are untracked in the repo folder (not backed up on GitHub).
   `git add` + commit them when convenient (skip anything with secrets).

---

## SESSION LOG

### Session 23 — 2026-06-02
- **Phase 3 shipped — Investor Profile form in dashboard (index.html).** Endpoint
  untouched (`POST /api/user-portfolio` already accepts `{profile:{...}}` — built/tested S22-ish).
- Added: 👤 Profile nav tab; form with 6 spec fields (cashToInvest, riskTolerance
  [default low], timeHorizon [default long], goals, constraints, notes — all optional);
  `saveProfile()` + `loadProfile()`.
- Save: POSTs `{profile}` with Bearer token, sends only filled fields (blank → endpoint
  default), shows returned `message` (green 200 / red 429+errors), button disables during request.
- loadProfile() pre-fills on tab open (GET). Reads `data.portfolio.profile`.
- Tested live (theisilabs.vercel.app), all 4 pass: tab shows, green save, pre-fill +
  field removal sticks (endpoint is overwrite, so clearing a field removes it), 429 wait msg on rapid double-click.
- **Prompt cleanup complete — both scenarios.**
  - Scenario 255 modules 7/14/43/15: replaced hardcoded investor identity with INVESTOR CONTEXT block + pointer to INVESTOR PROFILE in {{12.data}}.
  - Scenario 357 modules 13/7/15: added same INVESTOR CONTEXT block + pointer to INVESTOR PROFILE in {{4.data}}. (Module 7 had no hardcoded identity but needed the pointer added.)
  - Confirmed INVESTOR PROFILE block present in both {{12.data}} and {{4.data}}.
- **SPUS rule changed:** no longer "never sell" — evaluated on merits like any ETF. Updated CLAUDE.md (rule 2) and THEISI_SYSTEM_REFERENCE.md golden rules. Broker name removed from rule 3.
- Git: untracked docs still loose in repo folder (THEISI_SYSTEM_REFERENCE.md, BUILD_SPEC_*, PROFILE_SYSTEM_PLAN.md, test-profile-save.ps1) — not tracked/backed up yet (housekeeping TODO).

### Session 22 — 2026-06-01
- Setup: Git installed, repo cloned locally, Claude Code working (reads CLAUDE.md).
- Removed hardcoded `BRIEFING_API_KEY` fallback from portfolio-for-ai.js (committed+pushed).
- **Insider-activity feature shipped**: FMP insider-trading/statistics added to
  intelligence block (non-ETF holdings + movers, last 4 quarters, open-market
  buying = signal). Code live & verified (NVDA → NEUTRAL correct). Framing added
  to Modules 15/14/43.
- Started auth-gap fix: adding Authorization header to Module 12 (testing).
- Discovered: FMP rate limit hit during testing (see open task 3).
- Note: Claude Code commit prompt hangs on Windows — commit via PowerShell instead.

### Session 21 — 2026-06-01 (earlier)
- portfolio-for-ai.js v6: FMP fixes, self-calc MACD, +earnings surprises, DCF,
  weekly change, hist PE+PEG, analyst consensus.
- All prompts rewritten. Dashboard fixes (markers hidden, monthly parsing,
  Competitive Edge tab).
