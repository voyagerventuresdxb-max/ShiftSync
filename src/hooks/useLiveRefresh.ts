import { useCallback, useEffect, useRef } from 'react';

/**
 * Calls `onRefresh` when the window regains focus or the tab becomes visible
 * again. Switching back to a tab usually fires both, so they're debounced
 * into one call.
 */
export function useRefreshOnFocus(onRefresh: () => void, delayMs = 250): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(onRefresh, delayMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [onRefresh, delayMs]);
}

/**
 * Wraps a fetch so runs never overlap. A call made while one is in flight
 * isn't started alongside it; it's folded into a single re-run once the
 * current one settles, so a change made mid-fetch is still picked up.
 * Always runs the latest `run` passed in. `run` must handle its own errors.
 */
export function useSingleFlight(run: () => Promise<void>): () => void {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  const state = useRef({ busy: false, again: false });
  return useCallback(function trigger() {
    const s = state.current;
    if (s.busy) {
      s.again = true;
      return;
    }
    s.busy = true;
    void latest.current().finally(() => {
      s.busy = false;
      if (s.again) {
        s.again = false;
        trigger();
      }
    });
  }, []);
}
