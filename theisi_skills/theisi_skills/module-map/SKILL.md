---
name: theisi-module-map
description: Use this skill whenever working with Make.com scenarios for THEISI. Contains the complete module number map for all 4 scenarios, variable names, connection details, and scenario IDs. Always check here before referencing any module number.
---

# THEISI Make.com Module Map

## ACCOUNT
- URL: eu1.make.com/1748978
- Region: EU1

---

## SCENARIO 5826977 — MORNING BRIEF
Sends daily Arabic morning brief to Telegram at 7:00 AM UAE

---

## SCENARIO 5904255 — INTELLIGENCE ENGINE  
Daily/Weekly/Monthly deep analysis to Dashboard + Telegram at 7:10 AM UAE

Key modules:
- Module 7: Claude Daily Analysis
- Module 14/44: Claude Monthly Analysis (confirm number in UI)
- Module 15: Telegram send

---

## SCENARIO 5958357 — USER ANALYSIS ENGINE
Per-user analysis sent at 7:30 AM UAE
- Legal tier: informational only + "not financial advice" disclaimer
- Module 13: Claude analysis
- Module 7: Data fetch

---

## SCENARIO 5832754 — SOCIAL MEDIA INSTAGRAM
Daily Instagram carousel + Reel pipeline

### Complete Module Map

| # | Name | Purpose | Key Input | Key Output |
|---|------|---------|-----------|------------|
| 54 | FMP + News data | Fetch stock data + news | — | fmp_gainers_data, newsapi_data |
| 72 | Claude Validator | Extract + validate stocks | {{54.*}} | JSON with verified_stocks |
| 9 | Parse JSON | Parse validated data | {{72.result}} | sym1-3, pct1-3, hook_main, market_context, image_keyword1-3 |
| 17 | hcti.io Slide 1 | Generate hook slide image | {{9.*}} | data.url |
| 18 | hcti.io Slide 2 | Generate stock 1 slide | {{9.*}} | data.url |
| 19 | hcti.io Slide 3 | Generate stock 2 slide | {{9.*}} | data.url |
| 5 | hcti.io Slide 4 | Generate stock 3 slide | {{9.*}} | data.url |
| 20 | hcti.io Slide 5 | Generate summary slide | {{9.*}} | data.url |
| Sleep | Sleep 10s | Wait for hcti.io render | — | — |
| 21 | Instagram Carousel | Post 5-slide carousel | {{17/18/19/5/20.data.url}} | Post ID |
| 227 | Claude Script Writer | Write Arabic voiceover script | {{9.*}} | result (Arabic script with [PART] markers) |
| 238 | Claude Script Splitter | Split script into 3 parts | {{227.result}} | result (JSON) |
| 239 | Parse JSON | Parse 3 script parts | {{238.result}} | part1, part2, part3 |
| 240 | Claude Visual Director | Generate Kling prompts | {{239.*}}, {{9.*}} | result (JSON) |
| 241 | Parse JSON | Parse video prompts | {{240.result}} | video1, video2, video3 |
| 229 | fal.ai Kling clip 1 | Generate cinematic video | {{241.video1}} | data.video.url |
| 230 | fal.ai Kling clip 2 | Generate cinematic video | {{241.video2}} | data.video.url |
| 231 | fal.ai Kling clip 3 | Generate cinematic video | {{241.video3}} | data.video.url |
| 250 | Creatomate Render from JSON | Assemble final Reel | {{229/230/231.data.video.url}}, {{239.part1/2/3}} | url |
| 233 | Instagram Reel | Post Reel to @theisilabs | {{250.url}} | — |

### Orphaned/Unused Modules
- Module 228: ElevenLabs (orphaned — Creatomate calls EL directly)
- Module 232: Old Creatomate template module (replaced by 250)
- Module 243: Old HTTP Creatomate module (replaced by 250)
- Module 46: FMP Losers (disconnected — using watchlist endpoint instead)

---

## FMP WATCHLIST ENDPOINT
```
https://financialmodelingprep.com/stable/stock-price-change?symbol=NVDA,AAPL,MSFT,GOOGL,META,AMZN,TSLA,AMD,AVGO,QCOM,MU,TSM,PLTR,CRM,NOW,ORCL,JPM,BAC,GS,MS,V,MA,XOM,CVX,OXY,LMT,RTX,NOC,BA,LLY,JNJ,PFE,MRNA,ABBV,COIN,MSTR,NFLX,UBER,COST,WMT,NKE,PANW,CRWD,GLD,QQQ,SPY,SMH,BABA,IBIT,ARM&apikey=FMP_KEY
```

### FMP Data Field for % Change
- Use `1D` field for today's % change (NOT `changesPercentage`)
- Positive 1D = stock went UP
- Negative 1D = stock went DOWN

---

## MODULE 9 — EXPECTED JSON STRUCTURE
```json
{
  "sym1": "NVDA", "name1": "NVIDIA", "pct1": "+6.20%", "direction1": "up", "image_keyword1": "semiconductor",
  "sym2": "MU", "name2": "Micron", "pct2": "-13.10%", "direction2": "down", "image_keyword2": "memory chip",
  "sym3": "ARM", "name3": "ARM Holdings", "pct3": "-12.80%", "direction3": "down", "image_keyword3": "chip design",
  "hook_main": "رقائق تحترق اليوم 🔥",
  "market_context": "قطاع التكنولوجيا تحت ضغط",
  "news": [...]
}
```

---

## MODULE 227 — SCRIPT WRITER SETTINGS
- Model: claude-sonnet-4-6
- Max tokens: 1000
- Output format: Arabic script with [PART] separators
- Part 1: Stock 1 story (~40 words)
- Part 2: Stock 2 and 3 story (~40 words)
- Part 3: Forecast and closing (~40 words)

## MODULE 238 — SCRIPT SPLITTER PROMPT
```
Split this Arabic script into exactly 3 parts at the [PART] markers.
SCRIPT: {{227.result}}
Output ONLY this JSON (no markdown, no backticks):
{"part1": "...", "part2": "...", "part3": "..."}
```

## MODULE 240 — VISUAL DIRECTOR SETTINGS
- Model: claude-sonnet-4-6
- Max tokens: 1000
- Output: JSON with video1, video2, video3 Kling prompts
- Each prompt: cinematic, dark, financial, no people/text/logos

---

## API KEYS LOCATION
- FMP: Make.com HTTP module headers (not in docs — check module 54)
- ElevenLabs: Creatomate Project Settings → Integrations (connected directly)
- fal.ai: Make.com HTTP module headers in modules 229, 230, 231
- Creatomate: Make.com Creatomate connection
- hcti.io: Make.com HTTP module headers
- Unsplash: Make.com module client_id parameter
- Instagram: Make.com Facebook/Instagram connection ID 8006670

---

## SCHEDULES (UAE time)
- Morning Brief: 7:00 AM daily
- Intelligence Engine: 7:10 AM daily  
- User Analysis: 7:30 AM daily
- Instagram: Daily (time TBD)
