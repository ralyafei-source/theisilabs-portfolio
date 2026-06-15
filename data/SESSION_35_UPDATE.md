# SESSION 35 UPDATE — June 15, 2026

## What was done this session

### Dashboard (index.html → v13.31)

#### Table improvements (v13.17–v13.21)
- Merged 3 separate tables into 1 unified positions table
- 7 columns: الرمز | التوصية | مركزك | هدف 12ش | DCF↕ | RSI | الاتجاه | السبب
- السبب: 120 chars, uses الإشارة from weekly momentum (clean Arabic, no + separators)
- DCF and RSI sourced from weekly fair value / momentum sections
- Sortable columns: click الرمز / مركزك / DCF / RSI headers (▲/▼ indicator)
- Restored all lost data: stress test table, analyst grades, dollar loss in risk cards

#### Scoring cards (v13.22–v13.24)
- محرك القرار الأسبوعي cards now in green conviction column (below CRM card)
- Sorted by score descending: NVDA 8.2 → AMZN 7.9 → PANW 7.5
- Removed from fairvalue + momentum tabs (was showing in 3 places)
- Click any card → navigates to full Scoring Engine tab
- Scoring popup: fixed position right side (right:16px, top:72px), no mouse chasing
- Clean Arabic text (was showing garbled âœ… → now clean مرّر لقراءة)

#### Scroll reduction (v13.25–v13.27)
- Health panel: 8,188px raw text → 273px scored cards (66/100 ring + 5 `<details>` cards)
- Risk&Health tab: 10,435px → 1,032px (-90%)
- Removed duplicate fairvalue tab from positions group
- renderCollapsibleSections() added: collapses earnings/risk/competitive/longview
- النظرة البعيدة: stacked → side-by-side columns (competitive | longview)

#### Backtest Engine (v13.28–v13.31)
- New tab: 🔬 Accuracy test (اختبار الدقة)
- FIRM_GROUPS.backtest = ['backtest'] added
- initBacktestPanel() builds date picker UI
- runBacktest() orchestrates 4 steps with progress bar

### New Vercel API Routes

#### /api/historical-snapshot
- GET ?date=YYYY-MM-DD&format=json
- Uses Yahoo Finance historical OHLC (300 days lookback)
- Calculates RSI-14, SMA50, SMA200, EMA20, MACD from raw closes
- Returns same text format as portfolio-for-ai (same Claude prompt works)
- Confirmed working: NVDA $193.16 on 2025-11-11, SPY $583 ✅
- Cache: 7200s

#### /api/backtest-analyze
- POST {portfolioText, date}
- Server-side Claude proxy (avoids CORS — Anthropic blocks browser calls)
- Uses claude-sonnet-4-6, max_tokens 4000
- System prompt asks for [[SYM|rec|score|reason]] format
- Reads ANTHROPIC_API_KEY from Vercel env vars

### What still needs doing
1. Add ANTHROPIC_API_KEY to Vercel → full backtest table works
2. Run backtests on 3 dates (DeepSeek crash, tariff crash, Aug carry trade)
3. Tune scoring weights based on results
4. Fix scoring engine: only outputs 3/5 stocks (Claude hits token limit)
5. Rotate GitHub token when expired

## Scroll heights (before/after)
| Tab | Before | After |
|-----|--------|-------|
| مراكزي | 4,217px | 2,999px |
| المخاطر والصحة | 10,435px | 1,032px (-90%) |
| فرص السوق | 2,062px | 2,062px |
| قوى السوق | 4,747px | 3,969px |
| النظرة البعيدة | 6,412px | 4,935px |

## Key code locations in index.html
```
renderSignals()              → line ~5878
renderWeeklyIntegrated()     → line ~6730
renderHealthSummary()        → line ~5920
renderCollapsibleSections()  → line ~5878
renderScoring()              → line ~7300
positionScoringPopup()       → line ~7452
sortPosTable()               → line ~5786
runBacktest()                → in backtest engine block
initBacktestPanel()          → in backtest engine block
FIRM_GROUPS                  → line ~4545
```
