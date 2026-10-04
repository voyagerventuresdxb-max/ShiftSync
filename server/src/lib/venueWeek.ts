import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { DEFAULT_VENUE_TIMEZONE } from '../parsing/normalize.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Week arithmetic that is explicit about WHICH calendar it uses.
 *
 * Every rota week in this app starts on a Monday (`src/engine/weekStart.ts`
 * on the client; templates store Monday-relative offsets; `RotaPublish` is
 * keyed on the Monday). `Shift.date` is UTC midnight of the venue-local
 * calendar day, so a week's `date` range is `[weekStart 00:00Z, +7d)`, while
 * anything keyed on a real instant (clock-ins, `startTime`) has to use the
 * venue's own midnight (`venueWeekRange`). Nothing here reads the process
 * timezone: a UTC Railway host and an Asia/Dubai laptop give the same answers.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `iso` is a real YYYY-MM-DD calendar date. */
export function isIsoDate(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** True when `iso` (YYYY-MM-DD) is a Monday. Pure calendar math, no timezone involved. */
export function isMondayIso(iso: string): boolean {
  return isIsoDate(iso) && new Date(`${iso}T00:00:00.000Z`).getUTCDay() === 1;
}

export const WEEK_START_NOT_MONDAY_ERROR = 'weekStart must be the Monday of the week, as YYYY-MM-DD.';

/** The Monday (YYYY-MM-DD) of the week containing `now`, in the venue's timezone. */
export function currentVenueWeekStart(now: Date = new Date(), tz: string = DEFAULT_VENUE_TIMEZONE): string {
  const local = dayjs(now).tz(tz);
  const diffToMonday = local.day() === 0 ? -6 : 1 - local.day();
  return local.add(diffToMonday, 'day').format('YYYY-MM-DD');
}

/** Today's date (YYYY-MM-DD) in the venue's timezone — `venueTime.ts`'s `venueToday`, with an injectable clock. */
export function venueDateOf(now: Date, tz: string = DEFAULT_VENUE_TIMEZONE): string {
  return dayjs(now).tz(tz).format('YYYY-MM-DD');
}

/**
 * The real instants that bound a rota week in the venue's timezone:
 * `[Monday 00:00 venue-local, next Monday 00:00 venue-local)`. For anything
 * stored as an instant (attendance clock-ins, shift start times).
 */
export function venueWeekRange(weekStart: string, tz: string = DEFAULT_VENUE_TIMEZONE): { start: Date; end: Date } {
  const start = dayjs.tz(`${weekStart}T00:00:00`, tz);
  return { start: start.toDate(), end: start.add(7, 'day').toDate() };
}

/** `Shift.date`'s convention: the week as UTC-midnight calendar days, `[weekStart, +7d)`. */
export function calendarWeekRange(weekStart: string): { start: Date; end: Date } {
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}
