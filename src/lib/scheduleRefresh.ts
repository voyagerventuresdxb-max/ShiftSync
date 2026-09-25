import { useEffect, useRef } from 'react';

/**
 * "Staff see edits without reload" for v0 — no websockets (golden-path v0,
 * 2026-09-25). Schedule views refetch when the person comes back to the app
 * (window focus / tab visible), when a push notification is opened (the
 * service worker posts NOTIFICATION_OPEN_MESSAGE, public/sw.js), or when an
 * in-app notification is opened (requestScheduleRefresh()).
 */
export const SCHEDULE_REFRESH_EVENT = 'shiftsync:schedule-refresh';
export const NOTIFICATION_OPEN_MESSAGE = 'shiftsync:notification-open';

/** Asks every mounted schedule view to refetch now (e.g. an in-app notification was opened). */
export function requestScheduleRefresh(): void {
  window.dispatchEvent(new Event(SCHEDULE_REFRESH_EVENT));
}

/**
 * Calls `refetch` on each of the triggers above. `focus` and
 * `visibilitychange` usually fire together, so calls within `minIntervalMs`
 * of the last one are dropped. `refetch` may change identity freely; the
 * listeners are attached once.
 */
export function useRefetchOnReturn(refetch: () => void, minIntervalMs = 1500): void {
  const latest = useRef(refetch);
  useEffect(() => {
    latest.current = refetch;
  }, [refetch]);

  useEffect(() => {
    let last = 0;
    const run = () => {
      const now = Date.now();
      if (now - last < minIntervalMs) return;
      last = now;
      latest.current();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    const onSwMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === NOTIFICATION_OPEN_MESSAGE) run();
    };
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(SCHEDULE_REFRESH_EVENT, run);
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => {
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(SCHEDULE_REFRESH_EVENT, run);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    };
  }, [minIntervalMs]);
}
