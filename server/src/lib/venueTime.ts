import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { prisma } from './prisma.js';
import { DEFAULT_VENUE_TIMEZONE } from '../parsing/normalize.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * The reverse of `combineDateAndTime` (server/src/parsing/normalize.ts):
 * renders a stored UTC instant as the venue-local wall-clock "HH:MM" it
 * actually represents, in the given IANA timezone — never the host OS's
 * local zone.
 */
export function formatVenueTime(date: Date, timezone: string): string {
  return dayjs(date).tz(timezone).format('HH:mm');
}

/**
 * The venue's CURRENT local calendar day as YYYY-MM-DD.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC calendar date, which is
 * NOT the venue's date for several hours a day in a UTC+n zone — in
 * Asia/Dubai (UTC+4) everything between 00:00 and 04:00 local is still
 * "yesterday" in UTC. Anything that resolves relative day words ("tomorrow",
 * "this Friday") against "today" must use this, not the UTC date.
 */
export function venueToday(timezone: string): string {
  return dayjs().tz(timezone).format('YYYY-MM-DD');
}

/**
 * Resolves a Location's IANA timezone, falling back to the venue default when
 * the record has none. Mirrors the same lookup `server/src/routes/shifts.ts`
 * does before formatting any stored instant for display.
 */
export async function venueTimezoneFor(locationId: string): Promise<string> {
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { timezone: true } });
  return location?.timezone || DEFAULT_VENUE_TIMEZONE;
}
