# Build Spec — Insider Activity Signal

**For:** Claude Code, working in `theisilabs-portfolio`
**Target file:** `api/portfolio-for-ai.js`
**Goal:** Add insider-trading activity as an institutional-behavior signal
feeding the WEEKLY and MONTHLY analysis layers (not daily).

---

## CONTEXT / WHY

The user wants to see "where smart money is flowing." FMP's 13F endpoints are
restricted on the current plan, but the **insider-trading statistics** endpoint
IS available and is a fresher, arguably stronger signal. This spec adds it.

Do NOT add a new Vercel function — the project is at the 12-function limit.
Fold this into the EXISTING `portfolio-for-ai.js`, under the existing
`?include=intelligence` flag, appended to the intelligence text block.
Same pattern as the Session 17 market-intelligence merge.

---

## DATA SOURCE

Endpoint (confirmed working on current plan):
```
GET https://financialmodelingprep.com/stable/insider-trading/statistics?symbol={SYM}
```
- One symbol per call. Returns the stock's FULL quarterly history (1999 → present).
- Use the existing `fmpGet()` helper and `FMP_KEY` already in the file.

### Field meaning (critical — see INTERPRETATION RULES)
- `totalPurchases` — count of OPEN-MARKET purchases. **THE signal field.**
- `acquiredTransactions` / `totalAcquired` — includes grants, vesting, options.
  Mostly comp, NOT conviction. Discount heavily.
- `disposedTransactions` / `totalDisposed` / `totalSales` — selling. Mostly
  routine (tax, diversification, 10b5-1). NOT bearish on its own.
- `acquiredDisposedRatio` — context only, not a standalone signal.

---

## WHAT TO FETCH

Cover: all PORTFOLIO non-ETF holdings + the current market movers already
tracked in the intelligence block (`moverSyms`). Skip ETFs entirely — ETFs have
no insiders; calling the endpoint for them is meaningless.

Trim each response to the **last 4 quarters only** before doing anything else.
Discard everything older. The 25-year history is not sent to the AI.

Call volume: one call per covered symbol. This only runs on weekly/monthly, so
it's acceptable. Use `Promise.allSettled` (like the existing technical-indicator
calls) so one failure doesn't break the block. 5s per-call timeout, consistent
with the existing v3 timeout pattern.

---

## WHAT TO COMPUTE (per stock, from the last 4 quarters)

Build a small summary object per symbol:
- `recentPurchases` = sum of `totalPurchases` across last 4 quarters
- `purchaseQuarters` = how many of the last 4 quarters had any open-market buys
- `netSelling` = whether disposals heavily outweigh acquisitions (context label)
- A one-line plain-language verdict using the INTERPRETATION RULES below

Keep it compact — this is a summary for the AI, not a data dump.

---

## INTERPRETATION RULES (bake these into the summary text)

These must be explicit so the AI does NOT read the data naively:

1. **Open-market BUYING is the signal.** `totalPurchases > 0`, especially
   across multiple quarters or clustered, = genuine insider conviction =
   meaningful bullish input.
2. **SELLING is mostly noise.** High disposals / low ratio is NORMAL, especially
   for stocks up a lot. Do NOT treat selling as bearish unless it is an extreme,
   unusual spike. Routine selling = no signal.
3. **"Acquired" ≠ "bought."** Large `totalAcquired` with `totalPurchases = 0`
   means grants/vesting, NOT conviction. Treat as neutral. (NVDA is the textbook
   example: huge acquired, zero purchases → no real buying signal.)
4. **No purchases = no signal**, not a negative. Most stocks most quarters show
   no open-market buying; that's the default, not a warning.

---

## OUTPUT — append to the intelligence text block

Add a clearly-labelled section to the plain-text the endpoint returns, e.g.:

```
═══════════════════════════════════════════════════════
INSIDER ACTIVITY (last 4 quarters — open-market buying is the signal)
═══════════════════════════════════════════════════════
NVDA — no open-market buying; routine comp selling only → NEUTRAL
SYM  — open-market buying in 3 of last 4 quarters → CONVICTION SIGNAL ✅
...
INTERPRETATION: Insider BUYING = conviction. Insider SELLING = mostly routine,
not bearish. Absence of buying is neutral, not negative.
```

Portfolio stocks first, then movers.

---

## WHERE IT FEEDS (analysis layers)

- Append only when intelligence is requested. In Scenario 255, this block is
  consumed by the WEEKLY (Module 15) and MONTHLY (Modules 44/43) Claude prompts.
- It must NOT influence daily timing/technical signals.
- In the scoring framework it is a Layer 5 (External) / Layer 4 (conviction)
  input — supports thesis strength, never a standalone buy/sell trigger.

### Prompt framing to add to the weekly + monthly Claude prompts (Make.com — paste manually)
> An INSIDER ACTIVITY section is included. Open-market insider BUYING (especially
> repeated or clustered) is a genuine conviction signal and supports a bullish
> read. Insider SELLING is mostly routine (tax, diversification, scheduled plans)
> and must NOT be treated as bearish unless extreme. No buying = neutral, not
> negative. Use this to assess conviction and where institutional/insider money
> is flowing — never as a timing trigger.

---

## CONSTRAINTS / REMINDERS

- No new Vercel function (12-function limit).
- Don't hardcode secrets; use existing env-based FMP key handling.
- Show the diff before applying; commit with a clear message; push triggers Vercel.
- ETFs excluded from insider calls.
- Phase 2 (later, optional): use the full 1999→now history to compute a
  per-stock baseline and flag buying that is unusual RELATIVE to that stock's
  own norm. Not in this build.
```
