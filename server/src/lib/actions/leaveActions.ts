import type { LeaveType, Prisma, RotaLeave } from '@prisma/client';
import { prisma } from '../prisma.js';
import { LEAVE_LABELS, LEAVE_TYPES, leaveBlocksShift } from '../../../../shared/leaveTypes.js';

export { LEAVE_LABELS, LEAVE_TYPES, leaveBlocksShift };

type Client = Prisma.TransactionClient | typeof prisma;

/** `YYYY-MM-DD` → the UTC-midnight `Date` Shift/RotaLeave `@db.Date` columns store. */
function dayOf(date: string | Date): Date {
  return typeof date === 'string' ? new Date(`${date}T00:00:00.000Z`) : date;
}

/**
 * The blocking leave (any type but HALF_DAY) a staff member has on `date`,
 * or null. Every shift write that assigns a person to a day calls this:
 * REST create/edit/bulk, voice CREATE_SHIFT/EDIT_SHIFT, rota template apply
 * (REST + voice), roster upload confirm (skips the row) and swap approval.
 * It is an application-level check, not a DB constraint — two concurrent
 * writes (a shift and a leave for the same person/day) can both pass.
 */
export async function findBlockingLeave(userId: string, date: string | Date, client: Client = prisma): Promise<RotaLeave | null> {
  const leave = await client.rotaLeave.findUnique({ where: { userId_date: { userId, date: dayOf(date) } } });
  return leave && leaveBlocksShift(leave.type) ? leave : null;
}

/** The message every refused shift write returns (409), so the builder, API and voice all say the same thing. */
export function blockedByLeaveMessage(leave: Pick<RotaLeave, 'type' | 'date'>, fullName?: string): string {
  const who = fullName ?? 'This staff member';
  return `${who} is on ${LEAVE_LABELS[leave.type]} on ${leave.date.toISOString().slice(0, 10)} — remove the leave before adding a shift that day.`;
}

export type SetLeaveResult =
  | { result: 'ok'; leave: RotaLeave; created: boolean }
  | { result: 'conflict'; message: string };

/**
 * Marks (or changes) one person's leave for one day. A NEW row starts as
 * DRAFT and goes live when the week is published; changing the type of an
 * already-PUBLISHED row keeps it published — the same "published edits stay
 * live" rule shifts follow. A blocking type is refused while that person
 * already has a shift that day (the builder has to remove or move it first).
 * Validation of user/location membership is the caller's, as in shiftActions.
 */
export async function setLeave(
  input: { locationId: string; userId: string; date: string; type: LeaveType; createdById: string },
  client: Client = prisma,
): Promise<SetLeaveResult> {
  const date = dayOf(input.date);
  if (leaveBlocksShift(input.type)) {
    const clash = await client.shift.findFirst({ where: { userId: input.userId, date }, select: { id: true } });
    if (clash) {
      return {
        result: 'conflict',
        message: `There's already a shift on ${input.date} — remove or move it before marking ${LEAVE_LABELS[input.type]}.`,
      };
    }
  }
  const existing = await client.rotaLeave.findUnique({ where: { userId_date: { userId: input.userId, date } } });
  const leave = existing
    ? await client.rotaLeave.update({ where: { id: existing.id }, data: { type: input.type } })
    : await client.rotaLeave.create({
        data: { locationId: input.locationId, userId: input.userId, date, type: input.type, createdById: input.createdById, status: 'DRAFT' },
      });
  return { result: 'ok', leave, created: !existing };
}

export async function deleteLeave(id: string, client: Client = prisma): Promise<void> {
  await client.rotaLeave.delete({ where: { id } });
}
