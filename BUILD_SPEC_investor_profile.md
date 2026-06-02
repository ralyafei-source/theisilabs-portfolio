# Build Spec — Optional Investor Profile Block

**For:** Claude Code, in `theisilabs-portfolio`
**Target:** `api/portfolio-for-ai.js`
**Goal:** Let each user's data file carry an OPTIONAL `profile` object that enriches
the analysis. Must NEVER block analysis if absent — safe defaults fill gaps.
Works the SAME way for all users (Rashed + named), as a separate block.

---

## DESIGN PRINCIPLE
- Profile is fully optional. Missing file / missing fields → use defaults, never error.
- One code path for everyone (do NOT wire into the two divergent branches).
- Read profile AFTER holdings load (after both Branch A and Branch B), so it's
  independent of the holdings/stocks schema difference.
- Future-proof: read whatever fields exist, ignore what doesn't. Adding fields
  later must not require code changes to "support" them.

---

## PROFILE SHAPE (all fields optional)
Stored inside the user's portfolio JSON file, as a top-level `profile` key:
```json
{
  "holdings": [ ... ],            // (or "stocks" for named users — unchanged)
  "profile": {
    "cashToInvest": 25000,        // number, USD. Cash available to deploy.
    "riskTolerance": "medium",    // "low" | "medium" | "high". DEFAULT: "low"
    "timeHorizon": "long",        // "short" | "medium" | "long". DEFAULT: "long"
    "goals": "growth",            // free text, e.g. "growth", "income", "preservation"
    "constraints": "no options, Sharia-compliant only",  // free text
    "notes": "anything the user wants the AI to know"     // free text catch-all
  }
}
```

## DEFAULTS when a field (or whole profile) is missing
- riskTolerance → "low"
- timeHorizon → "long"
- cashToInvest → not stated (omit the cash line; do NOT assume a number)
- goals / constraints / notes → omit the line if empty

---

## CODE CHANGE
1. After holdings are loaded (both branches), read `profile` from the parsed file
   object. If the file object has no `profile`, use `{}`.
   - Branch A (named user): the fetched JSON may have `profile`.
   - Branch B (Rashed): `portfolio.json` may have `profile`.
   - Use optional chaining; never throw if absent.
2. Apply defaults (risk=low, horizon=long). Leave cash/goals/constraints/notes
   empty if not provided.
3. Build an INVESTOR PROFILE text block (below) and append it to `text`
   AFTER the holdings/total section and BEFORE the intelligence block.
   It should appear for ALL requests (not gated by ?include=intelligence),
   since profile context helps daily/weekly/monthly alike.

---

## TEXT BLOCK FORMAT (only include lines for fields that exist)
```
═══════════════════════════════════════════════════════
INVESTOR PROFILE (use to tailor recommendations; absent fields use safe defaults)
═══════════════════════════════════════════════════════
Risk tolerance: LOW (default)            ← always shown (shows default if unset)
Time horizon: LONG-TERM (default)        ← always shown
Cash available to invest: $25,000        ← only if cashToInvest set
Goals: growth                            ← only if set
Constraints: no options, Sharia-only     ← only if set
Notes: <free text>                       ← only if set
INTERPRETATION: These are the investor's stated preferences. Respect constraints
as hard rules. If risk is low, favor capital preservation and avoid aggressive
recommendations. Use cash-to-invest for deployment suggestions. Absent fields = defaults; do not invent preferences.
```

---

## TEST (before commit)
1. Add a `profile` block to `data/portfolio-asma.json` with a couple of fields
   (e.g. cashToInvest + riskTolerance) — leave others out to test defaults.
2. Hit `/api/portfolio-for-ai?nickname=asma` (with auth header) → confirm the
   INVESTOR PROFILE block appears, set fields show, unset show defaults/omitted.
3. Hit `/api/portfolio-for-ai` (Rashed, no profile yet) → confirm it still works
   and shows the default risk/horizon lines, no cash line, no error.

---

## CONSTRAINTS / REMINDERS
- No new Vercel function.
- Don't break either branch; profile read must be defensive (no throw on missing).
- Show diff before applying. Commit via PowerShell (Claude Code commit hangs on Windows).
- Do NOT touch the Make.com prompts in this build — prompt cleanup (removing the
  hardcoded "Rashed / $673K / 52 stocks" lines and pointing them at this profile
  block) is a SEPARATE later step.

---

## NOT IN THIS BUILD (later sessions)
- Dashboard form for users to enter/edit their profile (needs a save API).
- Prompt cleanup in scenarios 255 (modules 7/14/43/15) and 357 (13/7/15):
  remove hardcoded investor identity + stale portfolio sizes, point at the
  INVESTOR PROFILE block instead.
