import { withAuth } from './identity';
import { KIOSK_TOKEN_HEADER } from '../../shared/kioskLinks';

/**
 * Anonymous kiosk venue-binding for `/` (Home) — resolved 2026-08-31 as part
 * of the multi-tenancy kiosk-access fork (see MEMORY.md). Before real
 * multi-tenancy, an anonymous "walk up to the shared venue device" visit and
 * the single hardcoded `'seed-location'` were accidentally interchangeable,
 * so Home worked with no session by accident. Multi-tenancy removed that
 * accident: an anonymous device now needs an explicit signal for which
 * venue's glance board to show. `HomeRoute` adopts a bookmarkable
 * `?venue=<locationId>` URL param into this store on first load; every
 * later bare `/` visit on the same device resolves from here instead,
 * exactly like `identity.ts`'s localStorage-backed session store persists a
 * real login across visits.
 *
 * The venue id alone reads nothing: the server answers the four venue reads
 * (rota, publish status, announcements, shoutouts) only for a session of the
 * venue or the venue's current kiosk token. A manager's kiosk link
 * (`/kiosk?venue=<id>#k=<token>`, see KioskRoute) stores that token here too,
 * and `venueReadHeaders` sends it as `X-Kiosk-Token`.
 */
const VENUE_STORAGE_KEY = 'shiftsync.anonymousVenueId';
const KIOSK_TOKEN_STORAGE_KEY = 'shiftsync.kioskToken';

export function loadBoundVenue(): string | null {
  try {
    return localStorage.getItem(VENUE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function loadKioskToken(): string | null {
  try {
    return localStorage.getItem(KIOSK_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveVenueBinding(venueId: string | null, kioskToken: string | null): void {
  try {
    if (venueId) localStorage.setItem(VENUE_STORAGE_KEY, venueId);
    if (kioskToken) localStorage.setItem(KIOSK_TOKEN_STORAGE_KEY, kioskToken);
    else localStorage.removeItem(KIOSK_TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable: the binding just won't survive a reload.
  }
}

/** The token in a kiosk link's fragment (`#k=<token>`), or null. */
export function kioskTokenFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('k') || null;
}

/** Headers for the four venue reads: the session when signed in, else this device's kiosk token (with neither, the server answers 401). */
export function venueReadHeaders(sessionToken: string | null, kioskToken: string | null): Record<string, string> {
  if (sessionToken) return withAuth(sessionToken);
  return kioskToken ? { [KIOSK_TOKEN_HEADER]: kioskToken } : {};
}
