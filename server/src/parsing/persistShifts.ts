import type { PrismaClient } from '@prisma/client';
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
 */
export async function persistShifts(
  prisma: PrismaClient,
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

  const created = await prisma.$transaction(
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
