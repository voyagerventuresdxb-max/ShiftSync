import { useEffect, useState } from 'react';
import { useIdentity } from './IdentityContext';
import { fetchMyShifts, ApiError, type MyShiftEntry } from '../api/myShifts';
import { onRosterChanged } from '../api/weeks';
import { isNetworkFailure, loadOffline, saveOffline } from '../lib/offlineCache';

/** "Mon 5 Oct" from a YYYY-MM-DD venue calendar day — pure calendar math, no timezone conversion. */
export function formatShiftDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

interface MyShiftsData {
  pendingApproval: boolean;
  shifts: MyShiftEntry[];
}

/**
 * The signed-in person's upcoming shifts (My Shifts and the Home next-shift
 * card). Live data is kept as this person's offline copy; when a fetch fails
 * for lack of network, that copy is shown instead with `offlineSince` set to
 * when it was saved, so the screen can say so. Refetches when the device
 * comes back online, on window focus and on the roster-changed signal; a
 * refetch never flips the screen back to "Loading…". A 401 signs out, as
 * before.
 */
export function useMyShifts(): MyShiftsData & { loading: boolean; error: string | null; offlineSince: string | null } {
  const { session, logout } = useIdentity();
  const [data, setData] = useState<MyShiftsData>({ pendingApproval: false, shifts: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Refetch when the device comes back online, when the window regains focus
  // (another device may have published), and when any rota surface in this
  // tab changes the roster (a publish, an approval — Design board E).
  useEffect(() => {
    const reload = () => setReloadTick((n) => n + 1);
    const onFocus = () => {
      if (document.visibilityState === 'visible') reload();
    };
    window.addEventListener('online', reload);
    window.addEventListener('focus', onFocus);
    const offRoster = onRosterChanged(reload);
    return () => {
      window.removeEventListener('online', reload);
      window.removeEventListener('focus', onFocus);
      offRoster();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const userId = session.user.id;
    fetchMyShifts(session.token)
      .then((live) => {
        if (cancelled) return;
        setData(live);
        setError(null);
        setOfflineSince(null);
        saveOffline(userId, 'myShifts', live);
      })
      .catch((err) => {
        if (cancelled) return;
        // A 401 means the stored token is expired or was revoked. Clearing it
        // drops us into the not-signed-in state, which offers a real way back
        // in — otherwise the user is stuck staring at an error with a dead
        // session they have no way to discard.
        if (err instanceof ApiError && err.status === 401) {
          logout();
          return;
        }
        const cached = isNetworkFailure(err) ? loadOffline<MyShiftsData>(userId, 'myShifts') : null;
        if (cached) {
          setData(cached.data);
          setOfflineSince(cached.savedAt);
          setError(null);
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Could not load your shifts.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `logout` is stable for this provider's lifetime; re-running on it would
    // re-fetch pointlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, reloadTick]);

  return { ...data, loading, error, offlineSince };
}
