# THEISI LABS — GCC MARKET EXPANSION PLAN
## Adding Gulf market coverage to the Arabic Finance Intelligence System
### v1 · 2026-06-04 · Scoping/planning document (nothing built yet)

> **Status:** This is a PLAN, not a build record. No code written, no API
> purchased, no SSOT changes made. Two hard gates (G1, G2 below) must pass
> before any building starts. Everything here is contingent on those gates.

---

## 0. WHY GCC, NOT UAE-ONLY

UAE-only failed the data test: thin analyst coverage (~2 analysts/stock), a
small bank/real-estate/energy-heavy universe, and no confirmed API at the depth
the engine needs (FMP does not cover UAE).

GCC-wide passes much better for two reasons:
1. **Saudi (Tadawul) anchors quality** — ~385 listed companies, MSCI/FTSE
   emerging-market inclusion, real analyst coverage, diverse sectors.
2. **One API covers the region** — Twelve Data covers Tadawul, ADX, DFM,
   Kuwait, and Qatar together, with fundamentals + analyst endpoints. This
   solves the pipeline problem that killed the UAE-only version.

**Design principle:** Saudi-led, not "all GCC equally." Tier markets by data
quality (see §3) and only promise engine output as good as the data behind it.

---

## 1. THE TWO HARD GATES (do these BEFORE anything else)

These are go/no-go. If either fails, the plan changes or stops. Do not skip.

### G1 — Live data validation (the single most important step)
Confirm Twelve Data actually returns the deep fields the engine needs — not
just prices — for real GCC tickers. Test on 3 tickers across tiers:
- **Aramco or Al Rajhi Bank** (Tadawul — best-coverage tier)
- **Emaar** (DFM) and **FAB** (ADX — UAE tier)

For each, confirm the API returns: current price + history (for technicals),
income statement / balance sheet / cash flow, EPS estimates, analyst price
target, and valuation metrics (P/E, etc.). Record which fields come back EMPTY
— empty fields = engine layers that can't score that market.

**Pass condition:** Saudi tickers return fundamentals + at least one analyst
target. UAE tickers return at least price + fundamentals.

### G2 — Cost & rate-limit confirmation
- Confirmed: GCC exchanges require the **Pro plan** (from **$99/mo**).
- Confirmed: **fundamentals are credit-expensive** — a `/income_statement`
  request = **100 credits per symbol** (vs. 1 credit for a price). Pro 610 =
  610 credits/minute.
- **To confirm:** exact Pro tier needed for our symbol count + refresh rate,
  and whether $99/mo entry tier is enough or we need a higher Pro credit pack.

**Worked example (why caching matters):** 30 Saudi stocks × full fundamentals
(income + balance + cashflow ≈ 300 credits/symbol) = ~9,000 credits. At 610
credits/min that's ~15 minutes of pulling if done naively. **Therefore:**
fundamentals must be fetched on a slow cycle (weekly/daily) and CACHED; only
prices/technicals refresh frequently. This shapes the whole architecture.

---

## 2. WHAT PORTS FOR FREE vs. WHAT'S NEW

**Reuse as-is (no data dependency):**
- Make.com orchestration, scenario structure
- Telegram delivery + Arabic output (Arabic is an ADVANTAGE here — Argaam and
  the exchanges publish natively in Arabic)
- Dashboard, auth system (PIN, invite codes)
- The scoring-engine LOGIC and institutional rules

**New / changed:**
- **Data source:** FMP → Twelve Data (new API, new key, new field mappings)
- **Symbol handling:** GCC tickers, AED/SAR/QAR/KWD currencies, T+2 settlement,
  Sun–Thu trading week, 10:00 AM–2:50 PM UAE time
- **Threshold recalibration:** rules tuned for US data must be re-tuned for
  thinner GCC coverage (esp. analyst-target and DCF rules)
- **Confidence labelling:** NEW requirement — engine must show how much data
  backs each score (see §5)

---

## 3. MARKET TIERING (build order follows this)

| Tier | Markets | Coverage | Plan treatment |
|------|---------|----------|----------------|
| **Tier 1** | Saudi (Tadawul) | Deepest — full engine | Build first |
| **Tier 2** | UAE (ADX, DFM), Qatar, Kuwait | Large caps only, shallower | Add after Tier 1 proven |
| **Tier 3** | Oman (MSX), Bahrain | Thin | Defer / skip initially |

---

## 4. HOW THE 5 ENGINE LAYERS FARE (GCC-wide)

| Layer | Weight | Status | Notes |
|-------|--------|--------|-------|
| L1 Personal Position | 15% | Full | Own holdings only, no external data |
| L2 Valuation | 30% | Workable | Twelve Data gives metrics + targets; strong for Saudi, shallow for UAE |
| L3 Technical | 20% | Full | Price data confirmed available all GCC |
| L4 Fundamental | 25% | Workable | Income/balance/cashflow + EPS estimates via API; "beat vs consensus" better in Saudi |
| L5 External | 10% | Partial | Short interest mostly unpublished region-wide; news thinner; Argaam helps |

Institutional rules leaning on analyst consensus (Goldman target, Graham DCF):
reliable for Saudi large caps, usable elsewhere with WIDER confidence bands.

---

## 5. NEW HARD REQUIREMENT — CONFIDENCE LABELLING

Because coverage varies by market, the engine must never present a 2-analyst
UAE target as if it were a 30-analyst US consensus. Every score must carry a
data-confidence indicator (e.g. high/medium/low based on # analysts, fields
available, liquidity). This is both an honesty and a legal-tier matter (ties
to the 255/357 disclaimer rule in the SSOT).

---

## 6. PROPOSED PHASES

### Phase A — Validation (gates G1 + G2)
Deliverable: a short findings note — what Twelve Data returns per ticker, empty
fields, confirmed Pro tier + monthly cost. **Decision point: go / adjust / stop.**

### Phase B — Saudi pilot (Tier 1 only)
- Twelve Data integration in a new data module (mirror `portfolio-for-ai.js`
  pattern; do NOT touch the US pipeline)
- Fundamentals cached on slow cycle, prices on fast cycle (per §1 G2)
- 20–30 Saudi large caps, full engine, Arabic Telegram output
- Confidence labelling live
- Manual accuracy check against Argaam before trusting output

### Phase C — Tier 2 expansion
- Add UAE (ADX/DFM), Qatar, Kuwait large caps
- Apply wider confidence bands; drop/down-weight rules that lack data per market

### Phase D — Consolidation
- Fold GCC into dashboard (market selector), update SSOT, document the new
  data source and credit-budget rules

> Phases are sequential and gated. B does not start until A passes. No
> "build everything at once."

---

## 7. RISKS (eyes open)

1. **Lower analyst coverage → wider error bars.** Mitigated by confidence
   labelling (§5).
2. **Concentrated, oil/state-correlated markets.** Sector-rotation and
   diversification signals weaker than US. Don't over-trust them.
3. **Geopolitical gap/halt risk.** GCC moves hard on regional events (ADX fell
   ~9% at the March 2026 Iran conflict onset). Engine should flag, not ignore.
4. **Credit-budget overrun.** Fundamentals cost 100×/symbol — naive polling
   blows the Pro quota. Caching is mandatory, not optional.
5. **Single-source dependency.** Twelve Data is one vendor. Argaam (Arabic) is
   the natural CP3-style cross-check / fallback, mirroring the existing
   reliability program's second-source pattern.

---

## 8. OPEN QUESTIONS FOR RASHED

- Which is the priority market — Saudi-first (recommended), or UAE-first because
  that's your home market even though data is thinner?
- Is this for you only (Scenario 255 tier) or also for other users (357 tier,
  needs the "not financial advice" disclaimer)?
- Appetite for the ~$99+/mo Twelve Data cost before we confirm exact tier?

---

## 9. WHAT HAPPENS NEXT

If you approve the direction, the immediate next action is **Phase A only** —
run the G1 live-data test and confirm G2 pricing. That produces a findings note
and a clean go/no-go. Nothing gets built, and the SSOT stays untouched, until
that note is in hand.

*End of GCC Expansion Plan v1. This supersedes nothing yet — it is a proposal
pending the Phase A gates.*
