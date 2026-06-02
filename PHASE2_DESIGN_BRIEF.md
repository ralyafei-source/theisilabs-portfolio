# PHASE 2 DESIGN BRIEF — Profile Save Endpoint
**For Claude Code. Produce a reviewable DESIGN (no code yet) for adding
profile-saving to api/user-portfolio.js. Hand the plan back for approval first.**

---

## CONTEXT
We added an optional `profile` block to portfolio data (Phase 1, live). Now users
need to SAVE their profile from the dashboard. Constraints:
- At the 12-function Vercel limit → NO new function. Extend api/user-portfolio.js.
- Data lives in GitHub (per-user data/portfolio-<nickname>.json; Rashed =
  data/portfolio.json with a different schema). GitHub-as-DB is a known temporary
  bridge; design the profile DATA SHAPE cleanly so a future DB migration is painless.

## KNOWN ISSUES TO SOLVE (from investigation)
1. **Overwrite bug:** current POST rebuilds the file as `{nickname, stocks,
   lastUpdated}` — it DROPS any existing `profile`. Must become read-modify-write.
2. **Two schemas:** named users use `stocks`; Rashed's portfolio.json uses
   `holdings`/`cash_summary`/`profile`. Saving must not corrupt either.
3. **Concurrency:** GitHub contents API must be used serially; the 357 batch job
   also writes files. Use the file SHA as an optimistic lock.

## REQUIREMENTS FOR THE DESIGN
1. **Read-modify-write + merge.** Load existing file → merge change → write back.
   - Saving `profile` must NOT wipe `stocks`/`holdings`.
   - Saving `stocks` must NOT wipe `profile`.
   - Only the provided keys change; everything else is preserved.
2. **Accept optional `profile`** in the request; validate fields (enums valid,
   numbers numeric, free-text length-capped, unknown fields ignored).
3. **Schema-aware:** detect named-user (`stocks`) vs admin/Rashed
   (`holdings`/`cash_summary`) and merge into the correct shape. If admin saving
   via this endpoint is risky, say so and propose how to handle Rashed's file.
4. **SHA optimistic lock + retry:** read the SHA fresh immediately before PUT; on
   a stale-SHA conflict (409), re-read and retry up to ~2x; if still failing,
   return an error (do NOT blind-overwrite).
5. **Per-user rate limit (~5s):** reject a save if the same user saved < 5s ago.
   - Serverless has no memory between calls → store `lastProfileSave` (timestamp)
     on the user record in users.json (auth already reads/writes it). Address WHERE
     this state lives in the design.
6. **Clear status codes + messages (no silent failure):**
   - 200 → `{ ok:true, message:"Saved" }`
   - 429 → `{ ok:false, message:"Please wait a moment before saving again" }`
   - 409/500 → `{ ok:false, message:"Couldn't save — please try again" }`
   - Response body always has a human-readable `message` for the dashboard to show.
7. **Auth unchanged:** keep the existing session-token verification (user can only
   write their OWN file). Reuse existing ghGet/ghPut helpers. No new function.

## ALSO NOTE (not part of this build, just flag)
- api/update-portfolio.js line 5 still has the hardcoded `theisilabs2026` fallback
  (3rd file with it). Token rotation still outstanding.

## DELIVERABLE
A step-by-step design: request shape, validation, merge logic per schema, SHA/retry
flow, rate-limit storage + check, and the exact response codes/messages. NO code
until approved.

## PHASE 3 (later, dashboard) — depends on this
The profile form will call this endpoint and display the returned `message`:
"Saved" / "Please wait..." / "Couldn't save...". Built after Phase 2 ships.
