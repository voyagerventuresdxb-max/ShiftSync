import type { Prisma, PrismaClient } from '@prisma/client';
import { combineDateAndTime, DEFAULT_VENUE_TIMEZONE } from './normalize.js';
import type { PreviewRow } from './types.js';
import { findBlockingLeave } from '../lib/actions/leaveActions.js';

export interface PersistShiftsResult {
  createdCount: number;
  /** Every row not imported: no resolvable role, or on a blocking leave day (the latter also counted in blockedByLeaveCount). */
  skippedCount: number;
  blockedByLeaveCount: number;
  rows: { rowNumber: number; shiftId: string; userId: string | null; date: string }[];
}

/**
 * Persists previously-previewed & manager-confirmed rows into the Shift
 * table. Rows still missing a resolvedRoleId are skipped (they cannot
 * satisfy the required Shift.roleId FK) — the caller should have already
 * surfaced these in the preview step for the manager to fix upstream.
 *
 * Accepts either the top-level `prisma` client or a `tx` handed in from
 * inside `prisma.$transaction(...)` — the caller (routes/schedules.ts) needs
 * these creates to commit atomically with the audit-log row it writes right
 * after this returns, so it wraps both in one interactive transaction and
 * passes `tx` through here. Because a `tx` cannot itself open a nested
 * `$transaction`, the creates below run sequentially in a plain loop rather
 * than the array form of `$transaction` — an interactive-transaction client
 * is bound to a single reserved DB connection, so firing them concurrently
 * (e.g. via `Promise.all`) wouldn't parallelize anyway and risks tripping
 * the transaction's own timeout under some drivers/poolers. Sequential is
 * both correct and no slower in practice for a single-connection client.
 */
export async function persistShifts(
  prisma: Prisma.TransactionClient | PrismaClient,
  locationId: string,
  createdById: string | null,
  rows: PreviewRow[],
): Promise<PersistShiftsResult> {
  const withRole = rows.filter((r) => r.resolvedRoleId);
  // A row for someone on a blocking leave that day (RotaLeave) is skipped,
  // not imported over the leave — same rule as every other shift write.
  const importable: PreviewRow[] = [];
  for (const r of withRole) {
    if (r.resolvedUserId && (await findBlockingLeave(r.resolvedUserId, r.date, prisma))) continue;
    importable.push(r);
  }
  const blockedByLeaveCount = withRole.length - importable.length;
  const skippedCount = rows.length - importable.length;

  // Shift wall-clock times are always interpreted in the venue's own IANA
  // timezone (never the API host's OS-local zone) so imports are correct
  // regardless of where the server process happens to be deployed.
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { timezone: true } });
  const timezone = location?.timezone || DEFAULT_VENUE_TIMEZONE;

  const created: { id: string; userId: string | null }[] = [];
  for (const row of importable) {
    const startTime = combineDateAndTime(row.date, row.startTime, timezone);
    const endTime = combineDateAndTime(row.date, row.endTime, timezone, row.overnight);

    created.push(
      await prisma.shift.create({
        data: {
          locationId,
          roleId: row.resolvedRoleId!,
          userId: row.resolvedUserId,
          createdById,
          date: new Date(`${row.date}T00:00:00.000Z`),
          startTime,
          endTime,
          breakMinutes: row.breakMinutes,
          managerNotes: row.managerNotes,
          status: 'PUBLISHED',
        },
        select: { id: true, userId: true },
      }),
    );
  }

  return {
    createdCount: created.length,
    skippedCount,
    blockedByLeaveCount,
    rows: created.map((shift, i) => ({
      rowNumber: importable[i]!.rowNumber,
      shiftId: shift.id,
      userId: shift.userId,
      date: importable[i]!.date,
    })),
  };
}
