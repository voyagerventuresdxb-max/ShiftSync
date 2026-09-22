/**
 * Roles every brand-new venue starts with — "zero-setup scheduling".
 *
 * 7shifts makes an admin build Locations → Departments → Roles by hand before
 * a single shift can be scheduled. Here a venue can build its first rota the
 * moment signup finishes: these rows are created in the same transaction as
 * the Organization/Location/Owner (server/src/routes/signup.ts), and are
 * ordinary `Role` rows afterwards — renamable, removable, and extendable from
 * the Staff Directory like any role a roster upload creates.
 *
 * Names are the canonical spellings `server/src/parsing/resolveRows.ts`'s
 * ROLE_ALIASES resolves to ("Server" → 'Waiter', "Manager" → 'Management'),
 * so a later roster upload matches these rows instead of creating look-alike
 * duplicates. Shared by the API and the frontend the same way
 * `shared/venueTypes.ts` is.
 */
export const DEFAULT_ROLES = ['Waiter', 'Head Waiter', 'Bartender', 'Host', 'Chef', 'Runner', 'Supervisor', 'Management'] as const;
