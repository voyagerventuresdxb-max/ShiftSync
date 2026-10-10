import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { shiftRangesOf } from './actions/weekActions.js';
import { addDays } from '../../../shared/rotaWeek.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/** Before this venue hour, a clock-in may still belong to last night's cross-midnight shift. */
export const OVERNIGHT_CUTOFF_HOUR = 6;

export interface ClockInCandidate {
  id: string;
  /** The shift's venue day (its start day), YYYY-MM-DD. */
  date: string;
  endTime: Date;
  endsNextDay: boolean;
}

/**
 * Which of a person's published shifts a clock-in at `now` belongs to, by the
 * start-day rule (a shift belongs to the venue day it starts on): today's
 * shift — except between 00:00 and 06:00 venue time, when yesterday's shift
 * that runs past midnight and has not ended yet wins (an Evening 16:00–01:00
 * clock-in at 00:20 is that Evening, not today's Morning). Null when neither
 * exists: the clock-in is still recorded, just without a shift.
 */
export function pickClockInShift(candidates: ClockInCandidate[], now: Date, tz: string): ClockInCandidate | null {
  const local = dayjs(now).tz(tz);
  const today = local.format('YYYY-MM-DD');
  if (local.hour() < OVERNIGHT_CUTOFF_HOUR) {
    const yesterday = addDays(today, -1);
    const overnight = candidates.find((c) => c.date === yesterday && c.endsNextDay && c.endTime.getTime() > now.getTime());
    if (overnight) return overnight;
  }
  return candidates.find((c) => c.date === today) ?? null;
}

/** The person's PUBLISHED (or completed) shift at their venue that a clock-in at `now` belongs to (see pickClockInShift). */
export async function findClockInShift(
  input: { userId: string; locationId: string; now: Date; tz: string },
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string | null> {
  const today = dayjs(input.now).tz(input.tz).format('YYYY-MM-DD');
  const rows = await db.shift.findMany({
    where: {
      userId: input.userId,
      locationId: input.locationId,
      status: { in: ['PUBLISHED', 'COMPLETED'] },
      date: { gte: new Date(`${addDays(today, -1)}T00:00:00.000Z`), lte: new Date(`${today}T00:00:00.000Z`) },
    },
    select: { id: true, date: true, startTime: true, endTime: true, ranges: true, endsNextDay: true },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  });
  const candidates = rows.map((r): ClockInCandidate => ({
    id: r.id,
    date: r.date.toISOString().slice(0, 10),
    endTime: r.endTime,
    endsNextDay: shiftRangesOf(r, input.tz).endsNextDay,
  }));
  return pickClockInShift(candidates, input.now, input.tz)?.id ?? null;
}
