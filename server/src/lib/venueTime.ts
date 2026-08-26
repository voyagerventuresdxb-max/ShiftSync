import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

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
