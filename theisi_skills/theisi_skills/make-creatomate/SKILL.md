---
name: make-creatomate
description: Use this skill for any task involving Make.com modules, Creatomate video rendering, Kling video generation, ElevenLabs voice, or the Instagram Reel pipeline in the THEISI system. Covers correct JSON syntax, module configuration, error solutions, and API patterns.
---

# Make.com + Creatomate Skill for THEISI

## CRITICAL RULES — READ FIRST

1. Creatomate media elements use `"source"` NOT `"src"` — using `"src"` causes silent failures
2. Every element inside a composition MUST have a `"track"` number — missing tracks cause rendering errors
3. ElevenLabs audio element uses `"source"` for the text, NOT `"text"`
4. Creatomate native module "Render from JSON" (module 250) accepts the JSON directly as a string — no wrapper needed
5. Make.com variables `{{x.y}}` work inside the Creatomate "Render from JSON" module source field
6. Kling text-to-video endpoint: `https://fal.run/fal-ai/kling-video/v2.6/pro/text-to-video`
7. Kling response path for video URL: `{{module_number.data.video.url}}`
8. Instagram Reel video URL from Creatomate native module: `{{250.url}}`

---

## SCENARIO 754 — INSTAGRAM REEL PIPELINE

### Module Flow (in order)
```
54 (FMP Data) → 72 (Claude Validator) → 9 (Parse JSON) → 
17/18/19/5/20 (hcti.io slides) → [Sleep 10s] → 21 (Instagram Carousel) →
227 (Script Writer) → 238 (Script Splitter) → 239 (Parse JSON parts) →
240 (Visual Director) → 241 (Parse JSON videos) →
229/230/231 (Kling text-to-video) → 250 (Creatomate Render from JSON) →
233 (Instagram Reel)
```

### Key Module Numbers
| Module | Purpose | Key Output |
|--------|---------|------------|
| 9 | Parse JSON — stock data | sym1/2/3, pct1/2/3, hook_main, market_context, image_keyword1/2/3 |
| 227 | Claude Script Writer | 227.result — full Arabic script with [PART] separators |
| 238 | Claude Script Splitter | 238.result — JSON with part1/part2/part3 |
| 239 | Parse JSON | 239.part1, 239.part2, 239.part3 |
| 240 | Claude Visual Director | 240.result — JSON with video1/video2/video3 prompts |
| 241 | Parse JSON | 241.video1, 241.video2, 241.video3 |
| 229 | Kling clip 1 | 229.data.video.url |
| 230 | Kling clip 2 | 230.data.video.url |
| 231 | Kling clip 3 | 231.data.video.url |
| 250 | Creatomate Render from JSON | 250.url |
| 233 | Instagram Reel post | — |

---

## CREATOMATE JSON TEMPLATE — CORRECT FORMAT

### Rules for Creatomate JSON
- All media: `"source": "URL"` (never `"src"`)
- Audio TTS: `"source": "text to speak"` + `"provider": "elevenlabs model_id=... voice_id=..."`
- Transcript: `"transcript_source": "element-name"` references audio element by its `"name"` field
- Compositions auto-expand to match longest child when no duration set
- Track numbers prevent element overlap: track 1 = background, track 2 = overlay, etc.
- Font sizes use vmin units: `"6.5 vmin"` (responsive to canvas size)
- Alignment: `"x_alignment": "50%"` for center (NOT "center")
- RTL Arabic: add `"direction": "rtl"` to text elements

### ElevenLabs Provider String
```
elevenlabs model_id=eleven_multilingual_v2 voice_id=5kighi6IL2xc0truhsYk stability=0.75
```

### Correct Composition Structure
```json
{
  "type": "composition",
  "track": 1,
  "elements": [
    {"type": "video", "track": 1, "source": "{{229.data.video.url}}", "fit": "cover", "volume": 0},
    {"type": "shape", "track": 2, "shape": "rectangle", "fill_color": "#111318", "opacity": 0.5},
    {"type": "image", "track": 3, "source": "LOGO_URL", "width": "25%"},
    {"name": "Voiceover-1", "type": "audio", "track": 4, "source": "{{239.part1}}", "provider": "elevenlabs model_id=eleven_multilingual_v2 voice_id=5kighi6IL2xc0truhsYk stability=0.75"},
    {"type": "text", "track": 5, "transcript_source": "Voiceover-1", "direction": "rtl"}
  ]
}
```

---

## KLING VIDEO GENERATION

### Endpoints
| Version | URL | Cost/5s | Use |
|---------|-----|---------|-----|
| v2.6 pro | `https://fal.run/fal-ai/kling-video/v2.6/pro/text-to-video` | ~$0.35 | Current (testing) |
| v2.1 master | `https://fal.run/fal-ai/kling-video/v2.1/master/text-to-video` | ~$1.40 | Production quality |

### Request Body
```json
{
  "prompt": "{{241.video1}}",
  "duration": "5",
  "aspect_ratio": "9:16"
}
```

### Headers Required
- `x-fal-key: FAL_API_KEY`
- `Content-Type: application/json`

### Timeout: 300 seconds (must set this or it times out)

---

## COMMON ERRORS & FIXES

| Error | Cause | Fix |
|-------|-------|-----|
| `Path /v2.1/standard/text-to-video not found` | Wrong Kling endpoint | Use v2.6/pro or v2.1/master |
| `timeout of 40000ms exceeded` | Kling takes too long | Set timeout to 300 in HTTP module |
| `[500] server could not process` | Wrong Creatomate JSON (src vs source) | Replace all `src` with `source` |
| `Only photo or video can be accepted` | Instagram getting wrong URL | Check {{250.url}} mapping |
| `Specified object does not exist` | Wrong Creatomate output path | Use `{{250.url}}` not `{{250.data.url}}` |
| `BundleValidationError jsonStringBodyContent` | HTTP module body validation | Use Creatomate native "Render from JSON" module instead |
| `Response marked as invalid` | Wrong field format in Creatomate module | Source field accepts plain JSON string with {{variables}} |

---

## MAKE.COM HTTP MODULE BEST PRACTICES

- For Creatomate: always use native Creatomate module, NOT HTTP module
- For fal.ai Kling: use HTTP module with Body content type = application/json, Body input method = JSON string
- Variables like `{{9.sym1}}` work inside JSON string body fields
- Set timeout = 300 for any AI generation module (Kling, ElevenLabs)
- Always enable "Parse response: Yes" to access nested output fields

---

## PEXELS API (for real footage — planned)
- Free tier: 200 requests/hour
- Search endpoint: `https://api.pexels.com/videos/search?query=KEYWORD&orientation=portrait&per_page=1`
- Header: `Authorization: PEXELS_API_KEY`
- Video URL path: `response.videos[0].video_files[0].link`

---

## BRAND ASSETS URLs
- White logo (for dark backgrounds): `https://i.ibb.co/67Rp23Cy/Theisi-logo-magenta-white-wordmark.png`
- Dark grid background: `https://i.ibb.co/cKwHwLns/Theisi-labs-background1.png`
