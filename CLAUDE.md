# CLAUDE.md — Theisi Labs / Arabic Finance Intelligence System

This file is read automatically at the start of every Claude Code session.
It defines how to work on this repository. Read it fully before making changes.

---

## WHAT THIS PROJECT IS

An Arabic financial intelligence platform for a UAE investor (Rashed).
It monitors the US market, scores the portfolio, and publishes Arabic content
to Telegram and Instagram. Orchestration runs on Make.com; code lives here on
Vercel; data lives in this repo as JSON.

- Live dashboard: https://theisilabs.vercel.app
- Repo: github.com/ralyafei-source/theisilabs-portfolio
- Make.com: eu1.make.com/1748978

---

## GOLDEN RULES (never violate)

1. **Never start over.** Always build on what already exists. This system has
   20+ sessions of work behind it — extend, don't rewrite.
2. **SPUS is a normal ETF.** It is a Sharia-compliant ETF, but it gets NO special
   treatment — evaluate it on performance and merits like any other holding. It is
   NOT excluded from sell/reduce recommendations. (Superseded the old "never sell
   SPUS" rule — Session 23.)
3. **No shorts, no options.** Long positions and ETFs only. (Platform constraint —
   do not hardcode a specific broker name.)
4. **UAE investor — zero capital gains tax.** Factor this into position sizing;
   don't let tax thinking block a good decision.
5. **All Telegram output must be Arabic.** Dashboard is EN/AR toggle (default EN).
6. **Explain before doing.** Describe the change, then make it. Owner is
   non-technical — be specific and concrete.
7. **Commit after each working change** so there's always a clean rollback point.

---

## SECRETS — DO NOT COMMIT

Never put live secrets in this repo or in this file. They belong in Vercel
environment variables only.

- `FMP_API_KEY` — Vercel env var (FMP Premium plan)
- `BRIEFING_API_KEY` — Vercel env var (the API auth token)
- Telegram bot tokens — stored in Make.com connections only

If you find a hardcoded key/token in any file (e.g. a fallback default in
portfolio-for-ai.js), flag it and move it to `process.env`. Do not echo secret
values back in chat or commit messages.

---

## REPO STRUCTURE

- `index.html` — the full dashboard (single file). Portfolio, trends, AI Advisor
  tabs, auth system, glossary, portfolio chat.
- `api/portfolio-for-ai.js` — main data endpoint. Returns the portfolio as
  formatted plain text for Claude to read. Supports:
  - `?nickname=NAME` — per-user portfolio (reads `data/portfolio-NAME.json`)
  - `?include=intelligence` — appends FMP technicals, earnings, targets,
    grades, key metrics
- `api/analysis.js` (and related) — saves/serves daily/weekly/monthly analysis
- `data/portfolio.json` — Rashed's portfolio (source of truth for holdings)
- `data/portfolio-NAME.json` — other users' portfolios

**Vercel function limit: 12 functions, currently AT the limit.** Adding a new
API route requires removing or merging one first. Plan around this.

---

## DATA SOURCES

- Live prices: Yahoo Finance chart endpoint (no key)
- FMP Premium (`https://financialmodelingprep.com/stable`): RSI, MACD (or
  self-calculated from EMA12/EMA26), SMA50/200, EMA20, Bollinger Bands,
  earnings calendar, price-target consensus, analyst grades, key metrics TTM,
  DCF, historical P/E + PEG, analyst consensus
- NewsAPI, Seeking Alpha RSS — news/articles

---

## MAKE.COM (cannot be edited from Claude Code)

Claude Code cannot reach inside Make.com scenarios. For those, prepare the exact
prompt text / formula and the owner pastes it into the Make UI.

Scenarios:
- 5826977 — 🌅 Morning Brief (7:00 AM UAE) → Telegram
- 5904255 — 🧠 Intelligence Engine (7:10 AM UAE) → Dashboard + Telegram
- 5958357 — 👥 User Analysis Engine (7:30 AM UAE)
- 5832754 — 📱 Instagram (scheduled daily)

Make.com conventions (use exactly):
- Claude module output = `{{moduleNumber.content[1].text}}`
- UAE timezone = `addHours(now;4)`
- HTTP body carrying Claude content = **Custom** content type (NOT application/json)
- Claude modules = native Anthropic "Create a Prompt" (NOT HTTP)
- Make.com model string = `claude-sonnet-4-20250514`

Router filters (Scenario 255), UAE time:
- Monthly: `formatDate(addHours(now;4);"dddd") = Sunday` AND `formatDate(addHours(now;4);"D") <= 7`
- Weekly: `formatDate(addHours(now;4);"dddd") = Saturday`
- Daily: fallback route

---

## SCORING ENGINE (already built)

5 weighted layers → final 1–10 score (a "should I act NOW" signal, not a
quality rating):
- Personal Position 15% | Valuation 30% | Technical 20% | Fundamental 25% | External 10%

Institutional rules cited in every recommendation (Goldman 25% rule,
Renaissance, Bridgewater, Graham, Lynch, Druckenmiller, Buffett, Marks,
McKinsey moat). Every sell must state exact shares/price/$ and where freed
capital goes. See `SCORING_ENGINE_FRAMEWORK` doc for full detail.

---

## CLAUDE CODE WORKING HABITS

- Use `/clear` between unrelated tasks — context pollution degrades quality.
- Commit before risky changes; commit after each working subtask.
- Be specific in requests (name the file and function, not "clean up X").
- When unsure what current code looks like, read the file first — never guess.
- After changing the dashboard, the deploy is via Vercel (Git push triggers it).

---

## CURRENT FOCUS / FUTURE PLAN

1. Multi-user — `?nickname=` support on portfolio-for-ai.js (mind the 12-fn limit)
2. Railway migration — replace Make.com orchestration (multi-session effort)
3. Automated dashboard testing
4. Short-interest data source
5. Dashboard footer disclaimer text
