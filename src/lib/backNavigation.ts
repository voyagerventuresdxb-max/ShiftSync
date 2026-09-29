import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * One small mechanism for "back" — browser back, Android hardware back, and
 * (when it exists) any in-app back control — so it always does the expected
 * thing, in this priority order:
 *
 *   (i)   close the topmost open sheet / modal / dialog / dropdown
 *   (ii)  inside onboarding, go to the previous step (never leave the flow
 *         mid-way unless on step 1) — registered by OnboardingRoute
 *   (iii) otherwise normal history back
 *   (iv)  at a root tab with nothing to go back to: exit the app on Android
 *         (`App.exitApp()`), no-op in the browser — see nativeBack.ts
 *
 * No global state library: a module-level stack of handlers (registered in
 * mount order, so the most recently opened overlay is on top) plus one
 * react-router history entry per open overlay so that BROWSER back closes it
 * too. `handleBack()` is what the Android bridge calls; the browser path
 * needs no bridge because the sentinel history entry makes `popstate` do
 * the right thing by construction.
 */

type BackHandler = () => boolean;

const handlers: BackHandler[] = [];

/** Push a handler on the stack. Returns the unregister function. Topmost handler is consulted first. */
export function registerBackHandler(handler: BackHandler): () => void {
  handlers.push(handler);
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}

/** Runs the topmost handler that claims the back action. Returns false when nothing consumed it (caller falls through to history back / exit). */
export function handleBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i]!()) return true;
  }
  return false;
}

/** Number of registered handlers — exposed for tests and debugging only. */
export function backHandlerDepth(): number {
  return handlers.length;
}

/**
 * Registers `handler` on the back stack while `active` is true. `handler`
 * returning `false` means "not consumed, fall through" (the default, when it
 * returns nothing, is consumed).
 */
export function useBackHandler(active: boolean, handler: () => boolean | void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!active) return;
    return registerBackHandler(() => handlerRef.current() !== false);
  }, [active]);
}

/** Key under `location.state` holding the overlay depth (number of sentinel entries) of that history entry. */
export const OVERLAY_STATE_KEY = 'ssOverlayDepth';

function stateDepth(state: unknown): number {
  const depth = (state as Record<string, unknown> | null)?.[OVERLAY_STATE_KEY];
  return typeof depth === 'number' ? depth : 0;
}

/** The depth of the LIVE history entry (react-router stores `location.state` under `usr`). Falls back to the given rendered state. */
function liveDepth(fallback: unknown): number {
  const live = window.history.state as { usr?: unknown } | null;
  return live && typeof live === 'object' && 'usr' in live ? stateDepth(live.usr) : stateDepth(fallback);
}

interface OverlayEntry {
  depth: number;
  url: string;
  /** Set once a rendered location carrying this depth was observed — only then does a shallower location mean "history went back". */
  armed: boolean;
  poppedByHistory: boolean;
}

type Navigate = ReturnType<typeof useNavigate>;

/**
 * Module-level bookkeeping shared by every `useCloseOnBack` instance: one
 * history entry per open overlay, released one macrotask after the overlay
 * closes so that an overlay opening in the same tick (SectionDetail → Assign
 * staff → SectionPicker, a StrictMode effect re-run, a RotaBuilder sheet
 * switching kind) ADOPTS the entry instead of pop-then-push — which would
 * leave a transient "no sentinel" location and close the new overlay.
 */
let topDepth = 0;
let pendingRelease: { entry: OverlayEntry; timer: number; navigate: Navigate } | null = null;

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function flushPendingRelease(): void {
  if (!pendingRelease) return;
  const { entry, timer, navigate } = pendingRelease;
  window.clearTimeout(timer);
  pendingRelease = null;
  finishRelease(entry, navigate);
}

function finishRelease(entry: OverlayEntry, navigate: Navigate): void {
  const onTop = currentUrl() === entry.url && liveDepth(null) === entry.depth;
  if (onTop) {
    topDepth = entry.depth - 1;
    navigate(-1);
  } else if (currentUrl() !== entry.url) {
    // The route changed underneath the overlay (a link inside it navigated
    // away): the sentinel is history now, leave it alone.
    topDepth = 0;
  }
}

function acquireOverlay(navigate: Navigate, location: ReturnType<typeof useLocation>): OverlayEntry {
  if (pendingRelease && pendingRelease.entry.url === `${location.pathname}${location.search}${location.hash}`) {
    const adopted = pendingRelease.entry;
    window.clearTimeout(pendingRelease.timer);
    pendingRelease = null;
    return { depth: adopted.depth, url: adopted.url, armed: adopted.armed, poppedByHistory: false };
  }
  flushPendingRelease();
  const url = `${location.pathname}${location.search}${location.hash}`;
  const depth = Math.max(topDepth, liveDepth(location.state)) + 1;
  topDepth = depth;
  navigate(url, { state: { ...((location.state as Record<string, unknown> | null) ?? {}), [OVERLAY_STATE_KEY]: depth } });
  return { depth, url, armed: false, poppedByHistory: false };
}

function releaseOverlay(entry: OverlayEntry, navigate: Navigate): void {
  if (entry.poppedByHistory) {
    topDepth = Math.min(topDepth, entry.depth - 1);
    return;
  }
  flushPendingRelease();
  pendingRelease = {
    entry,
    navigate,
    timer: window.setTimeout(() => {
      pendingRelease = null;
      finishRelease(entry, navigate);
    }, 0),
  };
}

/**
 * Makes an overlay (sheet, modal, dialog, dropdown) close on back.
 *
 * While `active`:
 *  - one history entry is pushed for the overlay (same URL, `location.state`
 *    carries the overlay depth), so browser back pops it → `onClose()` runs;
 *  - a back handler is registered, so Android hardware back → `onClose()`.
 *
 * When the overlay closes any other way (its own Close button, backdrop tap,
 * Escape…) the sentinel entry is popped again so history doesn't accumulate
 * a dead entry. If the overlay unmounts because the route itself changed
 * (a link inside it navigated away), the sentinel is left alone — popping
 * it would undo that navigation.
 *
 * Call it inside the overlay component with `active = true` (mounted means
 * open), or in the parent that owns the `open` state.
 */
export function useCloseOnBack(active: boolean, onClose: () => void): void {
  const navigate = useNavigate();
  const location = useLocation();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const locationRef = useRef(location);
  locationRef.current = location;
  const entryRef = useRef<OverlayEntry | null>(null);

  // Push (or adopt) the sentinel + register the handler while active.
  useEffect(() => {
    if (!active) return;
    const entry = acquireOverlay(navigate, locationRef.current);
    entryRef.current = entry;
    const unregister = registerBackHandler(() => {
      onCloseRef.current();
      return true;
    });
    return () => {
      unregister();
      entryRef.current = null;
      releaseOverlay(entry, navigate);
    };
    // navigate is stable; the location is read through the ref at acquire time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // History moved (browser back, hardware back routed through history): once
  // our depth has been seen on a rendered location, a shallower one means
  // the entry was popped and the overlay must close.
  useEffect(() => {
    const entry = entryRef.current;
    if (!active || !entry) return;
    if (stateDepth(location.state) >= entry.depth) {
      entry.armed = true;
      return;
    }
    if (!entry.armed) return;
    entry.poppedByHistory = true;
    onCloseRef.current();
  }, [location, active]);
}
