# Decisions

Product/engineering decisions that later work must not silently reverse. Newest first. Each entry: the decision, the date, what it supersedes, and where it is enforced.

## 2026-09-28 — 44px minimum hit area for every tappable element (hit areas only; visuals unchanged)

**Decision.** Mobile (Capacitor) is the primary surface. Every interactive element must have an *effective* tap area of at least 44×44 CSS px. Visual sizes stay exactly as designed — the expansion is an invisible `::after` pseudo-element (`hit-44` utility in `src/styles/tailwind.css`, also applied to the legacy `.btn`/`.chip` classes). No layout, copy, token or paint change is allowed to come from this rule.

**Supersedes.** The 2026-09-08 design-QA decision that sub-44px chips, steppers, remove buttons, checkboxes and text links were "locked prototype values" to leave alone. That decision still holds for *visual* sizes; it no longer holds for *hit areas*.

**Not covered (needs a product/design decision — see `e2e/touch-targets.allowlist.ts` for the full list with reasons).**
- Pairs of targets whose expanded areas would overlap (Edit/Delete announcement, stepper ±, wrapped venue-type chips, rota-grid chips + add buttons, SectionDetail Remove/Notify, etc.).
- Native `<input>`/`<select>`/`<textarea>` (a pseudo-element cannot apply; needs a min-height decision).
- RadialDock tabs and keystone (transform-scaled; the keystone already touches the focused tab).
- Floor-plan section pins at phone width (polygons 21–64px tall, neighbours overlap, and for short polygons the visible pin badge itself lies outside the tappable clipped shape) — needs a design call, not a mechanical fix.
- The RotaBuilder header overflows its card at 390px (Templates / Save as template cut off) — a responsive layout bug, reported.

**Enforced by.** `e2e/touch-targets.spec.ts` (real backend, 390×844 touch viewport, manager + staff sessions) with `e2e/touch-targets.allowlist.ts` as the only sanctioned exception list.

## 2026-09-28 — Back-navigation priority order (browser + Android hardware back)

**Decision.** "Back" always means, in this order:
1. close the topmost open sheet / modal / dialog / dropdown;
2. inside onboarding, go to the previous step (never leave the flow mid-way unless on step 1 — Welcome);
3. otherwise normal history back;
4. at a root tab with nothing to go back to: exit the app on Android (`App.exitApp()`), no-op in the browser.

**Mechanism.** One small module, `src/lib/backNavigation.ts` (handler stack + one history entry per open overlay via `useCloseOnBack`), `src/lib/nativeBack.ts` for the `@capacitor/app` `backButton` listener. Onboarding forward steps push history entries; the in-app Back control pops them. No new state library.

**Unverified.** iOS edge-swipe back: Capacitor iOS 8.5.2 never sets `WKWebView.allowsBackForwardNavigationGestures` (default `false`), so there is no system swipe-back in the shell; needs a real device/simulator check when Mac access exists. Android hardware back was not run on an emulator in the session that wrote this (no AVD in that environment) — manual test steps are in MEMORY.md.
