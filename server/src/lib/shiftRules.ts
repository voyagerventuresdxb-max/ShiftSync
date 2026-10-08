import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { combineDateAndTime } from '../parsing/normalize.js';
import { venueToday } from './venueTime.js';
import { isIsoDate } from './venueWeek.js';

/**
 * The checks a shift change must pass, shared by the REST shift routes (routes/shifts.ts) and
 * voice's /execute (routes/voice.ts), so the two can't drift apart. Each answers a question; the
 * caller decides the status code and wording.
 */
type Db = Prisma.TransactionClient | typeof prisma;

/** A role of this venue that new shifts may use: it exists here and hasn't been removed. */
export async function findActiveVenueRole(roleId: string, locationId: string, db: Db = prisma) {
  const role = await db.role.findUnique({ where: { id: roleId } });
  return role && role.locationId === locationId && role.isActive ? role : null;
}

/** A person of this venue; `activeOnly` also refuses a deactivated account. */
export async function findVenueUser(userId: string, locationId: string, opts: { activeOnly?: boolean } = {}, db: Db = prisma) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.locationId !== locationId) return null;
  return opts.activeOnly && !user.isActive ? null : user;
}

/** A real YYYY-MM-DD calendar day ("2026-02-30" and "9999-99-99" are not). */
export function isRealDate(iso: unknown): iso is string {
  return typeof iso === 'string' && isIsoDate(iso);
}

/** True when the venue-local calendar day `iso` is before the venue's today. */
export function isPastVenueDay(iso: string, timezone: string): boolean {
  return iso < venueToday(timezone);
}

/** A shift's start and end instants; an end at or before the start is the next morning. */
export function shiftInstants(date: string, start: string, end: string, timezone: string): { startTime: Date; endTime: Date } {
  return { startTime: combineDateAndTime(date, start, timezone), endTime: combineDateAndTime(date, end, timezone, end <= start) };
}

/** Another live shift of this person at this venue that overlaps the given instants, if any. */
export async function findOverlappingShift(
  input: { userId: string; locationId: string; startTime: Date; endTime: Date; excludeShiftId?: string },
  db: Db = prisma,
) {
  return db.shift.findFirst({
    where: {
      userId: input.userId,
      locationId: input.locationId,
      status: { not: 'CANCELLED' },
      startTime: { lt: input.endTime },
      endTime: { gt: input.startTime },
      ...(input.excludeShiftId ? { id: { not: input.excludeShiftId } } : {}),
    },
    select: { id: true, startTime: true, endTime: true },
  });
}
