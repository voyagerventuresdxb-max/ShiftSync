import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';

/**
 * Time-off requests (Design board E: "Time-off requests — New"). Until v2 the
 * TimeOffRequest model existed but nothing read or wrote it, and voice
 * REQUEST_TIME_OFF wrote availability marks instead. This module is the single
 * writer: REST (routes/timeOff.ts) and voice both call it. Approving a request
 * turns it into RotaLeave rows through the week patch (see `decideTimeOffRequest`,
 * added alongside the routes), so the grid locks those days and the request
 * leaves the tray in one version bump.
 */

export type CreateTimeOffResult =
  | { result: 'ok'; id: string; startDate: string; endDate: string }
  | { result: 'invalid'; message: string }
  | { result: 'duplicate'; id: string; message: string };

/**
 * Files a PENDING request for `userId` covering `startDate`..`endDate`
 * (YYYY-MM-DD, inclusive, venue-local days). Refuses a reversed or overlong
 * range and a second pending request overlapping an existing one. The caller
 * has already checked the person belongs to the caller's venue and that a
 * staff caller is filing for themselves.
 */
export async function createTimeOffRequest(
  input: { userId: string; startDate: string; endDate: string; reason?: string | null },
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<CreateTimeOffResult> {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(input.startDate) || !iso.test(input.endDate)) return { result: 'invalid', message: 'Dates must be YYYY-MM-DD.' };
  if (input.endDate < input.startDate) return { result: 'invalid', message: 'The last day is before the first day.' };
  const start = new Date(`${input.startDate}T00:00:00.000Z`);
  const end = new Date(`${input.endDate}T00:00:00.000Z`);
  if ((end.getTime() - start.getTime()) / 86_400_000 > 60) return { result: 'invalid', message: 'A single request can cover at most 60 days.' };
  const overlapping = await client.timeOffRequest.findFirst({
    where: { userId: input.userId, status: 'PENDING', startDate: { lte: end }, endDate: { gte: start } },
    select: { id: true },
  });
  if (overlapping) return { result: 'duplicate', id: overlapping.id, message: 'There is already a pending request covering some of those days.' };
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, 500) : null;
  // `expiresAt` is required by the schema (the weekly request-window cutoff the
  // swap engine uses); a time-off request simply lapses after its last day.
  const expiresAt = new Date(end.getTime() + 86_400_000);
  const row = await client.timeOffRequest.create({
    data: { userId: input.userId, startDate: start, endDate: end, reason, status: 'PENDING', expiresAt },
    select: { id: true },
  });
  return { result: 'ok', id: row.id, startDate: input.startDate, endDate: input.endDate };
}
