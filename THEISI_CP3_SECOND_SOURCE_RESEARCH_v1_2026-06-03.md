# CP3 — Second Data Source Research & Recommendation
## Theisi Labs — Arabic Finance Intelligence System
### v1.1 · 2026-06-03 · Companion to ARCHITECTURE_AND_RELIABILITY_REVIEW_v1

> **DECISIONS LOCKED (this revision).** Four open questions from v1 are now
> answered by the owner and recorded in §6 and §8:
> 1. License: treat as **personal**, max ~10 users (test).
> 2. Budget: FMP plan is actually **$29 Starter, not $69** — see the critical
>    finding below. Stay at $29 FMP + Finnhub free.
> 3. Scope: **start top 10, code a configurable N** so it can rise to 20/44 with
>    no cost increase, only light throttling.
> 4. DCF: **show both values side by side** with a "models differ" note, not
>    direction-only.
>
> ### 🔴 CRITICAL FINDING — FMP plan tier
> Every project doc says "FMP Premium $69/mo." The owner states the actual plan
> is **$29/mo (Starter)**. FMP's tiers (verified June 2026):
> - **Starter $29** — 300 calls/min · 5-yr history · **US only** · annual
>   fundamentals & ratios · **NO premium endpoints** · 20GB/mo bandwidth.
> - **Professional $69** — 750 calls/min · 30-yr history · UK/Canada · full
>   fundamentals · intraday · technical indicators · **custom DCF calculator** ·
>   premium endpoints · 50GB/mo.
> - **Enterprise $139** — global · 13F · bulk · 150GB+.
>
> **Implication:** FMP's **custom DCF endpoint and several premium endpoints are
> gated to $69+**. On $29 the system may be silently missing DCF and/or getting
> only annual (not TTM) fundamentals — which could itself explain part of the
> NVDA discrepancy. **This must be verified against what the endpoints actually
> return before spending on a second source.** It is possible the real fix is
> partly "we're on the wrong FMP tier for what the prompts assume."
> **ACTION:** confirm which FMP endpoints return data vs. empty/legacy-error on
> the $29 key, and reconcile against the SSOT (which currently says $69).

> **Why this exists.** The NVDA incident showed the system trusts a single data
> provider (FMP) with no way to catch a wrong-but-valid number. CP3 in the
> reliability plan calls for a **second independent source** so key figures can
> be cross-checked and divergences flagged instead of silently trusted. This
> document researches the realistic options, what each actually exposes, their
> limits and costs, and gives a recommendation to decide on.
>
> **Decision still open** — this is for review, not yet built. The recommendation
> is at the end (§6).

---

## 1. WHAT WE ACTUALLY NEED TO CROSS-CHECK

From the scoring engine, the numbers that drive recommendations and are worth
verifying against a second source:

| Field | Used in | Why it matters |
|-------|---------|----------------|
| ROE / ROIC | Layer 4 (Fundamental, 25%) | This is exactly what was wrong for NVDA |
| PEG | Layer 2 (Valuation, 30%) | Drives "cheap vs expensive" judgement |
| P/E (current + historical) | Layer 2 | Valuation anchor |
| DCF / fair value | Layer 2 | Margin-of-safety calculation |
| Analyst consensus + price target | Layer 5 (External, 10%) | Drives the bull/bear lean |
| Earnings beat history | Layer 4 | Management-reliability signal |

Technicals (RSI, MACD, SMA, EMA) are **less urgent** to cross-check — they are
deterministic calculations from price, and the price itself already comes from
Yahoo (independent of FMP). The priority for a second source is **fundamentals
and analyst data**.

> **Correction carried from earlier sessions:** an earlier suggestion was "use
> Yahoo Finance as the second fundamentals source." That does NOT work — the
> Yahoo endpoint already in the code is the *chart/price* endpoint, which does
> not cleanly expose ROE/ROIC/PEG. Yahoo is fine as the price source; it is not
> a fundamentals cross-check. This is why a real fundamentals API is needed.

---

## 2. CANDIDATES COMPARED (verified June 2026)

| Provider | Free tier limit | Fundamentals (ROE/ROIC/PEG) | Analyst targets | Commercial-use on free tier | Paid entry |
|----------|----------------|------------------------------|-----------------|------------------------------|-----------|
| **Finnhub** | **60 calls/min** (no daily cap stated) | Yes — `stock/metric?metric=all` returns ROE, ROIC, margins, P/E, etc. | Yes — `price-target` & `recommendation` (may be premium-gated) | ⚠️ Free tier is **personal/non-commercial**; commercial needs paid | ~$50/mo (premium adds intl + detailed financials + higher limits) |
| **Alpha Vantage** (you already have a key) | **25 requests/day** (free) | Yes — `OVERVIEW` returns `ReturnOnEquityTTM`, `PEGRatio`, margins, `AnalystTargetPrice` (no native ROIC field) | Target price only (no full consensus breakdown) | NASDAQ-licensed; check commercial terms | $49.99/mo (75 req/min), $99.99, $149.99 |
| **roic.ai** | Free tier available | Yes — **pre-calculated ROIC/ROE** is its core product | Limited | Check terms | Paid tiers for volume |
| **FMP (incumbent, primary)** | n/a — paid | Yes, BUT on **$29 Starter**: annual fundamentals, US only, **DCF likely gated** | Yes (analyst targets/grades) | Commercial OK on paid | **Currently $29 Starter** (300/min); $69 Pro adds DCF + premium |

### Key facts that matter for THIS system

- **Finnhub free = 60 calls/min.** For a 44-stock portfolio doing one
  fundamentals call per stock, that's within budget but **Finnhub's 60/min is
  the binding ceiling** for scaling (see §3.1). The free *rate* handles top 10
  easily; top 20 needs ~1 min, all 44 needs batching across ~2 min. **The other
  blocker is the license:** Finnhub's free tier is personal/non-commercial.
  Owner decision: treat as personal (≤10 users, test). A paid tier (~$50/mo)
  removes doubt if it ever goes public.
- **Alpha Vantage free = 25 requests/day.** Hard blocker for daily use on 44
  stocks. Viable only on a **paid plan ($50/mo)**, and even then has **no native
  ROIC field**. Ruled out.
- **FMP on $29 Starter = 300 calls/min** — rate is NOT a constraint. The real
  constraints on $29 are (a) **premium endpoints gated** (DCF, possibly TTM
  metrics) and (b) **20GB/month bandwidth**. The rate-limit "Too Many Requests"
  seen earlier with the insider feature is more likely a burst/concurrency
  issue than the per-minute cap — worth confirming. Either way, the second
  source must stay scoped so it doesn't add bandwidth/burst pressure.

---

## 3. ARCHITECTURE — HOW A SECOND SOURCE FITS (given the constraints)

### Hard constraint: Vercel 12-function limit (AT the limit)
A second source must be added **inside the existing `portfolio-for-ai.js`
function**, NOT as a new API route. Practically: add a `finnhubGet()` helper
next to the existing `fmpGet()`, fetch the same top-N symbols' metrics in
parallel, and merge.

### 3.1 Scaling — how high can N go, and what each step costs
**Money does not increase with scope. Calls and run-time do.** Finnhub free
(60/min) is the binding ceiling, not FMP ($29 = 300/min).

| Scope (N) | FMP fund. calls | Finnhub calls | Total/run | Feasible on free/$29? | What it needs |
|-----------|-----------------|---------------|-----------|------------------------|----------------|
| **Top 10** | ~10 | ~10–20 | ~30 | ✅ Easily | Nothing — fits in one minute |
| **Top 20** | ~20 | ~20–40 | ~60 | ✅ Yes | Light spacing so Finnhub ≤60/min |
| **All 44** | ~44 | ~44–88 | ~130 | ✅ Yes | **Batching** Finnhub across ~2 min (e.g. 2 batches with a delay) |

**Design rule:** make N a **single configurable constant** in the code. Start at
**10**, confirm stability, then raise to 20 or 44 by changing one number. Going
up costs **$0** — it only adds a few seconds of run-time and (for 44) a simple
batch-with-delay loop so Finnhub stays under 60/min. The morning run is not
time-critical, so a 2-minute fetch is fine.

### The cross-check pattern (this is the actual value of CP3)
For each key field, present **both sources side by side** and let the model — and
the user — see the comparison. Never silently pick one.

```
KEY METRICS — NVDA (cross-checked)
  ROE:   FMP 111.7%  |  Finnhub 113.9%   → agree ✅
  ROIC:  FMP 63.0%   |  Finnhub 61.4%    → agree ✅
  PEG:   FMP 0.31    |  Finnhub 0.48     → DIVERGE ⚠️ (>20%) — flag, do not average
  PE:    FMP 33.9    |  Finnhub 34.4     → agree ✅
```

Rules for the merge logic:
- Within ±10% → mark **agree**, show one value.
- 10–20% → show both, mark **minor divergence**.
- \>20% → mark **DIVERGE ⚠️**, show both, and the prompt instructs the model to
  treat that specific number as low-confidence (and the dashboard/Telegram
  flags it). Never auto-average — divergence is information, not noise to smooth.
- If **either source is missing** the field → write "غير متوفر", never infer.

This pattern is what turns "one provider we blindly trust" into "two providers
that police each other," which is the credibility the user asked for.

### Where the DATA_QUALITY block (CP2) ties in
The same run records, per field: present-in-FMP? present-in-Finnhub? agree?
That feeds the CP6 monitoring report, so a silent degradation in *either*
provider becomes visible.

---

## 4. WHAT THIS DOES AND DOESN'T SOLVE

**Solves:**
- A wrong-but-valid number from one provider gets caught when the other disagrees.
- A provider silently returning empty/legacy-error data becomes visible (the
  cross-check shows "missing on side X").
- Gives the user a visible "two sources agree" credibility signal.

**Does NOT solve:**
- If **both** sources are wrong in the same way (rare for independent providers,
  but possible if they share an upstream).
- The residual LLM-hallucination risk (model ignoring provided numbers) — that
  still needs the CP3 prompt discipline + CP5 disclaimer.
- DCF specifically: **show both values side by side** with a note that models
  differ (owner decision). The point is to give the user enough to decide
  in-dashboard without visiting other sites — a single "direction" hides useful
  range information. Render it as a **range**, e.g.
  `DCF fair value: FMP $241 | Finnhub $310 — models use different assumptions;
  treat as a $241–$310 range, not a single target.` Caveat: if FMP's DCF is
  gated on the $29 tier, the FMP side may be missing — in that case show the
  available source's DCF and label the other "غير متوفر (plan-gated)".

---

## 5. COST OPTIONS (for the budget decision) — based on actual $29 FMP

| Option | Monthly cost | What you get | Risk |
|--------|-------------|--------------|------|
| **A — $29 FMP + Finnhub free** ✅ chosen | **$29 (no change)** | Two independent fundamentals sources; cross-check on top 10 (scalable to 44) | Finnhub free-tier license (mitigated: ≤10 users); FMP $29 may lack DCF/TTM — verify |
| **B — $29 FMP + Finnhub paid** | ~$29 + ~$50 = ~$79 | Same, license-clean, higher limits | Cost; still on $29 FMP (DCF gap remains) |
| **C — Upgrade FMP to $69 + Finnhub free** | ~$69 | Recovers FMP DCF + premium endpoints + TTM; free cross-check | Higher FMP cost; only worth it if the $29 gaps prove real |
| **D — Stay $29, no second source** | $29 | Cheapest | No cross-check — the original credibility problem remains |

> **Note:** Option C may turn out to be the *real* fix if verification shows the
> $29 tier is silently missing DCF/TTM data the prompts assume. In that case the
> "second source" need is partly a "right FMP tier" need. Verify first (§6).

---

## 6. RECOMMENDATION (decisions locked)

**Option A: $29 FMP (current) + Finnhub free as the second source.** Start
cross-checking the **top 10** non-ETF holdings on ROE / ROIC / PEG / P/E /
price target / DCF, with **N coded as a configurable constant** so it scales to
20 or 44 at no extra cost.

Reasons unchanged from v1: Finnhub free has the best rate limit (60/min), returns
the exact fields that were wrong for NVDA (including ROIC), fits inside the
existing function (12-function limit), and costs $0 to prove the pattern.

**Locked decisions:**
- **License:** personal, ≤10 users (test). Revisit if it goes public → Finnhub paid.
- **Budget:** stay at **$29** for now. Do NOT pre-emptively upgrade.
- **Scope:** **top 10 first**, configurable N, scale later with batching only.
- **DCF:** **show both values as a range** with "models differ" note.

**Two verification steps BEFORE writing integration code (both cheap, both
decide the path):**

1. **🔴 FMP $29 endpoint audit.** Hit the live $29 key for one stock (NVDA) and
   record which of these actually return data vs. empty/legacy-error:
   key-metrics-TTM (ROE/ROIC), DCF, historical P/E + PEG, analyst targets/grades.
   - If DCF / TTM are **gated or empty** → the real first fix may be **Option C
     (upgrade FMP to $69)**, with Finnhub still added as the cross-check.
   - If they return fine → proceed on $29 + Finnhub free as planned.
2. **Finnhub one-stock verification.** Confirm the free `stock/metric?metric=all`
   returns ROIC and that `price-target` is not premium-gated for NVDA.
   - If price target is gated → keep FMP as the sole analyst source; use Finnhub
     only for ROE/ROIC/PEG/P/E.

**Sequencing:** CP3 still comes after CP6 (monitoring) and CP2 (data-assembly
fix) in the build order. But the two verification steps above should happen
**now**, because they may change the FMP plan decision (and the SSOT, which
wrongly says $69).

---

## 7. CROSS-CHECK DISPLAY — what the user sees (per the "more data, decide in-app" goal)

Because the owner wants users to decide without leaving the dashboard, every
cross-checked field shows **both numbers + an agreement flag**, never a single
silently-chosen value:

```
NVDA — KEY METRICS (cross-checked: FMP + Finnhub)
  ROE        111.7%  |  113.9%   ✅ agree
  ROIC        63.0%  |   61.4%   ✅ agree
  PEG          0.31  |    0.48   ⚠️ diverge >20% — treat as low-confidence
  P/E         33.9   |   34.4    ✅ agree
  Target $    309    |   297     ✅ agree (within range)
  DCF fair $  241    |   310     ℹ️ range $241–310 (models differ — not a target)
```

Arabic equivalents for Telegram/dashboard: ✅ متطابق · ⚠️ تباين · ℹ️ نطاق.

---

## 8. RESOLVED QUESTIONS (was §7 in v1)

1. **License** → personal, ≤10 users (test). ✅
2. **Budget** → stay $29 FMP + Finnhub free; FMP is $29 not $69 (correct the SSOT). ✅
3. **Scope** → top 10, configurable N, scale to 44 with batching, no cost change. ✅
4. **DCF** → show both as a range, not direction-only. ✅

**New action created by this revision:** 🔴 audit what the $29 FMP key actually
returns (DCF, TTM metrics) and reconcile the SSOT's "$69 Premium" line.
**→ DONE, see §9.**

---

## 9. VERIFICATION RESULTS (NVDA, 2026-06-03) — LOCKED

Live responses pulled from both providers. Outcome: **proceed on $29 FMP +
Finnhub free. No FMP upgrade needed.**

### 9.1 FMP on $29 Starter — all needed endpoints return data ✅
| Endpoint | Result |
|----------|--------|
| `key-metrics-ttm` | ✅ full (returnOnEquityTTM 1.1166, returnOnInvestedCapitalTTM 0.6299, etc.) |
| `discounted-cash-flow` | ✅ **works on $29** — dcf 241.83, price 224.57 (DCF is NOT gated) |
| `ratios-ttm` | ✅ full (P/E 32.8, PEG 0.301, margins, etc.) |
| `price-target-consensus` | ✅ high 500 / low 139 / consensus 309.46 / median 294 |
| `grades-consensus` | ✅ strongBuy 2 / buy 58 / hold 16 / sell 3 / strongSell 0 → "Buy" |

So the earlier fear that $29 gates DCF/TTM is **disproved** for these endpoints.
(The SSOT's "$69 Premium" line is simply wrong and must be corrected to $29.)

### 9.2 Finnhub free — fundamentals present, price-target gated
| Endpoint | Result |
|----------|--------|
| `stock/metric?metric=all` | ✅ returns roeTTM, peTTM, pegTTM, margins, ROA, + history |
| `price-target` | 🔴 **gated on free tier** (redirects/403) → do NOT use; FMP covers targets |

### 9.3 Side-by-side (the actual cross-check)
| Metric | FMP $29 | Finnhub free | Verdict |
|--------|---------|--------------|---------|
| ROE TTM | 111.7% | 111.66% | ✅ near-identical — **best cross-check field** |
| P/E TTM | 32.8 | 34.3 | ✅ agree (snapshot timing) |
| PEG TTM | 0.30 | 0.62 | ⚠️ diverge — different growth assumptions; show both |
| Net margin TTM | 63.0% | 62.97% | ✅ identical |
| Gross margin TTM | 74.1% | 74.15% | ✅ identical |
| EV/EBITDA | 27.1 | 33.05 | ⚠️ diverge — different EV snapshot; show both |
| **ROIC vs ROI** | **63.0%** | **105.41%** | 🔴 **DO NOT COMPARE — different definitions** |

### 9.4 🔴 CRITICAL DESIGN RULE — definition matching
FMP `returnOnInvestedCapitalTTM` (63%) and Finnhub `roiTTM` (105%) are **not the
same metric** — FMP's ROIC divides by total invested capital (debt+equity);
Finnhub's ROI is computed differently. Comparing them would raise a **false
divergence alarm**. The merge logic must only cross-check **definition-matched
pairs**. This is the same definition-confusion that started the whole NVDA
investigation — now codified as a rule.

### 9.5 LOCKED cross-check pairing for the build
| Field | Primary | Cross-check | Rule |
|-------|---------|-------------|------|
| ROE | FMP | Finnhub `roeTTM` | direct compare (✅ matches) |
| P/E | FMP | Finnhub `peTTM` | direct compare |
| PEG | FMP | Finnhub `pegTTM` | compare, expect spread, show both |
| Margins | FMP | Finnhub | direct compare |
| **ROIC** | FMP only | — | **no Finnhub equivalent — single source** |
| DCF | FMP only | — | single source; show value + "model-dependent" note |
| Price target / consensus | FMP only | — | Finnhub gated on free tier |
| Analyst grades | FMP only | — | Finnhub gated on free tier |

Divergence thresholds (definition-matched fields only): ≤10% agree · 10–20%
minor · >20% flag low-confidence. Never auto-average.

---

*End of CP3 research v1.1. Provider facts and NVDA data verified June 2026;
free-tier terms and
premium-gating change often, so the one-stock verification in §6 is required
before relying on any field. Nothing here is built yet — this is for decision.*
