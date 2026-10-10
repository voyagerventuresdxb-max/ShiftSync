import type { Prisma, RequestStatus } from '@prisma/client';
import { prisma } from '../prisma.js';
import { withAuditedTransaction } from '../auditLog.js';
import { venueTimezoneFor, venueToday } from '../venueTime.js';
import { applyWeekPatchIn, notifyTimeOffDecided, WeekPatchRefusedError } from './weekActions.js';
import { addDays, mondayOf, type IsoDate, type LeaveTypeCode, type TimeOffRequestDto, type WeekPatchOp, type WeekPatchRefusal } from '../../../../shared/rotaWeek.js';

/**
 * Time-off requests (Design board E: "Time-off requests — New"). Until v2 the
 * TimeOffRequest model existed but nothing read or wrote it, and voice
 * REQUEST_TIME_OFF wrote availability marks instead. This module is the single
 * writer: REST (routes/timeOff.ts) and voice both call it. Approving a request
 * turns it into RotaLeave rows through the week patch (`decideTimeOffRequest`),
 * so the grid locks those days and the request leaves the tray in one version
 * bump per week.
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
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { result: 'invalid', message: 'Dates must be real calendar days.' };
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

/** The include every request read uses: the requester's name and venue (a request has no venue column of its own). */
export const TIME_OFF_INCLUDE = { user: { select: { fullName: true, locationId: true } } } as const;
type TimeOffRow = Prisma.TimeOffRequestGetPayload<{ include: typeof TIME_OFF_INCLUDE }>;

const STATUS_DTO: Partial<Record<RequestStatus, TimeOffRequestDto['status']>> = { PENDING: 'pending', APPROVED: 'approved', DECLINED: 'declined' };

/** The shared contract's shape (shared/rotaWeek.ts). EXPIRED/CANCELLED rows are never listed, so they read as declined if ever passed. */
export function timeOffToDto(r: TimeOffRow): TimeOffRequestDto {
  return {
    id: r.id,
    userId: r.userId,
    fullName: r.user.fullName,
    startDate: r.startDate.toISOString().slice(0, 10),
    endDate: r.endDate.toISOString().slice(0, 10),
    reason: r.reason,
    status: STATUS_DTO[r.status] ?? 'declined',
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    managerNote: r.managerNote,
  };
}

export type DecideTimeOffResult =
  | { result: 'ok'; request: TimeOffRequestDto; versions: Record<IsoDate, number> }
  | { result: 'not_found' }
  | { result: 'not_pending' }
  | { result: 'refused'; refusal: WeekPatchRefusal; message: string };

class TimeOffNotPendingError extends Error {}

/**
 * Approves or declines a PENDING request of a person at `locationId` (the
 * caller's venue — a request of another venue is `not_found`, never decided).
 *
 * Approve, in ONE transaction: the request is claimed with a conditional
 * update (so two managers can never both decide it: the second gets
 * `not_pending`), then for every week the range touches, one week patch
 * (source 'timeOff') turns any live shift of that person on those days into
 * an open shift and marks each day as leave (`leaveType`, default annual
 * leave); the leave rows are tied to the request, which locks them. Days
 * already past are skipped, not refused. A refusal of any week (the person
 * was deactivated, say) rolls everything back.
 *
 * Decline: the conditional status flip only; the grid is untouched.
 *
 * Both write a TIME_OFF_APPROVED / TIME_OFF_DECLINED audit row and, after
 * commit, tell the requester ("Time off approved: Tue 14 – Thu 16 Oct").
 */
export async function decideTimeOffRequest(
  input: { id: string; locationId: string; reviewerId: string; decision: 'approve' | 'decline'; leaveType?: LeaveTypeCode; note?: string | null },
  client: typeof prisma = prisma,
): Promise<DecideTimeOffResult> {
  const existing = await client.timeOffRequest.findUnique({ where: { id: input.id }, include: TIME_OFF_INCLUDE });
  if (!existing || existing.user.locationId !== input.locationId) return { result: 'not_found' };
  if (existing.status !== 'PENDING') return { result: 'not_pending' };

  const approve = input.decision === 'approve';
  const leaveType: LeaveTypeCode = input.leaveType ?? 'ANNUAL_LEAVE';
  const managerNote = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  const tz = await venueTimezoneFor(input.locationId);
  const today = venueToday(tz);
  const startIso = existing.startDate.toISOString().slice(0, 10);
  const endIso = existing.endDate.toISOString().slice(0, 10);

  // The days still to come, grouped by week (each week is one patch, one version bump), in date order — the
  // order every writer that locks several weeks takes their locks in.
  const byWeek = new Map<IsoDate, IsoDate[]>();
  for (let d = startIso < today ? today : startIso; d <= endIso; d = addDays(d, 1)) {
    const weekStart = mondayOf(d);
    byWeek.set(weekStart, [...(byWeek.get(weekStart) ?? []), d]);
  }

  try {
    const outcome = await withAuditedTransaction(
      client,
      async (tx) => {
        const claimed = await tx.timeOffRequest.updateMany({
          where: { id: input.id, status: 'PENDING' },
          data: { status: approve ? 'APPROVED' : 'DECLINED', reviewedById: input.reviewerId, reviewedAt: new Date(), managerNote },
        });
        if (claimed.count === 0) throw new TimeOffNotPendingError();

        const versions: Record<IsoDate, number> = {};
        if (approve) {
          for (const [weekStart, days] of [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            const live = await tx.shift.findMany({
              where: {
                locationId: input.locationId,
                userId: existing.userId,
                date: { in: days.map((d) => new Date(`${d}T00:00:00.000Z`)) },
                status: { not: 'CANCELLED' },
              },
              select: { id: true },
            });
            const ops: WeekPatchOp[] = [
              // The shift stays on the rota as an open shift, so the coverage row flags the gap.
              ...live.map((s): WeekPatchOp => ({ op: 'update', shiftId: s.id, userId: null })),
              ...days.map((date): WeekPatchOp => ({ op: 'setLeave', userId: existing.userId, date, type: leaveType })),
            ];
            const patched = await applyWeekPatchIn(tx, {
              locationId: input.locationId,
              weekStart,
              actorId: input.reviewerId,
              source: 'timeOff',
              patch: { ops, note: `Time-off request ${input.id} approved` },
            });
            versions[weekStart] = patched.version;
            await tx.rotaLeave.updateMany({
              where: { locationId: input.locationId, userId: existing.userId, date: { in: days.map((d) => new Date(`${d}T00:00:00.000Z`)) } },
              data: { timeOffRequestId: input.id },
            });
          }
        }
        const request = await tx.timeOffRequest.findUniqueOrThrow({ where: { id: input.id }, include: TIME_OFF_INCLUDE });
        return { request, versions };
      },
      () => ({
        locationId: input.locationId,
        actorId: input.reviewerId,
        action: approve ? 'TIME_OFF_APPROVED' : 'TIME_OFF_DECLINED',
        entityType: 'TimeOffRequest',
        entityId: input.id,
        note: `${approve ? 'Approved' : 'Declined'} ${existing.user.fullName}'s time off ${startIso}${endIso !== startIso ? ` to ${endIso}` : ''}${approve ? ` as ${leaveType}` : ''}${managerNote ? ` — ${managerNote}` : ''}`,
      }),
      // A long request spans several weeks, each reading its week document back.
      { maxWait: 10_000, timeout: 30_000 },
    );
    await notifyTimeOffDecided([input.id], approve ? 'approved' : 'declined', client);
    return { result: 'ok', request: timeOffToDto(outcome.request), versions: outcome.versions };
  } catch (err) {
    if (err instanceof TimeOffNotPendingError) return { result: 'not_pending' };
    if (err instanceof WeekPatchRefusedError) return { result: 'refused', refusal: err.refusal, message: err.message };
    throw err;
  }
}
