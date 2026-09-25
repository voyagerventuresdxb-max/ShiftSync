import type { Prisma, User } from '@prisma/client';
import { isManagerRole } from '../middleware/requireSession.js';

/**
 * Draft visibility — the single rule every shift read goes through
 * (2026-09-25, golden-path v0): a DRAFT shift is visible only to a manager of
 * the venue it belongs to. Staff and anonymous (kiosk) callers get PUBLISHED
 * shifts only, no exceptions. Fail-closed: no user, another venue's user, or
 * any role outside the manager allowlist → published only.
 */
export function canSeeDraftShifts(user: Pick<User, 'systemRole' | 'locationId'> | null | undefined, locationId: string): boolean {
  return Boolean(user) && isManagerRole(user!.systemRole) && user!.locationId === locationId;
}

/** Prisma `where` fragment for `canSeeDraftShifts`: `{}` for a venue manager, `{ status: 'PUBLISHED' }` for everyone else. */
export function visibleShiftFilter(user: Pick<User, 'systemRole' | 'locationId'> | null | undefined, locationId: string): Prisma.ShiftWhereInput {
  return canSeeDraftShifts(user, locationId) ? {} : { status: 'PUBLISHED' };
}
