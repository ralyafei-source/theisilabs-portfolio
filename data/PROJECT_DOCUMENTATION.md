# THEISI — Arabic Finance Intelligence System
## Project Documentation — Living Document
**Last Updated: June 15, 2026 — Session 35+**

---

## Owner
- **Name:** Rashed Abdulla Mohamed Kebais Alyafei
- **Location:** Abu Dhabi, UAE (GMT+4)
- **Broker:** Wio Invest (DriveWealth) — Account: WIGG000023
- **Portfolio Value:** ~$500,247 (June 2026)
- **Total Holdings:** 46 positions

---

## Quick Start for New Sessions

Tell Claude:
> "I am Rashed, continuing the THEISI Arabic Finance Intelligence System project. Read the project documentation and continue from where we stopped."

**Always read ALL files in the project before doing anything.**

---

## System Status (June 15, 2026)

| Component | Status | Notes |
|-----------|--------|-------|
| Morning Brief (Scenario 255) | ✅ Working | Telegram, daily |
| Price Alerts (Scenario 2) | ✅ Working | Telegram, market hours |
| Dashboard (theisilabs.vercel.app) | ✅ Live | v13.31 |
| Instagram | ⏳ Pending | Facebook login issue |
| Deep Analysis | ✅ Built | Part of Scenario 255 |
| Backtest Engine | ✅ Built | New — needs ANTHROPIC_API_KEY in Vercel |

---

## Architecture

```
Make.com eu1.make.com/1748978
├── Scenario 255 (Morning Brief + Weekly + Monthly)  ID: 5826977
│   ├── Daily: signals, stop-loss, conviction trade → Telegram
│   ├── Weekly (Saturday): risk radar, fair value, momentum, scoring engine
│   └── Monthly (1st Sunday): competitive edge, long view, portfolio health
├── Scenario 2 (Price Alerts)  ID: 5827323
│   └── Mon-Fri 4:30pm-11pm UAE, every 30min → Telegram
└── Scenario 922 (Opportunity Scanner)
    └── Daily: 50 stock opportunity universe → scored cards

GitHub: ralyafei-source/theisilabs-portfolio
Vercel: theisilabs.vercel.app (auto-deploys from GitHub)

Data:
├── data/portfolio.json              → 46 holdings
├── data/analysis-daily-rashed-{date}.json
├── data/analysis-weekly-rashed-{YYYY-MM}.json
├── data/analysis-monthly-rashed-{YYYY-MM}.json
├── data/market/brief-rashed-{date}.json
└── data/scored-{date}.json

API Routes (Vercel serverless):
├── /api/portfolio-for-ai            → live portfolio text for Claude
├── /api/historical-snapshot         → historical portfolio + technicals for backtest
└── /api/backtest-analyze            → server-side Claude proxy for backtest
```

---

## Credentials (DO NOT SHARE)

```
Make.com:         eu1.make.com/1748978
Scenario 255 ID:  5826977  (Morning Brief / Weekly / Monthly)
Scenario 2 ID:    5827323  (Price Alerts)
Vercel auth key:  theisilabs2026
FMP API key:      pSwvmzs4KUzvmePFIbSF0ulu5KnxcrHj
Telegram Chat ID: 1365815413
GitHub repo:      ralyafei-source/theisilabs-portfolio
```

**GitHub token expires — rotate at github.com/settings/tokens when needed.**

---

## Dashboard — theisilabs.vercel.app

**Current version:** v13.31 (June 15, 2026)
**File:** index.html in GitHub root (auto-deploys to Vercel)
**Working file in sessions:** /home/claude/index_fixed.html
**Deliver script:** /home/claude/deliver.sh {version}
**Push pattern:**
```python
# Always use this Python pattern to push to GitHub
import json, base64, urllib.request
TOKEN = "ghp_..."   # rotate when expired
REPO  = "ralyafei-source/theisilabs-portfolio"
# GET sha → PUT with content
```

### Dashboard Tabs

**AI Advisor** (main section — Arabic):
| Tab | Content | Data Source |
|-----|---------|-------------|
| مراكزي | Daily signals + stop-loss + conviction + weekly scoring | daily + weekly |
| المخاطر والصحة | Risk radar (collapsible) + portfolio health cards | weekly + monthly |
| فرص السوق | Opportunity cards (scored universe) | daily scored |
| قوى السوق | Macro + earnings (collapsible) | daily |
| النظرة البعيدة | Competitive + long view (side by side) | monthly |
| 🔬 اختبار الدقة | Backtest engine — pick date, run Claude, compare to reality | historical |

### Key Rendering Functions
```
renderSignals(text, weeklyData)       → main positions table (7 cols: الرمز/التوصية/مركزك/هدف/DCF/RSI/الاتجاه/السبب)
renderWeeklyIntegrated(...)           → risk radar + stress test + momentum + analyst grades
renderScoring(text)                   → 5-layer scoring cards with hover popup
renderHealthSummary(text)             → scored cards (66/100) from monthly health
renderCollapsibleSections(text, title)→ collapsible sections for risk/earnings/competitive/longview
```

### Scoring Popup (Scoring Engine tab)
- Hover card → popup appears fixed at top-right (right:16px, top:72px, 380px wide)
- Click card → popup locks, scrollable
- ✕ button to close
- No mouse-following behavior

### Positions Table Columns
الرمز | التوصية | مركزك | هدف 12ش | DCF↕ | RSI | الاتجاه | السبب (120 chars)
- Sortable: click الرمز / مركزك / DCF / RSI headers
- Weekly data merged in (DCF from fair value, RSI/trend from momentum)
- السبب: uses الإشارة from weekly momentum (clean Arabic sentence)

### FIRM_GROUPS (panel grouping)
```javascript
FIRM_GROUPS = {
  positions:    ['signals','momentum','scoring'],
  riskhealth:   ['risk','health'],
  opportunities:['opportunities'],
  forces:       ['macro','earnings'],
  longgame:     ['competitive','longview'],
  backtest:     ['backtest']
}
```

---

## Scoring Engine — 5-Layer Weights

| Layer | Arabic | Weight | Measures |
|-------|--------|--------|---------|
| 1 | مركزك الشخصي | 15% | Your P&L + position size vs Goldman 25% rule |
| 2 | التقييم | 30% | DCF upside, analyst target, P/E vs history |
| 3 | التقني | 20% | RSI, MACD, Golden/Death Cross, EMA |
| 4 | الأساسيات | 25% | Earnings beat rate, ROE, ROIC, moat |
| 5 | الخارجي | 10% | Analyst consensus count, upgrades, macro |

**Score 7.5+ = تراكم, 6-7.4 = احتفظ, below 6 = مراقبة**

---

## Weekly Section Markers (in data files)
```
═══ RISK RADAR ═══
═══ FAIR VALUE ═══
═══ MOMENTUM ═══
═══ SCORING ENGINE ═══
```
**Critical:** Must be exact UTF-8 `═` characters (not corrupted `â•`)

---

## Backtest Engine (NEW — June 2026)

### How it works
1. User picks a date (e.g. 2025-11-11)
2. `/api/historical-snapshot?date=...&format=json` fetches:
   - Yahoo Finance OHLC for all 46 stocks from that date (300 days lookback)
   - Calculates RSI-14, SMA50, SMA200, EMA20, MACD from raw OHLC
   - Returns portfolio text in same format as portfolio-for-ai
3. `/api/backtest-analyze` sends text to Claude server-side (avoids CORS)
4. Claude outputs structured `[[SYM|rec|score|reason]]` format
5. Dashboard parses, fetches current prices, calculates hit rate and alpha

### To activate fully
Add `ANTHROPIC_API_KEY` to Vercel environment variables:
- vercel.com → theisilabs-portfolio → Settings → Environment Variables
- Key: `ANTHROPIC_API_KEY`
- Value: sk-ant-... (same key used in Make.com)

### Test dates worth running
| Date | Event | Why interesting |
|------|-------|----------------|
| 2025-01-27 | DeepSeek announcement | NVDA -17% next day — did risk show? |
| 2025-04-03 | Tariff crash | Would concentration risk have flagged? |
| 2025-08-05 | Carry trade unwind | Broad crash signal test |
| 2025-11-11 | 6 months ago | General accuracy baseline |

### Scoring logic
- `تراكم` → correct if stock went up >5% since date
- `بيع/مراقبة` → correct if stock went down >5%
- ±5% = محايد (noise)

---

## Data Parsing — Daily Signals Format

### Section 1 Table (main positions)
```
| الرمز | التوصية | السبب | مركزك الحالي | توقعات المحللين 12 شهر |
```
Recommendation tags: `<b>تراكم</b>`, `<b>احتفظ</b>`, `<b>مراقبة</b>`, `<b>بيع</b>`

### Section 2 (Stop-Loss)
```
| الرمز | الخسارة% | التوصية | السبب المحدد |
```

### Section 3 (Conviction Trade)
```
<b>CRM</b> | 55 سهماً | $182.55
1. ...
🎯 **الهدف:** $274.00
```

### Weekly Momentum Table
```
| SYMBOL | RSI | MACD Cross | الإشارة |
```
الإشارة is a full Arabic explanation sentence — used as السبب in the merged table.

### Weekly Scoring Format
```
<b>AMZN | Score 7.9/10 | شراء 📈</b>
[طبقة content]
→ **درجة هذه الطبقة: X/10**
```

---

## Make.com — Scenario 255 Structure

### Router Logic (Module m13)
- Route 1 (fallback): Daily analysis
- Route 2 (Sunday + day≤7): Monthly analysis
- Route 3 (Saturday): Weekly analysis

### Key Modules
```
m12  → portfolio-for-ai API (without ?include=intelligence to avoid bloat)
m16  → Claude content[].text (use content[].text not content[1].text for thinking models)
m17  → Save daily JSON to GitHub
m5   → Send to Telegram
m23  → Telegram summary (max_tokens 1500)
m51/m52 → Weekly market context fed to m15 (weekly analysis)
```

### Authorization header for all API calls
```
Authorization: Bearer theisilabs2026
```

---

## Known Issues & Solutions

| Issue | Status | Solution |
|-------|--------|----------|
| GitHub token expires | Recurring | Rotate at github.com/settings/tokens |
| Scoring engine only got 3/5 stocks | Known | Claude hits 16k token limit — weekly prompt too long |
| Instagram posting | Pending | Facebook login issue |
| Backtest table empty (0 rows) | Pending | Add ANTHROPIC_API_KEY to Vercel env vars |
| FMP key domain-restricted | By design | Only works from Vercel server, not browser |

---

## Session History

### Sessions 1-3 (May 2026)
- Built Make.com morning brief (Scenario 1)
- Built price alerts (Scenario 2)
- Created initial dashboard HTML

### Sessions 4-15 (May-June 2026)
- Built Scenario 255 (full daily/weekly/monthly analysis)
- Fixed 10 bugs in 255 blueprint
- Added weekly section markers fix (UTF-8 corruption)
- Added weekly parser (Fair Value, Momentum, Risk, Scoring)
- Built integrated weekly renderer

### Sessions 16-25 (June 2026)
- Migrated dashboard to Vercel (theisilabs.vercel.app)
- Added opportunity scanner (Scenario 922)
- Built 5-layer scoring cards with hover popup
- Fixed scoring popup (fixed position, no mouse chase, clean Arabic)

### Sessions 26-30 (June 2026)
- Merged 3 tables into 1 unified positions table (7 columns)
- Restored all lost columns (السبب, RSI, DCF, stress test, analyst grades)
- Fixed السبب column (120 chars, clean Arabic, no + separators)
- Added sortable column headers
- Fixed scoring cards: sorted by score, clickable → full scoring tab

### Sessions 31-35 (June 14-15, 2026)
- **Major scroll reduction:** Risk&Health 10,435px → 1,032px (-90%)
- Health panel: raw text → scored cards (66/100 ring + 5 collapsible sections)
- النظرة البعيدة: stacked → side-by-side columns
- All panels: collapsible sections (earnings, risk, competitive, longview)
- Removed duplicate fairvalue tab
- Added 🔬 اختبار الدقة (Backtest) tab
- Built /api/historical-snapshot (Yahoo Finance historical OHLC + technicals)
- Built /api/backtest-analyze (server-side Claude proxy)
- Confirmed working: NVDA $193.16 on 11/11/2025, RSI 51.95, Golden Cross ✅

---

## File Reference

| File | Location | Purpose |
|------|---------|---------|
| index.html | GitHub root | Live dashboard (auto-deploys) |
| api/portfolio-for-ai.js | GitHub api/ | Live portfolio text endpoint |
| api/historical-snapshot.js | GitHub api/ | Historical data for backtest |
| api/backtest-analyze.js | GitHub api/ | Claude proxy for backtest |
| data/portfolio.json | GitHub data/ | 46 holdings with cost basis |
| data/analysis-daily-*.json | GitHub data/ | Daily analysis files |
| data/analysis-weekly-*.json | GitHub data/ | Weekly analysis files |
| data/analysis-monthly-*.json | GitHub data/ | Monthly analysis files |

---

## Next Priorities

1. **Add ANTHROPIC_API_KEY to Vercel** → activates full backtest table
2. **Run backtests on 3 key dates** → measure accuracy baseline
3. **Tune scoring weights** based on backtest results
4. **CEO decision panel** — combine قوى السوق + النظرة البعيدة into 4-zone single view
5. **Fix scoring engine token limit** — 255 prompt too long for 5 stocks, currently outputs 3
6. **Rotate GitHub token** — expires, need new one for next push session

