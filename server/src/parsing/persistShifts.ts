import type { Prisma, PrismaClient } from '@prisma/client';
import { combineDateAndTime, DEFAULT_VENUE_TIMEZONE } from './normalize.js';
import type { PreviewRow } from './types.js';

export interface PersistShiftsResult {
  createdCount: number;
  skippedCount: number;
  rows: { rowNumber: number; shiftId: string; userId: string | null }[];
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
 * `$transaction`, the batch of creates below runs as `Promise.all` rather
 * than the array form of `$transaction` — when `prisma` here IS a `tx`,
 * they're already part of one atomic transaction from the caller; when it's
 * the top-level client (e.g. this function's own unit test), the concurrent
 * creates are no longer wrapped in a DB transaction, which is unchanged in
 * practice since nothing currently calls this outside of a wrapping `tx`.
 */
export async function persistShifts(
  prisma: Prisma.TransactionClient | PrismaClient,
  locationId: string,
  createdById: string | null,
  rows: PreviewRow[],
): Promise<PersistShiftsResult> {
  const importable = rows.filter((r) => r.resolvedRoleId);
  const skippedCount = rows.length - importable.length;

  // Shift wall-clock times are always interpreted in the venue's own IANA
  // timezone (never the API host's OS-local zone) so imports are correct
  // regardless of where the server process happens to be deployed.
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { timezone: true } });
  const timezone = location?.timezone || DEFAULT_VENUE_TIMEZONE;

  const created = await Promise.all(
    importable.map((row) => {
      const startTime = combineDateAndTime(row.date, row.startTime, timezone);
      const endTime = combineDateAndTime(row.date, row.endTime, timezone, row.overnight);

      return prisma.shift.create({
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
      });
    }),
  );

  return {
    createdCount: created.length,
    skippedCount,
    rows: created.map((shift, i) => ({
      rowNumber: importable[i]!.rowNumber,
      shiftId: shift.id,
      userId: shift.userId,
    })),
  };
}
