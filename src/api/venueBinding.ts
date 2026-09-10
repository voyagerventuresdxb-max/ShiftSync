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
 */
const VENUE_STORAGE_KEY = 'shiftsync.anonymousVenueId';

export function loadBoundVenue(): string | null {
  return localStorage.getItem(VENUE_STORAGE_KEY);
}

export function saveBoundVenue(locationId: string): void {
  localStorage.setItem(VENUE_STORAGE_KEY, locationId);
}
