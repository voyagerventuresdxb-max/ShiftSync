/**
 * A read-only, per-person copy of the schedule the person last saw, so My
 * Shifts, the Home next-shift card and a staff member's published rota week
 * still show something useful when the network drops. Not a service worker:
 * the app itself must already be loaded.
 *
 * Rules:
 *  - keyed per user, and wiped entirely on sign-out, on any sign-in and on
 *    any dead session (all of which go through `clearSession`/`saveSession`
 *    in api/identity.ts), so a shared device never shows one person's
 *    schedule to the next;
 *  - shown only when a live fetch fails for lack of network, always with its
 *    "last updated" time — never as if it were live;
 *  - storage may be missing, full, cleared or evicted at any time: every
 *    read and write tolerates that and simply behaves as "nothing cached".
 */
const PREFIX = 'shiftsync.offline.v1.';

export interface Cached<T> {
  savedAt: string;
  data: T;
}

function key(userId: string, name: string): string {
  return `${PREFIX}${userId}.${name}`;
}

export function saveOffline<T>(userId: string, name: string, data: T): void {
  try {
    localStorage.setItem(key(userId, name), JSON.stringify({ savedAt: new Date().toISOString(), data }));
  } catch {
    // Quota, private mode or no storage: the copy is optional.
  }
}

export function loadOffline<T>(userId: string, name: string): Cached<T> | null {
  try {
    const raw = localStorage.getItem(key(userId, name));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cached<T>>;
    if (typeof parsed?.savedAt !== 'string' || Number.isNaN(Date.parse(parsed.savedAt)) || parsed.data === undefined) return null;
    return parsed as Cached<T>;
  } catch {
    return null;
  }
}

/** Removes every person's cached schedule. */
export function clearOfflineCache(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    // Nothing readable, nothing to clear.
  }
}

/**
 * True when a request failed because the device is offline or the server was
 * unreachable — not when the server answered with an error. `fetch` rejects
 * with a TypeError in that case; the API modules turn real HTTP answers into
 * `ApiError`, which is not a TypeError.
 */
export function isNetworkFailure(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return err instanceof TypeError;
}

/** "Offline — last updated 14:05" (today) or "Offline — last updated Mon 5 Oct, 14:05". */
export function offlineLabel(savedAt: string, now: Date = new Date()): string {
  const at = new Date(savedAt);
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const sameDay = at.toDateString() === now.toDateString();
  const when = sameDay ? time : `${at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
  return `Offline — last updated ${when}`;
}
