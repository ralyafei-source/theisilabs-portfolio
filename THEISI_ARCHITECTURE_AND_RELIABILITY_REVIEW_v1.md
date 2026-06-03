# Theisi Labs — Arabic Finance Intelligence System
## Architecture & Reliability Review — v1
### Prepared 2026-06-03 for independent technical review

> **Purpose of this document.** This is a self-contained description of the
> entire system as it exists today, followed by a reliability analysis and a
> proposed redundancy/checkpoint design. It is written so that an engineer or
> AI with **zero prior context** can understand the system, judge the
> reliability proposal, and cross-check it. Nothing here assumes you have seen
> the codebase. Where the existing project documents disagree with each other,
> that is called out explicitly rather than smoothed over.
>
> **Status of the reliability section.** The architecture description (Part 1)
> is factual, drawn from the actual code and project files. The reliability
> analysis (Parts 2–4) is a *proposal for review* — it has not been built. It
> is presented so it can be challenged before any code is written.

---

# PART 0 — EXECUTIVE SUMMARY

The system is an automated Arabic-language financial-intelligence service for a
single primary user (a UAE retail investor) plus a small number of secondary
users. Every morning it pulls market and portfolio data, sends it to an LLM
(Claude) to produce analysis and a 1–10 "act now" score per holding, and
publishes the results to a web dashboard, Telegram (Arabic), and Instagram.

Orchestration runs on **Make.com** (a no-code automation platform). Custom code
runs as **serverless functions on Vercel**. Data and analysis outputs are stored
as JSON files in a **GitHub repository**. Market data comes primarily from
**Financial Modeling Prep (FMP)** and **Yahoo Finance**.

**The reliability problem that triggered this review.** During a manual
spot-check of one stock (NVDA), the LLM-reported ROE/ROIC values diverged sharply
from independent sources. Investigation showed the data pipeline was actually
returning correct numbers, but they were handed to the LLM as a wall of raw JSON
under a vague label — so the model sometimes fills such values from its own
training data instead of reading the provided field. The deeper lesson was not
the single bug but the **class** of bug: the system has no checkpoints, so a
component can fail or degrade silently and nobody would know. This document
proposes fixing that class of problem, not just the one instance.

---

# PART 1 — CURRENT SYSTEM (factual description)

## 1.1 High-level data flow

```
                    ┌─────────────────────────────────────────────┐
                    │  EXTERNAL DATA SOURCES                        │
                    │  FMP (premium) · Yahoo Finance · NewsAPI ·    │
                    │  Alpha Vantage · Seeking Alpha RSS · Unsplash │
                    └───────────────────┬─────────────────────────┘
                                        │
                                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  ORCHESTRATION — Make.com (eu1.make.com/1748978)            │
        │  4 scheduled scenarios run each morning (UAE time)          │
        └───────────────┬───────────────────────────────────────────┘
                        │  (HTTP calls)
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  COMPUTE — Vercel serverless functions                      │
        │  portfolio-for-ai.js  · analysis.js  · briefing  · auth     │
        │  (hard limit: 12 functions, currently AT the limit)         │
        └───────────────┬───────────────────────────────────────────┘
                        │  (reads/writes JSON)
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  STORAGE — GitHub repo                                      │
        │  ralyafei-source/theisilabs-portfolio                       │
        │  data/portfolio.json · data/portfolio-NAME.json ·           │
        │  data/market-data-DATE.json · saved analysis JSON           │
        └───────────────┬───────────────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  INTELLIGENCE — Claude (Anthropic) prompt modules           │
        │  Daily / Weekly / Monthly analysis + scoring engine         │
        │  Model: claude-sonnet-4-20250514                            │
        └───────────────┬───────────────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  OUTPUTS                                                    │
        │  Dashboard (theisilabs.vercel.app) · Telegram (Arabic) ·   │
        │  Instagram carousel (5 slides)                              │
        └───────────────────────────────────────────────────────────┘
```

## 1.2 Components in detail

### A. External data sources (INPUT)

| Source | Used for | Auth | Notes |
|--------|----------|------|-------|
| **FMP (premium, $69/mo)** | RSI, MACD, SMA50/200, EMA20, Bollinger, earnings calendar, price-target consensus, analyst grades, key-metrics-TTM (ROE/ROIC/etc.), DCF, historical P/E + PEG, insider activity | API key (Vercel env var) | Base URL is the **stable** API: `https://financialmodelingprep.com/stable`. The older `/api/v3/` "legacy" endpoints were retired Aug 31 2025 and must not be used. 13F not included in plan; insider data is. |
| **Yahoo Finance** | Live prices (chart endpoint) | none | `query2.finance.yahoo.com/v8/finance/chart/{SYM}`. Free, no key, but unofficial/unsupported. |
| **NewsAPI** | News feed | API key | Morning Brief scenario. |
| **Alpha Vantage** | Market data | API key | Morning Brief scenario. |
| **Seeking Alpha RSS** | Articles/sentiment | none | Feed parsing. |
| **Unsplash** | Instagram background photos | client_id | 3 modules in Instagram scenario. |

### B. Orchestration — Make.com (PROCESS)

Account `eu1.make.com/1748978`. Four scheduled scenarios:

| Scenario | ID | Schedule (UAE) | Purpose | Output |
|----------|-----|----------------|---------|--------|
| 🌅 Morning Brief | 5826977 | 7:00 AM | Market summary | Telegram |
| 🧠 Intelligence Engine / Private Advisor | 5904255 *(see note)* | ~7:05–7:10 AM | Daily/Weekly/Monthly analysis + scoring | Dashboard + Telegram |
| 👥 User Analysis Engine | 5958357 | 7:30 AM | Per-user personalized analysis | Dashboard (per user) |
| 📱 Instagram | 5832754 | daily (scheduled) | 5-slide Arabic carousel | Instagram |

> **NOTE / DISCREPANCY:** Two scenario IDs appear for the main intelligence
> scenario across the project docs — `5904255` (newer docs, CLAUDE.md and
> System Reference) and `5826977`/`5827323` (older onboarding notes, which
> actually refer to Morning Brief and an old Price-Alerts scenario). Treat
> **5904255** as the current Intelligence Engine and **5826977** as Morning
> Brief. This should be confirmed in the Make.com UI and the stale IDs purged.

**Make.com conventions (must be used exactly):**
- Claude module output reference: `{{moduleNumber.content[1].text}}`
- UAE timezone in formulas: `addHours(now;4)`
- HTTP body carrying Claude content: **Custom** content type (NOT application/json — avoids Make's JSON auto-escaping)
- Claude modules are native Anthropic "Create a Prompt" modules, NOT HTTP modules
- Model string: `claude-sonnet-4-20250514`
- Router day filters use `formatDate(addHours(now;4);"dddd")`

**Router logic (Intelligence Engine and User Analysis Engine share it):**
- **Monthly** route: day = Sunday AND day-of-month ≤ 7 (first Sunday)
- **Weekly** route: day = Saturday
- **Daily** route: fallback (Mon–Fri)

> **CONSTRAINT:** Make.com scenarios cannot be edited from code or from Claude
> Code. Any prompt or module change is done by hand in the Make UI. Changes are
> therefore slow and error-prone, and there is no version control on the
> orchestration layer. This is itself a reliability concern (see Part 2).

### C. Compute — Vercel serverless functions (PROCESS)

Repo `github.com/ralyafei-source/theisilabs-portfolio`, deployed on Vercel.
**Hard limit of 12 serverless functions, currently at the limit** — adding a new
API route requires removing or merging an existing one.

Key function: **`api/portfolio-for-ai.js`** — the heart of the data pipeline.
It returns the portfolio as **formatted plain text** (not JSON) for the LLM to
read. Query parameters:
- `?nickname=NAME` — per-user portfolio (reads `data/portfolio-NAME.json`); default (no nickname) is the primary user's `data/portfolio.json`.
- `?include=intelligence` — appends the market-intelligence block (FMP technicals, earnings, targets, grades, key metrics, insider activity).

What it does, step by step:
1. Auth check (Bearer token; see discrepancy note below).
2. Loads holdings from GitHub JSON.
3. Fetches **live prices from Yahoo** for every symbol in parallel.
4. Computes totals, gain/loss %, portfolio weight; groups by sector.
5. If `include=intelligence`: in parallel, fetches from FMP — earnings calendar, price-target consensus (top 10 non-ETF holdings), analyst grades (top 10), key-metrics-TTM (top 10), and technical indicators (RSI/MACD/SMA50/SMA200/EMA20/stddev) for **all** symbols. Derives plain-English signal lines (e.g. "Golden Cross ✅", "RSI 58 — neutral").
6. Emits one big plain-text document. Technicals are rendered as a readable table + signal interpretation; **earnings, targets, grades, and key-metrics are emitted as raw `JSON.stringify(...)` blocks** under human-readable headers.

> **ROOT-CAUSE DETAIL (the NVDA incident).** The key-metrics block is appended
> as raw JSON under the header `KEY METRICS TTM (P/E, ROE, margins etc)`. The
> correct values *are present* in fields like `returnOnEquityTTM`. But because
> the values are buried in raw JSON under a vague natural-language label, the
> LLM sometimes reads the label and supplies a number from its training data
> instead of parsing the exact field. **The data was correct; the presentation
> invited hallucination.** The fix is to pre-format these values into explicit
> labeled lines (e.g. `ROE: 111.7% (returnOnEquityTTM)`) and to instruct the
> model to write "غير متوفر" (not available) when a field is missing rather
> than infer it.

`fmpGet()` helper behavior worth noting for reliability: on a non-OK HTTP
response, or on a payload containing an `Error` property, it returns `null`
**silently**. A `null` then flows downstream as an empty/`N/A` value with **no
signal anywhere that a fetch failed**. This is the silent-failure mechanism at
the center of Part 2.

Other functions (from repo structure): `api/analysis.js` and related
(saves/serves daily/weekly/monthly analysis), a briefing endpoint, and the auth
system. Exact inventory should be confirmed against the live Vercel project.

> **DISCREPANCY / DRIFT across project docs (must reconcile):**
> - **FMP API key:** One project file (`api_portfolio_for_ai_v2.js`) contains a
>   **hardcoded live FMP key on line 10**. Other docs say the key was moved to
>   the Vercel env var `FMP_API_KEY` and rotated on 2026-05-31. **Action: treat
>   any hardcoded key as compromised, confirm the code in production reads
>   `process.env.FMP_API_KEY`, and rotate.** (This key was also pasted into a
>   chat session — additional reason to rotate.)
> - **API auth token `theisilabs2026`:** noted as leaked in git history and
>   pending rotation; endpoint historically accepted no-key requests (auth gap).
> - **SPUS rule:** older docs say "SPUS — never sell under any condition";
>   the newest (CLAUDE.md, "Session 23") says **SPUS is a normal Sharia ETF
>   with no special treatment, eligible for sell/reduce**. The newer rule
>   supersedes. Any prompt still carrying the old rule must be updated.
> - **"Top 10" vs "top 20" holdings** for analyst/metrics calls differs between
>   code and docs. Confirm against deployed code.
> - **Version sprawl:** master-rules files exist as v5, v11, v12, v13, v19,
>   v20, v21; index as v10; plus CLAUDE.md and a System Reference. **There is no
>   single source of truth.** Consolidating to one is a prerequisite for trusting
>   any review.

### D. Storage — GitHub (STATE)

All persistent state is JSON committed to the repo: portfolio holdings
(`data/portfolio.json`, source of truth for the primary user), per-user
portfolios (`data/portfolio-NAME.json`), daily market data
(`data/market-data-DATE.json`), and saved analysis outputs. Writes happen via
the Vercel functions / Make.com HTTP calls. There is no database.

### E. Intelligence — Claude prompt modules (PROCESS)

Native Anthropic modules inside Make.com (model `claude-sonnet-4-20250514`).
Distinct prompts per cadence:
- **Daily** analysis module
- **Weekly** analysis module (larger token budget)
- **Monthly** Part A (Competitive Edge) + Part B (Long View + Portfolio Health)

Plus the Instagram scenario's own Claude "Analyst" and "Formatter→JSON" modules.

The analysis applies the **Scoring Engine** (next section). Prompts cite a set
of institutional rules (Goldman 25% rule, Renaissance, Bridgewater, Graham,
Lynch, Druckenmiller, Buffett, Marks, McKinsey moat) and require every sell
recommendation to state exact shares/price/$ and a destination for freed capital.

### F. Scoring Engine (analysis logic)

The score is explicitly a **"should I act NOW" timing signal, 1–10**, NOT a
company-quality rating. Five weighted layers:

| Layer | Weight | Inputs |
|-------|--------|--------|
| L1 — Personal Position | 15% | gain/loss %, $ at risk, portfolio weight, cost vs price, UAE zero-tax status |
| L2 — Valuation | 30% | DCF vs price (margin of safety), P/E vs own history, P/S, EV/EBITDA, PEG |
| L3 — Technical | 20% | RSI, price vs 50/200 MA, Golden/Death Cross, weekly momentum, volume |
| L4 — Fundamental | 25% | revenue-growth trend, FCF, earnings beats (4q), debt/equity, moat |
| L5 — External | 10% | news sentiment, macro/Fed, sector rotation, short interest, geopolitics |

**Final = L1·0.15 + L2·0.30 + L3·0.20 + L4·0.25 + L5·0.10**, rounded to 1–10.

Score bands: 9–10 strong buy · 7–8 buy · 5–6 hold · 3–4 reduce (sell 25–50%) ·
1–2 exit. Buy needs ≥3 institutional buy-signals; any one sell-rule triggers a
reduce. Position sizing follows Goldman 25% (first cut is 25%, never full exit
immediately), max 50%/week unless thesis broken, 2% portfolio-risk rule for
adds, new positions 1–2% and only at score ≥8.

### G. Outputs (OUTPUT)

- **Dashboard** (`theisilabs.vercel.app`): single-file `index.html`. Portfolio,
  trends, AI-Advisor tabs (10 sub-tabs across Daily/Weekly/Monthly groups),
  auth (nickname + 4-digit PIN, invite codes, lockout, Telegram security
  alerts), glossary, portfolio chat. EN/AR toggle, default EN.
- **Telegram**: Arabic only. Morning Brief + intelligence summary. Security bot
  for auth alerts.
- **Instagram**: 5-slide carousel rendered via hcti.io at 2× resolution, photos
  from Unsplash, content from the Instagram Claude modules. Four post types by
  day of week.

## 1.3 The complete component map (for the checkpoint design)

There are **six** stages, not three. Input → Process has two sub-stages, and a
cross-cutting monitoring stage is entirely absent today.

| # | Stage | Concretely | Today's failure behavior |
|---|-------|------------|--------------------------|
| 1 | **Input / acquisition** | FMP, Yahoo, NewsAPI, Alpha Vantage, RSS calls | Failures return `null` silently |
| 2 | **Data assembly** | `portfolio-for-ai.js` builds the text doc | `null` → "N/A" or raw-JSON label mismatch; no quality flag |
| 3 | **Intelligence** | Claude prompt modules score & write analysis | May infer missing values from training data |
| 4 | **Persistence** | Save analysis JSON to GitHub | Write success not verified |
| 5 | **Presentation** | Dashboard / Telegram / Instagram render | No freshness or quality indicator shown to user |
| 6 | **Monitoring** *(missing)* | — | **Nothing watches stages 1–5** |

---

# PART 2 — RELIABILITY ANALYSIS (proposal for review)

> This part is analysis, not fact. It is meant to be argued with.

## 2.1 The core finding

The architecture has **no checkpoints and no monitoring**. The NVDA incident was
not a one-off bug; it was the first *visible* symptom of a structural property:
**any component can fail or degrade silently and the bad output still reaches the
user looking exactly as authoritative as good output.** The failure chain is:

```
source returns error/empty  →  fmpGet() returns null silently  →
data-assembly emits N/A or mislabeled JSON  →  LLM fills the gap from training data  →
analysis saved and published  →  user reads a confident wrong number  →  nobody is alerted
```

Every arrow in that chain is a place where the error could have been caught, and
today none of them catch it.

## 2.2 Honest note on methodology

An earlier pass placed checkpoints using general engineering intuition. That is
not sufficient justification for a system people make money decisions on. For
this review the failure modes below are organized using **FMEA** (Failure Mode
and Effects Analysis): each failure is scored on Severity, Occurrence, and
Detectability (1–10 each), and the product **RPN = S × O × D** ranks them. High
RPN = fix first. The numbers below are **first-draft estimates and are exactly
what should be challenged** in review — they are not measured, they are
judgement calls written down so they can be corrected.

After FMEA, two further lenses are applied:
- **Risk treatment** — for each failure decide whether to *eliminate, reduce,
  transfer, or accept* it (not every risk needs a "checkpoint").
- **Defense in depth** — verify that if one control fails, a later one still
  catches the problem (prevention controls *and* recovery controls).

## 2.3 FMEA table (draft — review these scores)

| ID | Failure mode | Stage | S | O | D | RPN | Treatment |
|----|--------------|-------|---|---|---|-----|-----------|
| F1 | LLM infers a missing/unclear metric from training data and presents it as real | 3 | 9 | 6 | 9 | **486** | Reduce + Accept residual |
| F2 | No monitoring: any failure goes undetected | 6 | 8 | 8 | 10 | **640** | Eliminate detectability gap |
| F3 | FMP source/endpoint fails or rate-limits; `null` flows on silently | 1→2 | 8 | 6 | 9 | **432** | Reduce (detect + flag) |
| F4 | User shown stale/low-quality data with no warning | 5 | 7 | 6 | 8 | **336** | Reduce (recovery control) |
| F5 | GitHub write of analysis silently fails / partial | 4 | 6 | 3 | 7 | **126** | Reduce (verify write) |
| F6 | Make.com module/prompt mis-edited by hand, no version control | 2→3 | 7 | 4 | 7 | **196** | Reduce (snapshot prompts) |
| F7 | Leaked/hardcoded secret (FMP key, auth token) abused | all | 8 | 4 | 6 | **192** | Eliminate (rotate + env) |

Ranked by RPN: **F2 (640) > F1 (486) > F3 (432) > F4 (336) > F6 (196) >
F7 (192) > F5 (126).**

The single most important implication: **F2 (monitoring) dominates**, because
detectability of 10 means *every other failure is invisible*. Building
monitoring first makes all other failures visible, which is worth more than
fixing any individual data bug.

## 2.4 What this changes vs. the earlier intuition

The earlier proposal wanted to fix the data-assembly file first. FMEA suggests
**monitoring first** (so failures become visible), **then** the data-assembly /
anti-hallucination fix (which has the next-highest RPN and removes the
root-cause of the incident that started all this). The reordering is the point
of using a method instead of intuition.

---

# PART 3 — PROPOSED CHECKPOINT / REDUNDANCY DESIGN (for review)

Six checkpoints, one per stage. For each: what it does, where it sits, whether
it is a **prevention** control (stops a bad value moving forward) or a
**recovery** control (limits damage / warns after a failure), and how robust it
realistically is.

| CP | Stage | Type | What it does | Robustness (honest) |
|----|-------|------|--------------|---------------------|
| **CP1** | 1 Input | Prevention | Health-check each data source at scenario start; record which sources are up | Medium — catches hard failures, not subtle wrong-but-valid data |
| **CP2** | 2 Assembly | Prevention | Pre-format metrics into explicit labeled lines; emit a `DATA_QUALITY` block listing every field as present / missing; never emit a bare `null` | High for the root-cause bug; cannot stop the LLM from ignoring instructions entirely |
| **CP3** | 3 Intelligence | Prevention | Prompt rule: read only named fields; write "غير متوفر" if absent; never substitute training knowledge. Plus a **second data source** to cross-check key metrics | Medium — LLMs are probabilistic; reduces, does not eliminate |
| **CP4** | 4 Persistence | Prevention | After save, read back and verify the analysis was actually written | High — deterministic check |
| **CP5** | 5 Presentation | Recovery | Dashboard/Telegram footer shows data freshness + source-health + a standing disclaimer; degrade visibly when quality is low | High for transparency; relies on CP1/CP2 feeding it truth |
| **CP6** | 6 Monitoring | Recovery + detection | End-of-run health report posted to GitHub + Telegram alert on any failure or quality drop | High — this is what closes the loop; build first |

**Defense-in-depth check (does a later layer catch an earlier miss?):**
- If CP1 misses a subtle bad value → CP3's second-source cross-check can flag it.
- If CP2's quality block is wrong → CP6's health report still surfaces anomalies.
- If CP3 fails and the LLM hallucinates anyway → CP5's disclaimer + CP6's alert
  mean the user is at least warned and the operator is notified.
- **Residual risk that cannot be fully eliminated:** an LLM can still produce a
  plausible wrong number even with correct inputs and explicit instructions.
  This must be *accepted and disclosed*, not pretended away — hence the standing
  disclaimer in CP5 is mandatory, not optional.

## 3.1 The second-data-source question (CP3)

The user wants more than one source for credibility, and is open to multiple
free sources and/or a paid premium one. Important constraint discovered: the
**Yahoo chart endpoint already in use does NOT cleanly expose fundamentals**
(ROE/ROIC/PEG) — it is a price endpoint. So "add Yahoo as the second source for
fundamentals" (suggested earlier) does not actually work as stated. Realistic
options to research and compare before choosing:

- **Financial fundamentals (ROE/ROIC/PEG/DCF):** candidates include
  Alpha Vantage (already have a key; has fundamentals endpoints), Finnhub (free
  tier), and the existing FMP as the primary. A paid option (e.g. a second
  premium provider) could serve as an authoritative tie-breaker.
- **Cross-check logic:** show both sources side-by-side; flag when they diverge
  beyond a threshold (e.g. >20%); never silently pick one.
- **Vercel 12-function limit** means a second source should be added *inside an
  existing function*, not as a new route.

This needs a dedicated research pass (cost, coverage, rate limits, license)
before committing — flagged as the next decision, not decided here.

---

# PART 4 — PROPOSED BUILD ORDER (for review)

Derived from the FMEA ranking + defense-in-depth, **not** from intuition:

1. **CP6 — Monitoring** (RPN 640). Health report + Telegram alert. Makes every
   other failure visible. Highest leverage.
2. **CP2 — Data-assembly fix** (RPN 432 root-cause). Pre-format metrics, add
   `DATA_QUALITY` block, kill silent `null`. Removes the incident's root cause.
3. **CP3 — Anti-hallucination prompt + second source** (RPN 486). Field-name
   discipline in prompts; add a cross-checking source.
4. **CP1 — Input health checks** (RPN 432). Detect dead sources before they
   reach the LLM.
5. **CP5 — Presentation transparency** (RPN 336). Freshness/quality footer +
   permanent disclaimer (also covers the accepted residual LLM risk).
6. **CP4 — Write verification** (RPN 126). Lowest risk, do last.

**Pre-work before any of the above (housekeeping that blocks trust):**
- Rotate the FMP key and confirm code reads `process.env.FMP_API_KEY` (F7).
- Rotate the `theisilabs2026` auth token and close the no-key auth gap (F7).
- Consolidate the version-sprawl docs into one source of truth and reconcile the
  SPUS rule, scenario IDs, and top-10/20 discrepancies noted in Part 1.

---

# PART 5 — OPEN QUESTIONS FOR THE REVIEWER

1. Are the FMEA S/O/D scores in §2.3 reasonable, or should any be re-weighted?
   (They are estimates, by design open to challenge.)
2. Is "monitoring first" the right call, or is fixing the root-cause data bug
   (CP2) more urgent for trust given it caused the incident?
3. For the second data source (CP3): free-only with multiple providers, or pay
   for one authoritative premium tie-breaker? What budget is acceptable?
4. Given the Vercel 12-function hard limit, are we comfortable adding logic
   inside existing functions rather than new routes?
5. The Make.com layer has no version control and can't be edited from code —
   is snapshotting prompts to the repo (CP6-adjacent) sufficient, or is the
   Railway migration (already on the roadmap) the real long-term fix?

---

*End of v1. This document is a proposal for review. Nothing in Parts 2–5 has
been implemented. Part 1 reflects the system as documented in the project files
as of 2026-06-03; items marked DISCREPANCY require confirmation against live
production before being relied upon.*
