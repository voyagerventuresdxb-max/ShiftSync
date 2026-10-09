# Colour audit

Every place the app took a colour from before the palette was unified, and how far each one sat
from the reference palette (the onboarding wizard, measured in [`color-evidence.md`](color-evidence.md)).
OKLCH is written as lightness, chroma and hue. "In range" means a warm neutral (hue 55–100,
chroma under 0.035) or champagne gold (hue 70–95, chroma 0.04–0.11).

Today there is one source: [`src/styles/tokens.css`](../src/styles/tokens.css). The build runs
`scripts/palette.mjs`, which fails on any colour written anywhere else (exceptions:
[`scripts/palette-allowlist.json`](../scripts/palette-allowlist.json)).

## Where colour came from

| Source | What it held | Against the reference |
|---|---|---|
| CSS variables, `src/styles/global.css` `:root` | page `#0f0f12`, surfaces `#1a1a22` / `#1e1e28`, border `#2a2a36`, text `#e0e0e0`, muted text `#9ca3af`, gold `#e5a93c`, red `#e5484d`, green `#2e9e5b` | The page, surfaces, border and muted text were all **blue-violet** (hue 261–286). Text was a cold neutral grey. Gold had the right hue but was **over-saturated** (chroma 0.14 vs 0.087). Red and green were saturated. |
| Tailwind theme, `src/styles/tailwind.css` `@theme` | aliases of the variables above, plus literals: strong border and input `#3a3a4a`, "signal" `#4fb8e0` / `#0b2530`, warning `#d9a53c`, white text on red, dark text on gold `#17130a`, white glass highlight, black shadows | The strong border/input and the **blue "signal"** were off-palette. Warning was over-saturated. |
| Tailwind token classes in components | 953 uses in 55 files (`bg-surface`, `text-muted-foreground`, `border-border`, `text-signal`, …) | They inherit the token values, so every in-app screen showed the blue-violet neutrals. No component used Tailwind's default palette (`blue-500` etc.); the one `bg-white` is the join-link QR code. |
| Roster grid shift chips, `global.css` | bar `#3a2f1f`/`#e5c98a`, kitchen `#2a2f24`/`#a8c98a`, service `#24303a`/`#8ab8e5` | Bar was in range. Kitchen was green and **service was blue**. |
| Onboarding, `onboarding.css` `.ob-root` + inline styles in the wizard's screens | about 200 literals: near-blacks `#050403`–`#1e1913`, champagne `#c9a66b`/`#efd9a8`, bronze `#8b7550`, bone/stone/dim text, warm brown shadow tint | All in range except the error red `#e5484d`. The shared roster review inside onboarding re-mapped the app tokens to this palette for its own subtree. |
| Components with literals | `InviteLinkActions.tsx` (onboarding-style buttons, red `#e5484d`), `RadialDock.tsx` (black shadow, white glass), `VoiceOrb.tsx` (fallback gold `#e5a93c` in canvas code) | Red and fallback gold were saturated. |
| Canvas | Voice orb: a 2D canvas that already read `--accent` at runtime. Onboarding sphere (`LiquidSphere.tsx`): CSS gradients in champagne and bronze, which the gold dot orb (#148) replaces. | In range. There is no Konva, three.js or ShaderGradient in the app. The floor plan is the venue's uploaded image with HTML pins, so it uses token classes only. |
| SVG | Onboarding illustrations (champagne, bronze, bone strokes and fills); icons use `currentColor`; the logo mark `public/shiftsync-mark.svg` | In range. The logo is artwork, not palette. |
| Motion (`motion`) | no colour animation | n/a |
| `html` / `body` | `body` painted `--bg`, `html` had no background | The page canvas was the blue-black `#0f0f12`, including behind onboarding and on overscroll. |
| `index.html` theme-color, web manifest, home-screen icons | `#0f0f12` | **Cool-tinted** (hue 286). |
| Capacitor config | no background colour | The WebView could paint white before the first frame. |
| Android shell | splash: the white Capacitor placeholder image with a **blue** logo; window background: theme default (white in light mode); launcher icon: Capacitor placeholder on white | **White and blue.** |
| iOS shell | no iOS project yet | n/a (see [`color-evidence.md`](color-evidence.md) for what to set when it is created) |
| Notifications, e-mail | push payloads carry text only; the server has no HTML e-mail templates; `public/sw.js` has no colours | n/a |
| Light theme | none; no `prefers-color-scheme` rules | n/a |

## Per file (before the change)

Values that deviate are in bold. Shadows in pure black and highlights in pure white have no hue.

### `src/styles/global.css` (27)

| Value | Uses | OKLCH | Against the reference |
|---|---|---|---|
| `#d9a441` | 4 | 75.1% 0.130 80 | **over-saturated gold** |
| `#1a1a22` | 2 | 22.1% 0.016 285 | **blue-violet** |
| `#0f0f12` | 1 | 17.0% 0.006 286 | **cool-tinted** |
| `#1e1e28` | 1 | 24.0% 0.019 285 | **blue-violet** |
| `#2a2a36` | 1 | 29.0% 0.022 285 | **blue-violet** |
| `#e0e0e0` | 1 | 90.7% 0.000 — | cold grey (no warmth) |
| `#9ca3af` | 1 | 71.4% 0.019 261 | **blue-violet** |
| `#e5a93c` | 1 | 77.3% 0.140 78 | **over-saturated gold** |
| `#e5484d` | 1 | 62.6% 0.193 23 | **saturated red** |
| `#2e9e5b` | 1 | 62.1% 0.142 153 | **green** |
| `#3a2f1f` / `#e5c98a` (bar chip) | 1 / 1 | 31.3% 0.031 77 / 84.5% 0.087 87 | in range |
| `#2a2f24` / `#a8c98a` (kitchen chip) | 1 / 1 | 29.7% 0.021 128 / 79.6% 0.092 131 | **green** |
| `#24303a` / `#8ab8e5` (service chip) | 1 / 1 | 30.3% 0.024 244 / 76.6% 0.081 248 | **blue** |
| `rgba(229,169,60,·)` | 2 | gold above | **over-saturated gold** |
| `rgba(229,72,77,0.08)` | 1 | red above | **saturated red** |
| `rgba(46,158,91,0.08)` | 1 | green above | **green** |
| `rgba(0,0,0,·)` / `rgba(255,255,255,0.02)` | 2 / 1 | — | achromatic shadow / highlight |

### `src/styles/tailwind.css` (11)

| Value | Uses | OKLCH | Against the reference |
|---|---|---|---|
| `#3a3a4a` (strong border, input) | 2 | 35.5% 0.028 285 | **blue-violet** |
| `#4fb8e0` (signal) | 1 | 73.7% 0.112 227 | **blue** |
| `#0b2530` (on signal) | 1 | 25.0% 0.038 229 | **blue** |
| `#d9a53c` (warning) | 1 | 75.2% 0.133 81 | **over-saturated gold** |
| `#17130a` (on gold) | 2 | 18.9% 0.018 87 | in range |
| `#ffffff` (on red) | 1 | 100% 0 — | achromatic |
| `oklch(1 0 0)` (glass highlight) | 2 | 100% 0 — | achromatic white over the surfaces |
| `rgb(0 0 0 / 0.75)` (shadow) | 1 | — | achromatic |

### Components

| File | Values | Against the reference |
|---|---|---|
| `src/components/InviteLinkActions.tsx` (8) | bone and champagne alphas, `#e5484d` ×2, `rgba(229,72,77,.5)` | **saturated red**; the rest in range |
| `src/components/shiftsync/RadialDock.tsx` (2) | `oklch(0 0 0 / 0.7)` shadow, `oklch(1 0 0)` highlight | achromatic |
| `src/components/shiftsync/VoiceOrb.tsx` (5) | `0xe5a93c` fallback; `rgb()`/`rgba()` built from `--accent` | fallback **over-saturated gold** |
| `src/components/InviteLinkPanel.tsx` (1) | `bg-white` behind the QR code | kept: a QR code needs a white quiet zone |

### Onboarding

| File | Literals | Out of range |
|---|---|---|
| `WelcomeScreen.tsx` | 85 | none (the warm brown shadow tint `rgba(60,40,20,·)`, chroma 0.044, is a shadow) |
| `InviteScreen.tsx` | 40 | `#e5484d` |
| `RosterScreen.tsx` | 22 | none |
| `onboarding.css` | 17 | none |
| `LiquidSphere.tsx` | 15 | none (replaced by #148) |
| `AccountScreen.tsx` | 13 | `#e5484d` |
| `VenueScreen.tsx` | 11 | `#e5484d` |
| `OnboardingScreenShell.tsx` | 6 | none |
| `ReviewScreen.tsx` | 1 | none |

### Native shell

| File | Value | Against the reference |
|---|---|---|
| `index.html` theme-color | `#0F0F12` | **cool-tinted** |
| `public/manifest.webmanifest` background and theme colour | `#0F0F12` ×2 | **cool-tinted** |
| `public/icons/*.png` | background `#0F0F12` | **cool-tinted** |
| `android/…/drawable*/splash.png` | white with a blue placeholder logo | **white and blue** |
| `android/…/values/ic_launcher_background.xml` | `#FFFFFF` (placeholder launcher icon) | white; unchanged, see the evidence doc |
