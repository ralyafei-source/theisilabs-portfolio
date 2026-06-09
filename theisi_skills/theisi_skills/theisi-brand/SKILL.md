---
name: theisi-brand
description: Use this skill for any task involving THEISI brand identity, colors, voice, Arabic tone, Instagram content, or visual design decisions. Contains brand colors, typography, voice ID, Arabic dialect rules, and content guidelines.
---

# THEISI Brand Skill

## BRAND IDENTITY

| Element | Value |
|---------|-------|
| Brand name | THEISI Labs / ثيسي |
| Tagline Arabic | افهم ما يهم |
| Tagline English | Understand What Matters |
| Instagram | @theisilabs |
| Audience | Gulf Arab investors, 25-45, Arabic-speaking |
| Tone | Intelligent friend, not a bank — confident, clear, never hype |

---

## COLORS

| Name | Hex | Use |
|------|-----|-----|
| Background dark | #111318 | Main background |
| Magenta/Pink | #FF0A78 | Primary accent, CTAs, highlights |
| Cold blue | #00c8ff | Secondary accent |
| White | #FFFFFF | Primary text |
| Gray | #888888 | Secondary text |

---

## TYPOGRAPHY

- Primary font: **Montserrat** (available in Creatomate)
- Arabic font fallback: **Noto Sans Arabic**
- Weights used: 300 (light), 400 (regular), 600 (semibold), 700 (bold)
- All Arabic text: `"direction": "rtl"`

---

## BRAND ASSET URLS (permanent hosted links)

- White wordmark logo: `https://i.ibb.co/67Rp23Cy/Theisi-logo-magenta-white-wordmark.png`
- Dark wordmark logo: NOT suitable for video overlays (dark text on dark bg)
- Grid background: `https://i.ibb.co/cKwHwLns/Theisi-labs-background1.png`

---

## VOICE — ELEVENLABS

| Setting | Value |
|---------|-------|
| Voice ID | 5kighi6IL2xc0truhsYk |
| Voice type | Gulf male, calm and confident |
| Model | eleven_multilingual_v2 |
| Stability | 0.75 |
| Provider string | `elevenlabs model_id=eleven_multilingual_v2 voice_id=5kighi6IL2xc0truhsYk stability=0.75` |

---

## ARABIC DIALECT RULES

- Dialect: Gulf Arabic (خليجي)
- Key phrases: يعني، شوف، ما كان، صار، راح، يمكن، بس، هادي
- Avoid: Formal MSA (فصحى) — too stiff
- Avoid: Egyptian dialect — wrong audience
- Numbers: Always Arabic numerals with % symbol
- Stock symbols: Keep in English (NVDA, AAPL, etc.)
- Percentage format: +6.20% or -3.51% (always 2 decimal places)

---

## INSTAGRAM REEL CONTENT RULES

### What works for Gulf finance audience
- Hook in first 3 seconds — bold Arabic number/stat
- Fast cuts — one visual per 5 seconds
- Emotional triggers: shock, curiosity, FOMO
- "What to watch next" angle drives saves
- Arabic subtitles boost retention 35%+
- Target length: 23-35 seconds (optimized for replays)

### Video structure
```
0-3s  → Hook screen (THEISI logo + bold Arabic stat)
3-8s  → Stock 1 cinematic clip + Part 1 voiceover
8-13s → Stock 2 cinematic clip + Part 2 voiceover
13-18s → Stock 3 cinematic clip + Part 3 voiceover
18-23s → THEISI outro ("تابعونا @theisilabs")
```

### What NOT to do
- No thriller/horror music — use news/breaking news style
- No movie-style AI visuals — use financial/real footage
- No slide presentations — cinematic only
- No text overload — subtitles only, no data boxes

### Visual style for Kling prompts
- Dark premium aesthetic — Bloomberg meets cyberpunk
- NO people, NO faces, NO text, NO logos in Kling videos
- Subjects: circuit boards, server rooms, trading screens, financial districts, oil refineries, abstract data flows
- Lighting: dramatic side lighting, neon reflections, deep shadows
- Camera: slow push-in, low angle tilt, aerial descent

---

## CONTENT TONE EXAMPLES

### Good script style
> شوف اللي صار اليوم — ميكرون غرقت 13% وسحبت معها كل قطاع الرقائق

### Bad script style  
> تشير المؤشرات إلى انخفاض ملحوظ في قطاع أشباه الموصلات

### Good hook
> ميكرون -13% في جلسة وحدة 📉

### Closing formula
> الصبر هو اللعبة الآن — تابعونا @theisilabs

---

## CAROUSEL DESIGN (5 slides)

- Generated via hcti.io HTML to image
- Slide 1: Hook — market summary
- Slides 2-4: Individual stock stories
- Slide 5: Top movers summary table
- Background: dark grid (#111318)
- Accent line: #FF0A78 horizontal divider
- Logo: top right on each slide
