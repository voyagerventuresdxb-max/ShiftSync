/**
 * Pure Venue-screen validation logic, kept in its own CSS-free module
 * (separate from VenueScreen.tsx, which imports OnboardingScreenShell.tsx,
 * which imports a real .css file — that import breaks under `node
 * --test`/tsx's Node-ESM loader, which has no CSS handling the way Vite's
 * bundler does) so this logic stays independently unit-testable. See
 * VenueScreen.test.ts.
 */

/**
 * Whether Continue may fire. `cityTouched` is required, not just `city`
 * being truthy — `city` is pre-seeded to `'Dubai'` before any real choice,
 * so gating on its mere presence would let a manager continue without ever
 * picking anything, silently persisting a default they never chose.
 */
export function computeCanContinue({ name, venueType, cityTouched }: { name: string; venueType: string | null; cityTouched: boolean }): boolean {
  return name.trim().length > 0 && !!venueType && cityTouched;
}
