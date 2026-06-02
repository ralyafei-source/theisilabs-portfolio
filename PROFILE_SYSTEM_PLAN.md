# PROFILE SYSTEM — COMPLETE PLAN & REQUIREMENTS
**Goal:** Replace hardcoded investor info with dynamic, per-user profiles that
users can enter on the dashboard. Each user's analysis adapts to their own
profile + holdings. Future-proof: no hardcoded identities, optional fields,
nothing blocks if data is missing.

Written end of Session 22 for Session 23+. Do phases IN ORDER — each depends on
the previous. Don't build the dashboard form before the API can save/read profiles.

---

## THE BIG PICTURE (why, in one paragraph)
Today the AI's investor identity ("Rashed, $673K, 52 stocks, zero tax, no options,
SPUS rule") is hardcoded into the Make.com prompts. That's not future-proof and
leaks personal data. The fix: store an optional `profile` per user alongside their
holdings, have the API deliver it dynamically, clean the hardcoded lines out of the
prompts, and give users a dashboard form to manage their own profile. Result: add a
user → they bring their own profile → every prompt adapts automatically.

---

## GUARDRAILS (carry through every phase)
- **Optional & non-blocking:** missing profile or fields → safe defaults, never error.
- **Defaults:** riskTolerance=low, timeHorizon=long. No assumed cash.
- **Tiering (legal):** 255 = Rashed only, full-freedom advice. 357 = other users,
  restrained/informational. Profile system must not turn 357 into 255. Keep 357's
  advice informational; add a "not financial advice" disclaimer for other users.
- **No hardcoding:** identity/portfolio size must come from data, not prompt text.
- **No new Vercel function** (at 12-limit). Fold into existing endpoints.
- **Commit via PowerShell** (Claude Code commit hangs on Windows).
- **Don't commit secrets.** (Ties to the parked token-rotation task.)

---

## PROFILE DATA SHAPE (first version — 6 fields, all optional)
Lives as a top-level `profile` key inside each user's portfolio JSON.
```json
"profile": {
  "cashToInvest": 25000,
  "riskTolerance": "low|medium|high",     // default low
  "timeHorizon": "short|medium|long",     // default long
  "goals": "free text",
  "constraints": "free text (e.g. no options, Sharia-only)",
  "notes": "free text catch-all"
}
```
Future fields (later, no code rework needed): monthlyContribution, liquidityNeeds,
sectorExposureElsewhere, etc.

---

## PHASE 1 — API reads & delivers profile  ← START HERE (spec already written)
**File:** api/portfolio-for-ai.js
**Spec:** BUILD_SPEC_investor_profile.md (already in repo/outputs)
**What:** After holdings load (both branches), read optional `profile`, apply
defaults, append an INVESTOR PROFILE text block before the intelligence block,
for ALL requests.
**Requirements / done-when:**
- [ ] `/api/portfolio-for-ai?nickname=asma` shows INVESTOR PROFILE block.
- [ ] Set fields display; unset fields show defaults (risk/horizon) or are omitted.
- [ ] `/api/portfolio-for-ai` (Rashed, no profile) still works, no error, shows defaults.
- [ ] No new function; both branches unaffected; defensive (no throw if absent).
- [ ] Committed via PowerShell + pushed + verified on live URL.
**Test data:** add a small `profile` to data/portfolio-asma.json first.

---

## PHASE 2 — API endpoint to SAVE a profile
**Why:** the dashboard form needs somewhere to write to. The profile lives in the
user's portfolio JSON in GitHub; saving means committing to that file via an API.
**Decision needed:** there's likely already an endpoint that writes portfolio data
(e.g. /api/update-portfolio or /api/portfolio writing to GitHub). REUSE or EXTEND
it rather than adding a new function (12-limit). Check how existing writes work
(GitHub token / commit via API) and add profile-write to the same path.
**Requirements / done-when:**
- [ ] Authenticated user (their JWT) can POST their profile fields.
- [ ] Saves to THEIR file only (data/portfolio-<nickname>.json), never another user's.
- [ ] Validates input (numbers are numbers, enums are valid, free-text length-capped).
- [ ] Missing fields allowed (partial save). Never wipes holdings.
- [ ] No new Vercel function — extend an existing writer.
**Security note:** writing to GitHub needs a token — server-side env var only,
never exposed to the browser. Confirm how current portfolio writes authenticate.

---

## PHASE 3 — Dashboard form (index.html)
**Why:** let users enter/edit their profile in the UI.
**What:** a "My Profile" section/tab, visible when logged in (JWT auth exists).
Fields: cashToInvest (number), riskTolerance (select, default low),
timeHorizon (select, default long), goals/constraints/notes (text). Save button
→ calls Phase 2 endpoint. Show current values on load.
**Requirements / done-when:**
- [ ] Logged-in user sees their own profile, pre-filled if set.
- [ ] Can edit + save; confirmation on success; errors shown clearly.
- [ ] Empty form is valid (all optional). Defaults indicated in UI.
- [ ] EN/AR bilingual (matches dashboard; default EN).
- [ ] Mobile-friendly (dashboard is used on phone).
- [ ] No browser storage of secrets; JWT used for auth like other dashboard calls.
**Read first:** /mnt/skills/public/frontend-design + how index.html does its
existing authed sections (e.g. user-portfolio, generate-analysis use Bearer JWT).

---

## PHASE 4 — Prompt cleanup (Make.com — MANUAL, can't be done from Claude Code)
**Why:** make prompts use the dynamic profile instead of hardcoded identity.
**Where:** Scenario 255 modules 7, 14, 43, 15 (remove "Rashed", "$662K/$673K",
"52 stocks", and hardcoded profile lines → replace with "use the INVESTOR PROFILE
section in the data"). Scenario 357 modules 13, 7, 15 (already generic, but add
the same "use INVESTOR PROFILE" pointer + the not-advice disclaimer for others).
**Requirements / done-when:**
- [ ] No personal name or fixed portfolio size remains in any prompt.
- [ ] Prompts instruct: read identity/size/prefs from INVESTOR PROFILE + portfolio data.
- [ ] 255 keeps full-freedom advice (Rashed). 357 stays informational + disclaimer.
- [ ] Test run each scenario; confirm output reads correct profile, no stale numbers.
**Note:** do AFTER Phase 1 is live (profile block must exist in the data first).
Phase 4 can be done before Phases 2–3 if you just want the hardcoding gone — but
users can't self-edit until 2–3 ship.

---

## SUGGESTED ORDER & SESSION SIZING
- **Session 23:** Phase 1 (implement + test + ship). Then optionally start Phase 4
  prompt cleanup for 255 (since Phase 1 makes the profile available). Both are
  contained and testable in one session.
- **Session 24:** Phase 2 (save endpoint) — needs investigating the existing
  GitHub-writer endpoint first.
- **Session 25:** Phase 3 (dashboard form) — the biggest UI piece.
- Phase 4 finalized once all users can self-serve.

**Fastest path to value if impatient:** Phase 1 + Phase 4 alone removes the
hardcoding and makes analysis profile-aware for any user whose file has a profile
(you can hand-edit Asma's file). The dashboard form (2–3) is "self-service" polish.

---

## OPEN QUESTIONS TO RESOLVE NEXT SESSION
1. How do existing dashboard writes (update-portfolio / portfolio) authenticate to
   GitHub? (Determines Phase 2 approach.)
2. Should other users (357) get a hard disclaimer block in their saved output?
   (Legal — recommended yes.)
3. Do we want Phase 4 (de-hardcode prompts) done early, right after Phase 1?
