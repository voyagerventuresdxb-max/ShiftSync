# Decisions

Product/engineering decisions that later work must not silently reverse. Newest first. Each entry: the decision, the date, what it supersedes, and where it is enforced.

## 2026-09-28 — 44px minimum hit area for every tappable element (hit areas only; visuals unchanged)

**Decision.** Mobile (Capacitor) is the primary surface. Every interactive element must have an *effective* tap area of at least 44×44 CSS px. Visual sizes stay exactly as designed — the expansion is an invisible `::after` pseudo-element (`hit-44` utility in `src/styles/tailwind.css`, also applied to the legacy `.btn`/`.chip` classes). No layout, copy, token or paint change is allowed to come from this rule.

**Supersedes.** The 2026-09-08 design-QA decision that sub-44px chips, steppers, remove buttons, checkboxes and text links were "locked prototype values" to leave alone. That decision still holds for *visual* sizes; it no longer holds for *hit areas*.

**Not covered (needs a product/design decision — see `e2e/touch-targets.allowlist.ts` for the full list with reasons).**
- Pairs of targets whose expanded areas would overlap (Edit/Delete announcement, stepper ±, wrapped venue-type chips, rota-grid chips + add buttons, SectionDetail Remove/Notify, etc.).
- Native `<input>`/`<select>`/`<textarea>` (a pseudo-element cannot apply; needs a min-height decision).
- RadialDock tabs and keystone (transform-scaled; the keystone already touches the focused tab).
- Floor-plan section pins at phone width: pins (~57×44) overlap their neighbours in dense clusters at 1x; zoom/pan separates them (2026-09-29, see below). Sections are pin-only since 2026-09-29, so the old polygon-clipping half of this is gone.
- The RotaBuilder header overflows its card at 390px (Templates / Save as template cut off) — responsive layout bug, issue #45.

**Enforced by.** `e2e/touch-targets.spec.ts` (real backend, 390×844 touch viewport, manager + staff sessions) with `e2e/touch-targets.allowlist.ts` as the only sanctioned exception list.

## 2026-09-29 — Floor sections are pins, not drawn polygons

**Decision.** A floor section is a named pin at a point on the uploaded plan (photo or PDF). Managers no longer draw section boundaries. Managers and staff know their own floor, so a plan plus a pin at each section's approximate spot is enough. Drawing polygons added a Konva canvas, a multi-step drawing interaction and a real bug class (a pin taller than its short polygon was clipped by the polygon — see the pin entry below) with no product benefit.

**What changed.**
- `FloorSection.pinX/pinY` (fractions 0–1 of the plan) are the section's position.
- Setup: tap the plan to drop a pin (name, pax, note); drag a pin to move it; tap a pin, or its list row, to edit; arrow keys nudge a focused pin; Delete asks for a second confirm. This is the app's first confirm-before-destroy: every other delete is still immediate.
- The board and setup render the same `SectionPin` component.
- On the board the pin is both the tap target and the dnd-kit drop target. There's no longer a whole-section drop area, so in dense clusters you zoom in to separate pins before dropping.
- Zoom/pan is unchanged in behaviour. A pinch that starts on a draggable pin still zooms (the pinch wins over the pin drag).

**Migration.** `20260929180000_floor_section_pin` backfilled every existing section's pin with its polygon's vertex average, exactly where the pin already rendered, so nothing moved on screen. Sections with no polygon points got the plan centre, reported in a NOTICE.

**Deprecated, not dropped.** `FloorSection.polygon` stays in the DB (default `[]`), is never written by the app, and is never sent to clients (`omit`). This keeps the change revertible. Drop the column in a later cleanup once pin sections are confirmed in production.

**Dependencies.** `konva`, `react-konva` and `use-image` were removed (2026-09-30, confirmed unused) — no canvas library remains in the app.

**Dev-DB safeguard added alongside (2026-09-30).** While verifying this migration, a `prisma migrate diff --shadow-database-url "$DATABASE_URL"` run through `with-branch-schema.mjs` reset that branch's live dev schema (Prisma resets the shadow DB; inside the wrapper `$DATABASE_URL` is the live schema). The wrapper now refuses shadow URLs that aren't a disposable `shadow_*` schema or another database, and refuses `migrate reset`/`--force-reset` without `--confirm-reset=<schema>`. Use `npm run prisma:check-drift` for drift checks. See AGENTS.md §6.

**Enforced by.** `e2e/floor-plan-section-editor.spec.ts` (tap-to-drop at 1x and 2x, drag at 1x and 2x, pinch-on-pin, arrow-key nudge, rename, two-step delete — all checked in the DB) and `server/src/routes/floorPlan.test.ts` (pin validation; no response carries `polygon`).

## 2026-09-29 — Floor plan pinch-to-zoom + pan (Daily Assignment and Sections setup)

**Decision.** Both floor-plan views zoom from fit (1x, can't zoom out past the whole plan) to 3x. Two fingers pinch (and pan via the midpoint). Once zoomed, one finger pans from anywhere on the plan — movement under 8px is still a tap, so pins and sections still open SectionDetail, and the click ending a pan is swallowed. "Pan only from empty space" was rejected because polygons cover most of the plan once zoomed. Ctrl+wheel / trackpad pinch works on desktop. Reset comes from a visible bottom-corner button, plus double-tap on empty plan. At 1x one finger still scrolls the page (`touch-action: pan-y`); once zoomed the plan takes every touch. In the setup editor, a finger that starts on a pin drags the pin and never pans; a second finger turns it into a pinch. (Originally: one finger placed polygon points while drawing — superseded by pin-only sections.) No gesture library.

**Pins keep their on-screen size while zoomed** (each counter-scales by 1/zoom). Zooming them with the plan would scale the overlap too and fix nothing. So zoom spreads crowded pins apart; it doesn't enlarge them.

**Persistence: none — zoom resets on every visit.** It's per-mount React state. A zoomed view restored on return would hide the rest of the plan with no hint why.

**Coordinate system (for future work).** Plan space = the un-zoomed layout; section pins (`pinX/pinY`) are stored as 0–1 fractions of it. View = `translate(x, y) scale(s)`, origin top-left: `screen = viewportOrigin + (x, y) + plan * s`. Both views apply it as one CSS transform (`PlanZoomViewport`). Anything inside the zoom layer is measured through the transform by `getBoundingClientRect` — dnd-kit drop targets, and the editor's "plan fraction under the finger" (`(client − rect.left) / rect.width`) — so neither needs zoom maths. Anything drawn at a fixed on-screen size inside the layer divides by `s` (`SectionPin`). Draggable things inside the layer carry `data-plan-drag-handle`. Code: `src/components/FloorPlan/planZoom.tsx`. (The Konva editor this originally described is gone.)

**Enforced by.** `e2e/floor-plan-zoom.spec.ts` (clamps, pan, tap vs pan, reset, a chip drop at 2x checked in the DB), `e2e/floor-plan-section-editor.spec.ts` (a pin dropped or dragged at 2x saves the same plan point as at 1x; replaced the polygon-drawing spec), and `e2e/floor-plan-pins.spec.ts` (the Sec 6/7/8 pins overlap at 1x and don't at 2.5x).

## 2026-09-29 — Floor-plan pins: every rendered pin is painted, tappable, and inside the plan

**Superseded in part (same day):** sections became pin-only (entry above), so there is no polygon left to clip against. The outcome below is still enforced.

**Decision.** Correctness bug, not a design choice: a pin that renders must open its own section. The polygon `clip-path` now lives on an inner hit layer instead of the section's `role=button`, so a pin taller than its (short) polygon is no longer clipped; the pin itself is a tap surface above neighbouring polygons (what you see is what you tap); a layout-effect nudge keeps it inside the plan's clipping box. Pin visual size unchanged; no zoom/pan (scoped separately). Visible effect: pins that used to be partly or wholly cut off now render in full.

**Enforced by.** `e2e/floor-plan-pins.spec.ts` — all 8 Bar des Prés polygons at 390px: pin fully inside the plan, topmost at its centre, and a real touch tap at the pin centre and at its "Sec N" badge centre opens that section's SectionDetail.

## 2026-09-28 — Back-navigation priority order (browser + Android hardware back)

**Decision.** "Back" always means, in this order:
1. close the topmost open sheet / modal / dialog / dropdown;
2. inside onboarding, go to the previous step (never leave the flow mid-way unless on step 1 — Welcome);
3. otherwise normal history back;
4. at a root tab with nothing to go back to: exit the app on Android (`App.exitApp()`), no-op in the browser.

**Mechanism.** One small module, `src/lib/backNavigation.ts` (handler stack + one history entry per open overlay via `useCloseOnBack`), `src/lib/nativeBack.ts` for the `@capacitor/app` `backButton` listener. Onboarding forward steps push history entries; the in-app Back control pops them. No new state library.

**Unverified.** iOS edge-swipe back: Capacitor iOS 8.5.2 never sets `WKWebView.allowsBackForwardNavigationGestures` (default `false`), so there is no system swipe-back in the shell; needs a real device/simulator check when Mac access exists. Android hardware back was not run on an emulator in the session that wrote this (no AVD in that environment) — manual test steps are in MEMORY.md.
