import { weekDays, type IsoDate, type LeaveTypeCode, type WeekDocDto, type WeekShiftDto } from '../../../../shared/rotaWeek';
import { dayNumber, personDay, toMinutes } from './weekModel';

/**
 * The staff "My week" model (Design board B7): seven day rows, which shift is
 * on now or next, and the pending-request markers. Times are venue wall-clock
 * minutes on a continuous scale (day number × 1440 + minutes), so a
 * cross-midnight shift belongs to its start day but still counts as "on now"
 * at 00:30 the next morning.
 */

export interface ShiftInterval {
  shift: WeekShiftDto;
  start: number;
  end: number;
}

/** Each range of a shift on the continuous venue-minute scale; the last range may run past midnight. */
export function shiftIntervals(shift: WeekShiftDto): ShiftInterval[] {
  const base = dayNumber(shift.date) * 1440;
  return shift.ranges.map((r) => {
    const start = base + toMinutes(r.start);
    let end = base + toMinutes(r.end);
    if (end <= start) end += 1440;
    return { shift, start, end };
  });
}

export interface NowNext {
  /** On shift right now, with the minutes until this part of it ends. */
  current: { shift: WeekShiftDto; endsIn: number } | null;
  /** The next shift (or the second half of a split) still to start, with the minutes until it does. */
  next: { shift: WeekShiftDto; startsIn: number } | null;
}

export function nowAndNext(shifts: WeekShiftDto[], now: { date: IsoDate; minutes: number }): NowNext {
  const t = dayNumber(now.date) * 1440 + now.minutes;
  const intervals = shifts.flatMap(shiftIntervals).sort((a, b) => a.start - b.start);
  const on = intervals.find((i) => i.start <= t && t < i.end);
  const upcoming = intervals.find((i) => i.start > t && i.shift.id !== on?.shift.id) ?? intervals.find((i) => i.start > t);
  return {
    current: on ? { shift: on.shift, endsIn: on.end - t } : null,
    next: upcoming ? { shift: upcoming.shift, startsIn: upcoming.start - t } : null,
  };
}

/** "8 h 40 min", "35 min", "2 h". */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export interface StaffDay {
  date: IsoDate;
  shifts: WeekShiftDto[];
  leave: LeaveTypeCode | null;
  /** Your time-off request covering this day is waiting for the manager. */
  offRequested: boolean;
  /** Your swap request for this day's shift is waiting. */
  swapRequested: boolean;
  today: boolean;
  past: boolean;
}

export function staffDays(week: Pick<WeekDocDto, 'weekStart' | 'shifts' | 'leaves' | 'requests'>, userId: string, today: IsoDate): StaffDay[] {
  return weekDays(week.weekStart).map((date) => {
    const day = personDay(week, userId, date);
    const ids = new Set(day.shifts.map((s) => s.id));
    return {
      date,
      shifts: day.shifts,
      leave: day.leave?.type ?? null,
      offRequested: day.pendingRequest !== null,
      swapRequested: week.requests.some((r) => r.kind === 'swap' && r.status === 'pending' && r.userId === userId && !!r.shiftId && ids.has(r.shiftId)),
      today: date === today,
      past: date < today,
    };
  });
}

/** Shifts the person may still offer for a swap: theirs, not yet started, without a pending swap. */
export function swappableShifts(days: StaffDay[], now: { date: IsoDate; minutes: number }): WeekShiftDto[] {
  const t = dayNumber(now.date) * 1440 + now.minutes;
  return days
    .filter((d) => !d.swapRequested)
    .flatMap((d) => d.shifts)
    .filter((s) => (shiftIntervals(s)[0]?.start ?? 0) > t);
}
