/**
 * Venue-type categories offered during onboarding/signup and shown on the
 * venue profile. Single source of truth for both the frontend
 * (`src/api/locations.ts`) and the API (`server/src/routes/locations.ts`),
 * which hand-copied this list independently until this file was introduced
 * (2026-08-31 tech-debt consolidation — see MEMORY.md). `src/` and
 * `server/src/` are separate TypeScript projects with no cross-imports
 * between them; this directory is deliberately outside both so either side
 * can import it without one depending on the other.
 */
export const VENUE_TYPES = [
  'Fine Dining',
  'Bar / Lounge',
  'Nightclub',
  'Rooftop / Beach Club',
  'Hotel F&B Outlet',
  'Café / Bakery',
] as const;
