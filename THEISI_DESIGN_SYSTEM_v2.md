# THEISI LABS — DESIGN SYSTEM
## The governance standard for premium financial UI
### v2.0 · 2026-06-08 · Source of truth for all visual/UX tokens

> **Core philosophy.** THEISI is a premium, institutional-grade financial product. The UI is
> calm, data-dense, and highly legible. We use **semantic color** to convey information,
> **mathematical spacing** (8px grid) to create structure, and **restrained motion** to confirm
> interactions. Clarity over decoration; intent over style; restraint as sophistication.
>
> **Authority.** Sits below `THEISI_CORE_PRINCIPLE.md` (product philosophy) and
> `prompt_11_theisi_design_director.txt` (design intent / the "why"), but is the **binding source
> of truth for concrete values** — colors, spacing, fonts, motion. When philosophy and this doc
> disagree on a *value*, **this doc wins for web/dashboard pixels.** Social/video may differ — §8.
>
> **The most important rule in this document:** every item is tagged **[AS-BUILT]** (true in the
> live `index.html` today) or **🎯 [TARGET]** (planned, not yet shipped — see Roadmap §9). Never
> let these blur. If you build a [TARGET] item, move it to [AS-BUILT] and bump the version.
> Items messy-but-working are tagged **⚠ NEEDS CONSOLIDATION** — don't "fix" without a tested refactor.

---

## 1. COLOR TOKENS — VALIDATED PALETTE

The palette is **reviewed and approved** as a premium foundation for dashboard + future website.
Dark is the **default** (`:root`); light is applied via `[data-mode="light"]` on `<html>`. There is
**no `[data-mode="dark"]` selector** — dark-specific CSS goes in `:root`.

Design logic (why this is premium): near-black surfaces (never pure `#000`, which causes OLED
halation), three layered depths for elevation-via-background (not shadow), one identity color
(magenta) with everything else reserved for meaning, and modern desaturated functional colors.

### 1.1 Grayscale / surfaces

| Token | Dark [AS-BUILT] | Light [AS-BUILT] | Use |
|---|---|---|---|
| `--bg`  | `#0B0B0D` | `#EDEEF2` | App canvas (deepest). Light canvas is a step *darker* than cards so white cards lift. |
| `--bg2` | `#121217` | `#FFFFFF` | Cards, panels |
| `--bg3` | `#1A1A21` | `#F4F5F8` | Inner surfaces (table headers, inputs, items) |
| `--bg4` | `#22222C` | `#E4E6EC` | Highest elevation |
| `--border`  | `#1F1F29` | `#E2E4EA` | Default 1px borders |
| `--border2` | `#2A2A38` | `#D3D6DF` | Stronger border |
| `--border3` | `#34344A` | `#BFC3CF` | Hover/active border |

Borders are **never thicker than 1px**. Dark mode = depth via bg layers (no shadow); light mode
lifts cards with a soft shadow (`0 1px 3px / 0 4px 14px` at ~0.05–0.06 alpha).

### 1.2 Text — 3-tier, WCAG-validated

| Token | Dark | Light | Tier / use |
|---|---|---|---|
| `--text`  | `#F4F4F6` | `#16161D` | Tier-2 body / primary |
| `--text2` | `#9595A8` | `#5E5E70` | Secondary / metadata |
| `--text3` | `#82829A` ✅ updated | `#6E6E82` ✅ updated | Tier-3 labels / captions |

> **⚠ CONTRAST FIX (v2.0):** `--text3` was `#5C5C70` (dark) / `#9A9AAC` (light) — both **failed WCAG AA**
> (2.86 / 2.77, floor is 4.5:1). Updated to `#82829A` / `#6E6E82`. These now pass AA on every surface
> they appear on while staying visibly dimmer than `--text2`, preserving the tier hierarchy. **This is
> a code change to apply — see §1.5.**

### 1.3 Brand & functional colors

| Role | Token | Dark | Light | Rule |
|---|---|---|---|---|
| **Identity** | `--accent` / `--rose` | `#FF0A78` | `#FF0A78` | **The ONLY identity color.** Logo, primary CTA, active nav, large accent. Never decorative, never small body text (see §1.4). |
| Brand soft | `--rose-soft` | `#FF4D92` | — | Secondary magenta |
| **Success** | `--green` / `--up` | `#34D399` | `#059669` | Gains / upward only |
| **Danger** | `--red` | `#F87171` | `#DC2626` | Risk / negative only |
| **Caution** | `--gold` | `#FBBF24` | `#D97706` | Score highlights / watch only |
| **Live** | `--cyan` | `#38BDF8` | `#0284C7` | Live data, charts, price ticks only |
| Signal: align | `--violet` | `#A78BFA` | `#7C3AED` | "Signals align" |
| Signal: mixed | `--gold-agree` | `#FBBF24` | `#D97706` | "Mixed" |
| Signal: unclear | `--slate` | `#9B9BAE` | `#6B6B7E` | "Unclear" |

**Usage rule — BASE vs DIM:** use the **base** token for text/icons/borders; use the matching
**`-dim`** token (≈0.08–0.14 alpha) for background surfaces/badges. Badges = `background:var(--x-dim);
color:var(--x)` at full opacity. No solid color fills except critical alerts.

### 1.4 Measured contrast (WCAG AA = 4.5:1 body, 3:1 large) — [AS-BUILT after §1.5 fix]

| Element | Dark | Light | Verdict |
|---|---|---|---|
| `--text` on card | 17.0 | 18.0 | ✅ AAA |
| `--text2` on card | 6.35 | 6.34 | ✅ AA |
| `--text3` on card | 4.99 | 4.98 | ✅ AA |
| `--text3` on `--bg3` | 4.62 | 4.57 | ✅ AA |
| Green/Red/Gold/Cyan on dark | 6.7–11.2 | — | ✅ AA |
| **`--accent` magenta as text** | 4.95 (dark) | **3.77 (light)** | ⚠ **Large-text/fill only** |

> **MAGENTA RULE (binding):** `#FF0A78` is a **fill, accent, icon, and large-text** color. It passes
> AA for buttons (white text on magenta fill), large headings, and accents. It **fails AA as small body
> text on white (3.77)** — never use magenta for small paragraph text on light backgrounds.

### 1.5 CONTRAST FIX — code change to apply

In `index.html` `:root` (dark), change `--text3:#5C5C70` → `--text3:#82829A`.
In `[data-mode="light"]`, change `--text3:#9A9AAC` → `--text3:#6E6E82`.
Leave `--text` and `--text2` unchanged. Every `--text3` usage inherits automatically.

### 1.6 ⚠ NEEDS CONSOLIDATION / Platform notes
- `prompt_11` lists Magenta `#E2007A/#FF0A78` and bg `#0D0D0F`; brand skill lists bg `#111318` +
  Montserrat. **As-built wins:** Magenta `#FF0A78`, bg `#0B0B0D/#121217`. Reconcile those docs later.
- 🎯 [TARGET] Chart line colors are currently off-token (`#1a8a4a`, `#22aa55`, `#c0392b`, `#dd3333`) and
  do **not** match `--green`/`--red`, and are not theme-aware. Roadmap §9 Phase 2 tokenizes them.
- 🎯 [TARGET] Legacy off-token colors exist in chat/glossary/feature code (`rgba(0,212,255)` ×29,
  `#00c864`, `#ff4444`, `#ffd700`, etc.). Full Category-C audit is a later Phase-2 pass.

---

## 2. SPACING — 8px GRID

**The standard:** all margins, padding, gaps use `4 · 8 · 16 · 24 · 32 · 48`.

### 2.1 Verified effective spacing [AS-BUILT]

| Element | Padding | Margin / Gap |
|---|---|---|
| `.card` | `24px` | `margin-bottom:16px` |
| `.stat-card` | `16px` | — |
| `.ptable thead th` | `8px 16px` | — |
| `.ptable tbody td` | `12px 16px` | — |
| `.w-item` | `16px` | `margin-bottom:8px` |
| `.alert-item` | `16px` | `margin-bottom:8px; gap:8px` |
| `.s-card` | `16px` | — |
| `.grid-4` / `.grid-3` | — | `gap:16px; margin-bottom:16px` |
| `.section-hdr` | — | `margin-bottom:16px; gap:8px` |

🎯 [TARGET] Section margin between major blocks → `48px` (currently 16px). Roadmap §9 Phase 3.

### 2.2 Radius & layout tokens [AS-BUILT]

| Token | Value |
|---|---|
| `--radius-sm` / `--radius` / `--radius-lg` | `8px` / `12px` / `16px` (cards use lg) |
| `--sidebar-w` / `--topbar-h` | `56px` / `56px` |
| Main content max-width | `1400px` centered (`main{max-width:1400px;margin:0 auto;padding:20px}`) |

> **⚠ NEEDS CONSOLIDATION:** `.card` is defined **3×** (lines ~106, ~390 media query, ~661) — **line
> 661 wins** (`padding:24px; radius:--radius-lg`). `.stat-card` defined 2× — **line 678 wins**.
> `.ptable tbody td` padding's true winner is in the "STAGE 4 — Larger fonts" block (~line 6063).
> Visually correct, structurally redundant. **Always confirm the COMPUTED value in the inspector**
> before declaring a spacing edit done — editing a non-winning duplicate silently does nothing.
> Roadmap §9 Phase 1 consolidates to a single `.card` rule.
>
> **NEVER** put max-width/centering on `body` — it is a fixed `overflow:hidden` shell and would clip
> content. Narrow `main` instead. (`prompt_11` says 1200px; as-built is 1400px — decide deliberately.)

---

## 3. TYPOGRAPHY

### 3.1 Fonts [AS-BUILT]
| Role | Font (weights) | Source |
|---|---|---|
| Body / Arabic / UI | **Almarai** (300,400,700,800) | Google Fonts |
| Numbers / data / prices | **IBM Plex Mono** (400,500,600) | Google Fonts |
| Fallback | `sans-serif`, `-apple-system` | — |

Load: `family=Almarai:wght@300;400;700;800&family=IBM+Plex+Mono:wght@400;500;600`.
**Rule:** every price/percentage/ratio/score/ticker → IBM Plex Mono; all Arabic & UI → Almarai.

> **⚠ NEEDS CONSOLIDATION:** `prompt_11` says Aeonik (not loaded — aspirational). Brand skill says
> Montserrat + Noto (Creatomate/Instagram constraint — see §8). **As-built web = Almarai + IBM Plex
> Mono only.** If a display font for the website hero is wanted, decide deliberately and add here.

### 3.2 The 3 tiers [AS-BUILT]
| Tier | Use | Style |
|---|---|---|
| **Tier 1 — Titles** | Section titles | bold 700–800, `letter-spacing:-0.01em` to `-0.02em`, `--text`. (`.section-title` = 800/-0.01em.) |
| **Tier 2 — Body/Data** | Content, table cells | regular/medium, `--text`; numbers in IBM Plex Mono. |
| **Tier 3 — Labels/Captions** | Headers, metadata | `font-size:11px; uppercase; letter-spacing:0.05em; color:--text3; weight 600–700`. |

No more than 3 weights/sizes competing in one section.

---

## 4. MOTION & INTERACTION

### 4.1 [AS-BUILT]
| Item | Value | Where |
|---|---|---|
| Glide transition | `background-color 0.25s ease, border-color 0.25s ease` | `.card`, `.stat-card`, `.s-card`, `.mob-nav-btn` |
| Price-tick flash | `@keyframes priceFlashUp/Dn` (~0.22α → transparent), `1.2s ease-out` via `.flash-up/.flash-dn` | Holdings rows on live price change |
| Font smoothing | `-webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale` | `body` |

**Rules:** motion serves understanding only. **No layout-shifting hover** (no `translateY` lift on
section containers — jank + mobile conflict). **No `backdrop-filter` blur** on flat backgrounds
(GPU cost, no visible effect). Price/trend colors: use semantic color only on active values; always
include `+/-` or arrows.

### 4.2 🎯 [TARGET] — not yet built
- Active/tap feedback: `transform: scale(0.98)` on press (tactile).
- Count-up numbers on load; staggered card fade-in on tab open.
- **Skeleton loaders** (pulse animation) replacing spinners — Roadmap §9 Phase 5.
- Empty states: "No data yet" + reason + what to expect.

---

## 5. DATA VISUALIZATION

### 5.1 [AS-BUILT]
- Charts: axis/grid colors are theme-aware via `getChartThemeColors()` (dark → light-gray-on-dark,
  light → dark-gray) so they stay visible in both modes.
- Trend line weight `1.5px`; modal chart `2.5px`; cost/reference line dashed.

### 5.2 🎯 [TARGET]
- Standardize line weights: **2px** trend, **1px** reference.
- Grid lines = `var(--border)`; tooltips = `background:var(--bg3); border:var(--border)`; tooltip
  text = Tier-3 style.
- Replace off-token chart line colors with `--green`/`--red` (theme-aware) — Roadmap §9 Phase 2.

---

## 6. ACCESSIBILITY & LOCALIZATION

### 6.1 Contrast [AS-BUILT after §1.5 fix]
All text tiers meet **WCAG AA (4.5:1)** on their real surfaces — see §1.4 measured table.
Magenta is large-text/fill only (§1.4 rule).

### 6.2 RTL / Arabic [AS-BUILT]
- `setLang()` / `toggleMode()` set `data-mode`, `dir`, `lang` on `<html>`.
- **Stock Lookup panel renders Arabic ALWAYS, regardless of page language** (`isAr=true` in
  `lookupStock`); lookup card force-RTL in CSS (`#lookup-data-card{direction:rtl}`).
- Native RTL layouts (not mirrored). Latin numerals/tickers stay LTR inside RTL via browser bidi.
- Tickers in English; percentages `+6.20%` / `-3.51%` (2 decimals).

### 6.3 🎯 [TARGET]
- **THEISI Financial Translation Dictionary** — a doc of canonical Arabic terms (Profit/Loss, Asset
  Allocation, Liquidity, etc.) for consistency across dashboard/Telegram/Instagram. **Does not exist
  yet** — to be created. Until then, financial Arabic terms are ad-hoc.

---

## 7. COMPONENT REFERENCE [AS-BUILT]
- **Card:** `bg:var(--bg2); border:1px var(--border); radius:var(--radius-lg)(16px); padding:24px; margin-bottom:16px` + glide.
- **Stat card:** `padding:16px`; top accent bar via `::before` (`.blue/.green/.orange/.gold`).
- **Table:** header `8px 16px` Tier-3; body `12px 16px`; row hover `bg:var(--bg3)`.
- **Badge (`.sym-badge`):** `bg:var(--bg3); border:1px; radius:5px; IBM Plex Mono; color:var(--accent)`.
- **Inputs:** `bg:var(--bg3); border:1px; radius:9px`; IBM Plex Mono (LTR) / Almarai (RTL select).

---

## 8. PLATFORM VARIATIONS (legitimately different — not drift)
| Surface | Font | BG | Why |
|---|---|---|---|
| Dashboard / Website | Almarai + IBM Plex Mono | `#0B0B0D`/`#121217` | As-built canonical |
| Instagram / Video (Creatomate, Kling) | Montserrat + Noto Sans Arabic | `#111318` | Tool constraint (brand skill) |

Constant across ALL surfaces: Magenta `#FF0A78`, tagline (افهم ما يهم), core principle
(gather → connect → they see → they decide).

---

## 9. MIGRATION ROADMAP (As-Built → Target State)
Work **one phase at a time, verified + committed before the next.** As each lands, move its items
from 🎯 [TARGET] to [AS-BUILT] and bump the version.

| Phase | Goal | Risk | Status |
|---|---|---|---|
| **1 — Consolidation** | Eliminate triple `.card` (and dup `.stat-card`, `.ptable td` override) → one rule each | High (cascade) | Not started |
| **2 — Semantic color audit** | Tokenize chart line colors to `--green`/`--red` (theme-aware); sweep legacy off-token colors (cyan ×29, `#00c864`, etc.) | Medium | Not started |
| **3 — Grid lock** | Section margins → 48px; audit stragglers to 8px | Low | Mostly done |
| **4 — Motion** | Add `scale(0.98)` active feedback; count-up; staggered fade-in | Low–Med | Glide done |
| **5 — Loading/empty** | Skeleton loaders replace spinners; empty-state messages | Med (per-component) | Not started |
| **6 — A11y/i18n** | Apply §1.5 contrast fix ✅ ready; create Financial Translation Dictionary | Low | Contrast fix pending apply |

---

## 10. PROTOCOL — "ADD-A-TOKEN" RULE (prevents future drift)
1. **Check** — can an existing token do the job? Use it.
2. **Propose** — if not, define the new token in §1 of *this* file first.
3. **Verify** — update this document **before** the code is merged.
4. **Tag** — mark new design behaviors [AS-BUILT] only once shipped + confirmed in the browser; until
   then they are 🎯 [TARGET].

---

## 11. CHANGE LOG
- **v2.0 · 2026-06-08** — Restructured into [AS-BUILT] vs 🎯 [TARGET] with migration roadmap. Added:
  validated-palette review with **measured WCAG contrast** (§1.4), the **`--text3` contrast fix**
  (§1.5, ready to apply), the **magenta large-text/fill-only rule**, BASE-vs-DIM usage rule, data-viz
  section (§5), accessibility/localization (§6), and the Add-a-Token governance protocol (§10).
  Carried all v1.0 as-built tokens, spacing grid, fonts, motion, RTL/always-Arabic-lookup, and the
  NEEDS-CONSOLIDATION flags (triple `.card`, etc.).
- **v1.0 · 2026-06-08** — First as-built extraction from production `index.html`.

## 12. HOW TO USE THIS DOC
1. Building anything visual? Pull values from §1–§7 here — and check the **[AS-BUILT]/🎯[TARGET]** tag
   so you don't assume a planned feature exists.
2. Conflict with another doc? **This wins for web/dashboard pixels;** philosophy wins for intent.
3. A value "won't take"? Suspect a duplicate (§2.2 ⚠) — confirm the **computed** value in the inspector.
4. Adding a color/token? Follow §10. Update this doc *before* merging code.
5. Finished a roadmap phase (§9)? Move its items to [AS-BUILT], update §11, bump version.
