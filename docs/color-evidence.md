# Colour evidence: onboarding vs the rest of the app

**Question tested:** onboarding looks black and gold; the screens after it look bluish. Is that
true, how much, and where? The answer decides which palette the whole app should use.

**Short answer:** yes, on both counts, and the blue cast was systematic rather than local.
Onboarding is one consistent warm black-and-gold palette. Every screen after it used neutrals
tinted blue-violet (OKLCH hue about 285) and a gold about 60% more saturated than onboarding's.
Six token values caused almost all of it, and they are used on every screen. Onboarding is the
reference; the whole app now uses its palette.

## Method

- The real app (Vite dev build) in Playwright with a mocked API, so no backend and no real data
  (invented names only). 79 screens: the 8 onboarding states, sign-in and join, home, scheduling,
  shift editor, floor plan, people, profile, my shifts, kiosk, open dialogs, sheets and the
  notification popover, the voice sheet in all 25 states, offline banners, and empty and error
  variants.
- Captured at 390 px (Chromium; WebKit spot-check), dark colour scheme, reduced motion, device
  pixel ratio 2. Also at 360 px in both engines, plus 1280 px for the manager screens.
- **Computed styles:** for every visible element, the background, border, text and SVG colour as
  the browser resolves it, composited over what is behind it.
- **Pixel sampling:** every screenshot pixel converted to OKLCH (lightness, chroma, hue), then
  bucketed:
  - dark neutrals: lightness under 0.40, chroma under 0.05;
  - light neutrals;
  - gold: chroma 0.05 or more, hue 45–110;
  - off-palette: other chromatic hues.
- For each bucket: the chroma-weighted mean hue, the mean chroma, and the share of dark-neutral
  pixels whose hue is blue-violet (180–320). The latter is listed as "blue-shifted".
- Tokens: read from the stylesheets and converted the same way.

Harness: an untracked folder in the working tree (not part of this change). Screenshots: the run's
artifact folder (`run18-screens/before`, `after`, `evidence`).

## Verdict on each part of the claim

| Part | Verdict | Numbers (before) |
|---|---|---|
| Onboarding is one consistent black-and-gold palette | **True** | Dark pixels: hue 72–78 (mean 74), chroma 0.009, **0% blue-shifted**. Gold: hue 80, chroma 0.065 (token `#c9a66b`: 0.087). Every onboarding token sits at hue 67–93. |
| Small exceptions inside onboarding | minor | Error red `#e5484d` (chroma 0.19). The review step borrowed the app's green tick `#2e9e5b` and amber warning `#d9a53c`. The page canvas behind the wizard was the app's `#0f0f12`, visible only when overscrolling. |
| The rest of the app is blue-shifted | **True, everywhere** | 71 screens. Dark pixels: hue 280–322 (mean 289), **90% blue-shifted** (max 100%). Chroma 0.011: the same small tint strength as onboarding's warmth, pointed the opposite way (about 145° apart). That is why it reads clearly blue next to onboarding, although each value is close to grey. |
| Neutrals (page, cards, sheets) | blue | Page `#0f0f12` (hue 286, chroma 0.006); cards `#1a1a22`; raised/popover `#1e1e28` (hue 285, chroma 0.016–0.019). |
| Borders and inputs | the bluest | `#2a2a36`, `#3a3a4a` (hue 285, chroma 0.022–0.028). |
| Text | cold | Body `#e0e0e0`: pure grey, chroma 0, against onboarding's bone `#efeae0`. Muted `#9ca3af`: blue-grey (hue 261, chroma 0.019). |
| Gold | same hue, too saturated | `#e5a93c`: hue 78, chroma 0.14 against `#c9a66b`, chroma 0.087. Measured gold pixels: chroma 0.115 in-app against 0.065 in onboarding. It reads brassier and more orange; it is not blue. |
| Blue accents | small area, visible | "Signal" `#4fb8e0` (info ticks, the anonymous-feedback card) and the roster grid's service chip `#8ab8e5`/`#24303a`. Green success `#2e9e5b`. 0.03% of pixels on average. |
| Canvas / floor plan | no canvas floor plan | The floor plan is the venue's uploaded image with HTML pins; its frame used the blue surface. The only canvas is the voice orb, which already read the gold token. |
| Native shell | cool, white and blue | theme-color, manifest and home-screen icons `#0f0f12`. Android splash: the white Capacitor placeholder with a blue logo. Android window background: theme default (white in light mode). Launcher icon: the Capacitor placeholder. |

**Decision:** onboarding is internally consistent and clearly warm black and gold, so it is the
reference. The blue does not come from a few places. It comes from the shared tokens, so
changing those tokens moves every screen.

## Token definitions on each side (before)

**Onboarding** (`.ob-root` in `onboarding.css` plus inline literals in the wizard's screens).
The shared roster review re-mapped the app tokens to these for its own subtree.

| Name | Value | OKLCH (L C H) |
|---|---|---|
| void / obsidian / ink / ink-2 / ink-hi | `#050403` `#0a0908` `#0d0b09` `#14110d` `#1e1913` | 10.8–21.7%, 0.003–0.014, 68–75 |
| gradient stops (inline) | `#070605` `#0c0a08` `#0f0d0a` `#100d0a` `#12100d` | 12.3–17.4%, 0.004–0.008, 67–78 |
| champagne / champagne-hi / bronze | `#c9a66b` `#efd9a8` `#8b7550` | 74.3% 0.087 80 · 89.2% 0.068 87 · 57.4% 0.059 80 |
| bone / stone / dim / dim-2 | `#efeae0` `#9a9184` `#6f675b` `#55514a` | 93.8% 0.014 85 · 66.1% 0.022 77 · 51.8% 0.021 78 · 43.7% 0.012 82 |
| shadow tint (inline) | `rgb(60,40,20)` with alpha | 29.6% 0.044 65 |
| error (inline) | `#e5484d` | 62.6% 0.193 23 |

**In-app** (`global.css` `:root` plus Tailwind `@theme`; components used these through
953 token classes in 55 files)

| Token | Value | OKLCH (L C H) |
|---|---|---|
| `--bg` | `#0f0f12` | 17.0% 0.006 286 |
| `--surface` / `--surface-2` | `#1a1a22` / `#1e1e28` | 22.1% 0.016 285 / 24.0% 0.019 285 |
| `--border` / border-strong, input | `#2a2a36` / `#3a3a4a` | 29.0% 0.022 285 / 35.5% 0.028 285 |
| `--text` / `--text-secondary` | `#e0e0e0` / `#9ca3af` | 90.7% 0 — / 71.4% 0.019 261 |
| `--accent` / warning | `#e5a93c` / `#d9a53c` | 77.3% 0.140 78 / 75.2% 0.133 81 |
| `--danger` / `--success` | `#e5484d` / `#2e9e5b` | 62.6% 0.193 23 / 62.1% 0.142 153 |
| signal / on-signal | `#4fb8e0` / `#0b2530` | 73.7% 0.112 227 / 25.0% 0.038 229 |
| on gold | `#17130a` | 18.9% 0.018 87 |

## The token set now (`src/styles/tokens.css`)

The onboarding primitives keep their names and exact values. These semantic tokens are what the
screens use. Reference ranges, enforced by `scripts/palette.mjs`:

| Group | Hue | Chroma |
|---|---|---|
| neutrals | 60–95 | ≤ 0.03 |
| gold | 74–92 | 0.05–0.10 |
| danger | 20–40 | ≤ 0.16 |
| success | 115–150 | ≤ 0.09 |
| warning | 55–75 | ≤ 0.12 |

No token may be blue or purple (hue 180–330 with chroma 0.01 or more).

| Token | Value | OKLCH |
|---|---|---|
| `--bg` (surface 0) | ink `#0d0b09` | 15.1% 0.005 68 |
| `--surface` (1) | ink-2 `#14110d` | 18.0% 0.009 75 |
| `--surface-2` (2) | ink-hi `#1e1913` | 21.7% 0.014 72 |
| `--surface-3` (3) | `#29231c` (derived, same family) | 26.1% 0.016 71 |
| `--border` / `--border-strong` | bone at 10% / 18% | hairlines that sit right on every surface |
| `--text` | bone `#efeae0` | 93.8% 0.014 85 |
| `--text-secondary` (also Tailwind's muted text) | stone `#9a9184` | 66.1% 0.022 77 |
| `--text-faint` (large or decorative text only) | dim `#6f675b` | 51.8% 0.021 78 |
| `--accent` / `-hover` / `-pressed` | `#c9a66b` / `#d9b37a` / `#ac8d58` | hue 77–80, chroma 0.080–0.087 |
| `--accent-subtle` | champagne at 12% | |
| `--accent-foreground` (text on gold) | `#100d0a` | 16.2% 0.008 67 |
| `--focus-ring` | champagne at 70% | |
| `--disabled-bg` / `--disabled-fg` | bone at 10% / stone | the wizard's disabled-button fill, with a legible label |
| `--danger` | clay red `#da6d5d` | 65.9% 0.140 30 |
| `--success` | sage `#92af83` | 72.0% 0.070 135 |
| `--warning` | ochre `#de9f66` | 75.1% 0.105 62 |
| `--info` (was blue "signal") | champagne-hi `#efd9a8` | 89.2% 0.068 87 |
| chips: bar / kitchen / service | gold `#efd9a8` on `#392f21` · sage `#92af83` on `#2f2e23` · terracotta `#c2896d` on `#382b21` | label hues 87 / 135 / 47 |

The roster grid's three department chips stay apart by hue: gold, sage and terracotta are at
least 40° apart, and none is blue or purple. The app has no colour-coded leave types today. The
floor plan's sections are told apart by their labels and by default/active/warning pin tones
(stone, gold, ochre), not by per-section colours.

## Contrast (WCAG 2.x, on every surface 0–3 unless noted; `scripts/palette-contrast.test.mjs`)

| Pair | Ratio |
|---|---|
| Body text | 12.96–16.39 |
| Secondary / muted text | 5.00–6.32 |
| Faint text (large or decorative only; page and card surfaces) | 3.13–3.52 |
| Gold text and icons: default / hover / pressed | 6.77–8.56 / 7.90–9.99 / 4.96–6.27 |
| Info text | 11.22–14.18 |
| Text on gold buttons: default / hover / pressed | 8.44 / 9.85 / 6.19 |
| Text on the red button | 5.84 |
| Focus ring against the surface | 4.07–4.65 |
| Enabled gold fill against disabled fill | 5.13–6.97 |
| Disabled label on its fill | 3.79–5.14 |
| Danger / success / warning text | 4.68–5.92 / 6.42–8.12 / 6.85–8.66 |
| Chip labels: gold / sage / terracotta | 9.46 / 5.67 / 4.62 |

Onboarding's own small labels in `dim`/`dim-2` (for example "STEP 2 OF 5", 10 px) measure
2.2–3.5 on its surfaces, below AA for small text. They are part of the reference design and were
left as they are; the app's tokens do not use them for text.

## What was not changed, and why

- **Onboarding's look:** its literals were replaced by token references that render the same
  (pixel diff against before: 0–0.02% of pixels moved by more than 2/255 on account, venue and
  roster). The intended exceptions are the error red, which moved to the restrained token, and
  the review step's green tick and amber warning, which moved to sage and ochre. The QR code and
  invite link differ only because the test server ran on another port, and the welcome sphere
  only by animation frame.
- **The onboarding sphere** (`LiquidSphere.tsx`) is allowlisted until the gold dot orb (#148)
  replaces it.
- **The QR code** keeps a white background, which scanners need.
- **The floor-plan image** is the venue's own upload and is shown as uploaded. In the
  measurements its pixels (a cool grey test image) account for the 17% "blue-shifted" share on
  the floor-plan screens after the change.
- **The Android launcher icon** is still the Capacitor placeholder, now on a white background. It
  needs the ShiftSync icon artwork, not a palette value.
- **iOS:** there is no iOS project yet. When it is created:
  - launch screen and WebView background `#0d0b09`;
  - a light status-bar style;
  - the same `backgroundColor` already set in `capacitor.config.ts`.
- **There is no light theme** and no `prefers-color-scheme` rules. Adding one is a product
  decision, not a palette fix.

## After the change (Step 6)

Every in-app token is now one of the reference values, so the screens converge on the
onboarding measurements:

- **Dark pixels:** in-app mean hue 72 against onboarding's 74. Blue-shifted share 1% (it was
  90%); the remainder is the floor-plan image.
- **Gold:** in-app chroma 0.076 against onboarding's 0.065 (it was 0.115). In-app gold also
  covers buttons and pins, so its larger filled areas read slightly richer.
- **Coverage:** 66 of 71 in-app screens fall inside hue 66–84 and chroma ≤ 0.013. The other 5
  sit at hue 63–64 and are explained:
  - three floor-plan screens, where the uploaded image dominates;
  - two error screens, where the clay-red error message pulls the dark-pixel hue warmer.

None of the 5 is blue.
- **Remaining "off-palette blue" pixels** average 0.02% (max 0.06%). They are the colour fringes
  of subpixel text antialiasing on small uppercase labels; no element uses a blue colour.

The tables below come from the same measurement runs.


**Before: pixel buckets per side (Chromium, 390 px, 79 screens)**

| Side | Screens | Dark-neutral hue (min–max, mean) | Dark-neutral chroma (mean, max) | Dark pixels blue-shifted | Gold hue (mean) | Gold chroma (mean, max) | Off-palette blue pixels |
|---|---|---|---|---|---|---|---|
| in-app | 71 | 280–322, 289 | 0.0110, 0.0155 | 90% (max 100%) | 79 | 0.115, 0.148 | 0.03% (max 0.36%) |
| onboarding | 8 | 72–78, 74 | 0.0092, 0.0127 | 0% (max 0%) | 80 | 0.065, 0.078 | 0.00% (max 0.00%) |

**After: pixel buckets per side (Chromium, 390 px, 79 screens)**

| Side | Screens | Dark-neutral hue (min–max, mean) | Dark-neutral chroma (mean, max) | Dark pixels blue-shifted | Gold hue (mean) | Gold chroma (mean, max) | Off-palette blue pixels |
|---|---|---|---|---|---|---|---|
| in-app | 71 | 63–80, 72 | 0.0085, 0.0121 | 1% (max 17%) | 79 | 0.076, 0.092 | 0.02% (max 0.06%) |
| onboarding | 8 | 72–78, 74 | 0.0093, 0.0128 | 0% (max 0%) | 80 | 0.065, 0.076 | 0.00% (max 0.00%) |

**Per screen (before → after): dark-neutral pixels (hue / chroma / share blue-shifted) and gold pixels (hue / chroma)**

| Screen | Group | Dark neutrals | Gold | Dark neutrals after | Gold after |
|---|---|---|---|---|---|
| onboarding-account | onboarding | 73 / 0.0081 / 0% | 80 / 0.074 | 73 / 0.0082 / 0% | 80 / 0.074 |
| onboarding-invite | onboarding | 72 / 0.0093 / 0% | 80 / 0.070 | 72 / 0.0093 / 0% | 80 / 0.070 |
| onboarding-invite-team | onboarding | 78 / 0.0092 / 0% | 80 / 0.052 | 78 / 0.0091 / 0% | 80 / 0.052 |
| onboarding-review | onboarding | 75 / 0.0085 / 0% | 80 / 0.078 | 75 / 0.0085 / 0% | 78 / 0.076 |
| onboarding-roster | onboarding | 75 / 0.0088 / 0% | 80 / 0.065 | 75 / 0.0088 / 0% | 80 / 0.065 |
| onboarding-roster-attached | onboarding | 74 / 0.0090 / 0% | 80 / 0.065 | 75 / 0.0091 / 0% | 80 / 0.065 |
| onboarding-venue | onboarding | 74 / 0.0083 / 0% | 80 / 0.071 | 74 / 0.0084 / 0% | 80 / 0.071 |
| onboarding-welcome | onboarding | 73 / 0.0127 / 0% | 82 / 0.045 | 73 / 0.0128 / 0% | 82 / 0.045 |
| announcement-compose | state | 292 / 0.0117 / 84% | 78 / 0.093 | 74 / 0.0101 / 0% | 80 / 0.064 |
| floor-plan-86 | app | 295 / 0.0115 / 78% | 79 / 0.104 | 72 / 0.0106 / 0% | 79 / 0.082 |
| floor-plan-assign | app | 289 / 0.0107 / 89% | 79 / 0.128 | 64 / 0.0087 / 17% | 79 / 0.082 |
| floor-plan-empty | state | 288 / 0.0124 / 89% | 78 / 0.130 | 72 / 0.0098 / 0% | 80 / 0.083 |
| floor-plan-error | state | 311 / 0.0106 / 73% | none | 63 / 0.0094 / 0% | none |
| floor-plan-picker | state | 287 / 0.0145 / 86% | 79 / 0.128 | 73 / 0.0103 / 0% | 80 / 0.082 |
| floor-plan-section-detail | state | 287 / 0.0102 / 86% | 79 / 0.086 | 76 / 0.0070 / 0% | 80 / 0.058 |
| floor-plan-section-dialog | state | 287 / 0.0109 / 87% | 79 / 0.129 | 75 / 0.0083 / 0% | 80 / 0.075 |
| floor-plan-sections | app | 288 / 0.0131 / 91% | 78 / 0.098 | 67 / 0.0101 / 17% | 80 / 0.066 |
| floor-plan-staff | app | 289 / 0.0098 / 89% | 79 / 0.106 | 63 / 0.0083 / 17% | 77 / 0.073 |
| home-empty | state | 288 / 0.0134 / 90% | 78 / 0.115 | 74 / 0.0098 / 0% | 80 / 0.075 |
| home-owner | app | 289 / 0.0129 / 91% | 78 / 0.124 | 74 / 0.0093 / 0% | 80 / 0.080 |
| home-staff | app | 288 / 0.0126 / 90% | 78 / 0.114 | 72 / 0.0094 / 0% | 80 / 0.075 |
| join-invite | auth | 288 / 0.0096 / 90% | 78 / 0.138 | 72 / 0.0076 / 0% | 80 / 0.087 |
| join-no-venue | auth | 289 / 0.0082 / 90% | none | 71 / 0.0069 / 0% | none |
| kiosk | app | 287 / 0.0121 / 92% | none | 72 / 0.0085 / 0% | none |
| kiosk-no-link | app | 289 / 0.0075 / 90% | none | 71 / 0.0066 / 0% | none |
| login | auth | 288 / 0.0109 / 90% | 78 / 0.138 | 73 / 0.0083 / 0% | 80 / 0.087 |
| login-code | auth | 288 / 0.0092 / 90% | 78 / 0.148 | 72 / 0.0075 / 0% | 80 / 0.092 |
| login-link | auth | 289 / 0.0084 / 90% | 78 / 0.138 | 71 / 0.0070 / 0% | 80 / 0.087 |
| login-session-ended | auth | 287 / 0.0119 / 89% | 78 / 0.138 | 73 / 0.0087 / 0% | 80 / 0.087 |
| my-shifts-empty | state | 288 / 0.0125 / 90% | 79 / 0.121 | 75 / 0.0089 / 0% | 80 / 0.078 |
| my-shifts-staff | app | 289 / 0.0128 / 89% | 79 / 0.116 | 73 / 0.0091 / 0% | 77 / 0.077 |
| notifications-open | state | 294 / 0.0109 / 72% | 79 / 0.100 | 75 / 0.0099 / 0% | 80 / 0.068 |
| offline-home | state | 291 / 0.0127 / 85% | 80 / 0.106 | 72 / 0.0094 / 0% | 80 / 0.076 |
| offline-my-shifts | state | 292 / 0.0129 / 85% | 80 / 0.106 | 72 / 0.0097 / 0% | 72 / 0.078 |
| people-empty | state | 288 / 0.0143 / 92% | 78 / 0.112 | 75 / 0.0103 / 0% | 80 / 0.076 |
| people-error | state | 308 / 0.0155 / 69% | 78 / 0.132 | 64 / 0.0121 / 0% | 80 / 0.084 |
| people-owner | app | 293 / 0.0135 / 78% | 79 / 0.108 | 75 / 0.0113 / 0% | 77 / 0.077 |
| people-staff | app | 288 / 0.0138 / 91% | 79 / 0.108 | 75 / 0.0094 / 0% | 80 / 0.072 |
| profile-delete-confirm | state | 289 / 0.0137 / 92% | 78 / 0.077 | 75 / 0.0096 / 0% | 80 / 0.058 |
| profile-owner | app | 287 / 0.0129 / 92% | none | 75 / 0.0090 / 0% | none |
| profile-staff | app | 288 / 0.0105 / 90% | none | 73 / 0.0079 / 0% | none |
| schedule-editor | app | 288 / 0.0110 / 89% | 78 / 0.136 | 73 / 0.0081 / 0% | 80 / 0.086 |
| schedule-editor-modal | state | 292 / 0.0100 / 90% | 79 / 0.124 | 80 / 0.0089 / 0% | 80 / 0.087 |
| scheduling-empty | state | 288 / 0.0127 / 90% | 79 / 0.131 | 74 / 0.0090 / 0% | 80 / 0.084 |
| scheduling-error | state | 288 / 0.0127 / 90% | 79 / 0.129 | 74 / 0.0091 / 0% | 79 / 0.084 |
| scheduling-owner | app | 288 / 0.0124 / 89% | 78 / 0.124 | 75 / 0.0091 / 0% | 80 / 0.079 |
| scheduling-owner-matrix | app | 294 / 0.0141 / 84% | 78 / 0.121 | 75 / 0.0108 / 0% | 80 / 0.078 |
| scheduling-staff | app | 288 / 0.0124 / 89% | 78 / 0.124 | 75 / 0.0091 / 0% | 80 / 0.079 |
| shoutout-compose | state | 298 / 0.0107 / 74% | 78 / 0.087 | 76 / 0.0105 / 0% | 80 / 0.059 |
| staff-welcome | app | 289 / 0.0096 / 90% | 78 / 0.136 | 72 / 0.0076 / 0% | 80 / 0.086 |
| toast-voice-done | state | 280 / 0.0124 / 90% | 79 / 0.114 | 78 / 0.0099 / 0% | 80 / 0.075 |
| voice-composer | voice | 286 / 0.0072 / 99% | 79 / 0.081 | 68 / 0.0059 / 0% | 80 / 0.054 |
| voice-confirm-live | voice | 285 / 0.0120 / 100% | 78 / 0.137 | 73 / 0.0079 / 0% | 80 / 0.086 |
| voice-consent | voice | 287 / 0.0101 / 93% | 78 / 0.138 | 78 / 0.0084 / 0% | 80 / 0.087 |
| voice-preview-almost-there | voice | 285 / 0.0108 / 100% | 78 / 0.138 | 72 / 0.0075 / 0% | 80 / 0.087 |
| voice-preview-answer | voice | 285 / 0.0116 / 100% | 78 / 0.102 | 72 / 0.0080 / 0% | 79 / 0.068 |
| voice-preview-confirm-assign | voice | 286 / 0.0114 / 99% | 78 / 0.134 | 73 / 0.0078 / 0% | 80 / 0.085 |
| voice-preview-confirm-cancel | voice | 293 / 0.0133 / 88% | 78 / 0.134 | 68 / 0.0092 / 0% | 80 / 0.085 |
| voice-preview-confirm-offline | voice | 289 / 0.0130 / 89% | 79 / 0.133 | 72 / 0.0099 / 0% | 79 / 0.084 |
| voice-preview-confirm-publish | voice | 291 / 0.0112 / 82% | 79 / 0.130 | 77 / 0.0099 / 0% | 80 / 0.083 |
| voice-preview-confirm-shift | voice | 286 / 0.0115 / 99% | 78 / 0.135 | 72 / 0.0078 / 0% | 80 / 0.085 |
| voice-preview-confirm-shoutout | voice | 286 / 0.0122 / 99% | 78 / 0.135 | 73 / 0.0080 / 0% | 80 / 0.085 |
| voice-preview-confirm-timeoff | voice | 286 / 0.0115 / 99% | 78 / 0.136 | 73 / 0.0079 / 0% | 80 / 0.086 |
| voice-preview-declined | voice | 286 / 0.0097 / 98% | 78 / 0.089 | 72 / 0.0072 / 0% | 80 / 0.064 |
| voice-preview-done-follow-up | voice | 289 / 0.0101 / 94% | 79 / 0.099 | 73 / 0.0078 / 0% | 80 / 0.066 |
| voice-preview-listening | voice | 286 / 0.0062 / 98% | 79 / 0.122 | 68 / 0.0056 / 0% | 80 / 0.079 |
| voice-preview-not-understood | voice | 285 / 0.0119 / 100% | 78 / 0.138 | 72 / 0.0079 / 0% | 80 / 0.087 |
| voice-preview-problem-mic | voice | 322 / 0.0097 / 76% | 79 / 0.079 | 64 / 0.0092 / 0% | 79 / 0.052 |
| voice-preview-problem-offline | voice | 291 / 0.0081 / 92% | 79 / 0.079 | 66 / 0.0070 / 0% | 79 / 0.052 |
| voice-preview-problem-timeout | voice | 294 / 0.0084 / 90% | 79 / 0.131 | 67 / 0.0074 / 0% | 78 / 0.084 |
| voice-preview-readings | voice | 285 / 0.0104 / 100% | 78 / 0.086 | 72 / 0.0073 / 0% | none |
| voice-preview-sending | voice | 286 / 0.0120 / 99% | 79 / 0.092 | 73 / 0.0080 / 0% | 79 / 0.060 |
| voice-preview-starting | voice | 288 / 0.0064 / 97% | 79 / 0.090 | 68 / 0.0058 / 0% | 80 / 0.061 |
| voice-preview-transcribing | voice | 287 / 0.0064 / 97% | 79 / 0.104 | 68 / 0.0057 / 0% | 80 / 0.070 |
| voice-preview-typing | voice | 286 / 0.0072 / 99% | 79 / 0.081 | 68 / 0.0059 / 0% | 80 / 0.054 |
| voice-preview-typing-sending | voice | 286 / 0.0069 / 99% | 79 / 0.082 | 69 / 0.0060 / 0% | 80 / 0.053 |
| voice-preview-understanding | voice | 287 / 0.0064 / 97% | 79 / 0.102 | 69 / 0.0058 / 0% | 80 / 0.069 |
| voice-preview-which-one | voice | 286 / 0.0104 / 99% | 78 / 0.086 | 72 / 0.0074 / 0% | 79 / 0.068 |
| voice-preview-which-one-chosen | voice | 286 / 0.0115 / 99% | 78 / 0.135 | 72 / 0.0077 / 0% | 80 / 0.085 |

**Computed styles: the dominant colour per role (hex, OKLCH L C H), before**

| Screen | Page (html/body) | Surface | Border | Text primary | Text secondary/muted | Gold text | Gold fill | Other chromatic |
|---|---|---|---|---|---|---|---|---|
| onboarding-account | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #efeae0 (93.8% 0.014 85) | #9ca3af (71.4% 0.019 261) | #8b7550 (57.4% 0.059 80) | #c9a66b (74.3% 0.087 80) | — |
| onboarding-invite | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #efeae0 (93.8% 0.014 85) | #9a9184 (66.1% 0.022 77) | #8b7550 (57.4% 0.059 80) | #c9a66b (74.3% 0.087 80) | — |
| onboarding-invite-team | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #171614 (20.2% 0.006 92) | #efeae0 (93.8% 0.014 85) | #9a9184 (66.1% 0.022 77) | #8b7550 (57.4% 0.059 80) | #c9a66b (74.3% 0.087 80) | — |
| onboarding-review | #0f0f12 | #14110d (18.0% 0.009 75) | #1c1c1a (22.5% 0.004 85) | #efeae0 (93.8% 0.014 85) | #97938b (66.3% 0.012 83) | #c9a66b (74.3% 0.087 80) | #c9a66b (74.3% 0.087 80) | #2e9e5b #1e492c |
| onboarding-roster | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #efeae0 (93.8% 0.014 85) | #9ca3af (71.4% 0.019 261) | #8b7550 (57.4% 0.059 80) | #c9a66b (74.3% 0.087 80) | — |
| onboarding-roster-attached | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #efeae0 (93.8% 0.014 85) | #9ca3af (71.4% 0.019 261) | #8b7550 (57.4% 0.059 80) | #c9a66b (74.3% 0.087 80) | — |
| onboarding-venue | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #1c1c1a (22.5% 0.004 85) | #efeae0 (93.8% 0.014 85) | #9a9184 (66.1% 0.022 77) | #8b7550 (57.4% 0.059 80) | #c9a66b (74.3% 0.087 80) | — |
| onboarding-welcome | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | — | — |
| announcement-compose | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #72582d (47.7% 0.068 79) | #305d73 #4fb8e0 |
| floor-plan-86 | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #2e9e5b #2e9e5b #2e4c34 |
| floor-plan-assign | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| floor-plan-empty | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| floor-plan-error | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | — | #e5484d #e5484d |
| floor-plan-picker | #0f0f12 | #1a1a22 (22.1% 0.016 285) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| floor-plan-section-detail | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #2e9e5b #2e9e5b |
| floor-plan-section-dialog | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| floor-plan-sections | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| floor-plan-staff | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| home-empty | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #305d73 #4fb8e0 |
| home-owner | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #2e9e5b #4fb8e0 #204233 |
| home-staff | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #305d73 #4fb8e0 |
| join-invite | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| join-no-venue | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | — | — |
| kiosk | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| kiosk-no-link | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | — | — |
| login | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| login-code | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| login-link | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| login-session-ended | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| my-shifts-empty | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| my-shifts-staff | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #e5484d #57282f |
| notifications-open | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #305d73 #4fb8e0 |
| offline-home | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #305d73 #4fb8e0 |
| offline-my-shifts | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #e5484d #57282f |
| people-empty | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| people-error | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #e5484d #e5484d |
| people-owner | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| people-staff | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| profile-delete-confirm | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| profile-owner | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| profile-staff | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| schedule-editor | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| schedule-editor-modal | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #e5484d #57282f |
| scheduling-empty | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| scheduling-error | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| scheduling-owner | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #8ab8e5 #4fb8e0 #54252a |
| scheduling-owner-matrix | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #8ab8e5 #e5484d #54252a |
| scheduling-staff | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #8ab8e5 #4fb8e0 #54252a |
| shoutout-compose | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #72582d (47.7% 0.068 79) | #305d73 #4fb8e0 |
| staff-welcome | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2c2c2f (29.5% 0.005 286) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| toast-voice-done | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #305d73 #4fb8e0 #2e9e5b |
| voice-composer | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #7a5c27 (49.5% 0.080 79) | #305d73 #4fb8e0 |
| voice-confirm-live | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #305d73 #4fb8e0 |
| voice-consent | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #e0e0e0 (90.7% 0.000 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #305d73 #4fb8e0 |
| voice-preview-almost-there | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| voice-preview-answer | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #8e8e90 (64.8% 0.003 —) | #e5a93c (77.3% 0.139 78) | #936f32 (56.6% 0.091 78) | — |
| voice-preview-confirm-assign | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| voice-preview-confirm-cancel | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | #e5484d #752e36 |
| voice-preview-confirm-offline | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| voice-preview-confirm-publish | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| voice-preview-confirm-shift | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| voice-preview-confirm-shoutout | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| voice-preview-confirm-timeoff | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| voice-preview-declined | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | — | — |
| voice-preview-done-follow-up | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | — | — |
| voice-preview-listening | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #1a1a20 (22.0% 0.013 285) | #e0e0e0 (90.7% 0.000 —) | #8c8c8d (64.0% 0.002 —) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| voice-preview-not-understood | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |
| voice-preview-problem-mic | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c5c5c5 (82.3% 0.001 —) | #8c8c8d (64.0% 0.002 —) | #493819 (35.0% 0.052 81) | #7a5c27 (49.5% 0.080 79) | — |
| voice-preview-problem-offline | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c5c5c5 (82.3% 0.001 —) | #8c8c8d (64.0% 0.002 —) | #493819 (35.0% 0.052 81) | #7a5c27 (49.5% 0.080 79) | — |
| voice-preview-problem-timeout | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #3a3a4a (35.5% 0.028 285) | #c5c5c5 (82.3% 0.001 —) | #8c8c8d (64.0% 0.002 —) | — | #e5a93c (77.3% 0.139 78) | — |
| voice-preview-readings | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | — | — |
| voice-preview-sending | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #9ca3af (71.4% 0.019 261) | #e5a93c (77.3% 0.139 78) | #947032 (56.8% 0.091 79) | — |
| voice-preview-starting | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #1a1a20 (22.0% 0.013 285) | #e0e0e0 (90.7% 0.000 —) | #8c8c8d (64.0% 0.002 —) | #e5a93c (77.3% 0.139 78) | — | — |
| voice-preview-transcribing | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #1a1a20 (22.0% 0.013 285) | #e0e0e0 (90.7% 0.000 —) | #8c8c8d (64.0% 0.002 —) | #e5a93c (77.3% 0.139 78) | #ba8a34 (66.5% 0.117 79) | — |
| voice-preview-typing | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c5c5c5 (82.3% 0.001 —) | #8c8c8d (64.0% 0.002 —) | #e5a93c (77.3% 0.139 78) | #7a5c27 (49.5% 0.080 79) | — |
| voice-preview-typing-sending | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #292934 (28.5% 0.020 285) | #e0e0e0 (90.7% 0.000 —) | #8c8c8d (64.0% 0.002 —) | #e5a93c (77.3% 0.139 78) | #7a5c27 (49.5% 0.080 79) | — |
| voice-preview-understanding | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #1a1a20 (22.0% 0.013 285) | #c5c5c5 (82.3% 0.001 —) | #8c8c8d (64.0% 0.002 —) | #e5a93c (77.3% 0.139 78) | #ba8a34 (66.5% 0.117 79) | — |
| voice-preview-which-one | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | — | — |
| voice-preview-which-one-chosen | #0f0f12 | #0f0f12 (17.0% 0.006 286) | #2a2a36 (29.0% 0.022 285) | #c6c6c7 (82.8% 0.001 —) | #909093 (65.5% 0.005 286) | #e5a93c (77.3% 0.139 78) | #e5a93c (77.3% 0.139 78) | — |

