import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/** Every venue's swap-request window closes Wednesday 17:00, venue-local. */
const VENUE_TIMEZONE = 'Asia/Dubai';
const CLOSE_WEEKDAY = 3; // dayjs: 0=Sunday..6=Saturday, Wednesday=3
const CLOSE_HOUR = 17;

/**
 * The next Wednesday 17:00 in the venue's timezone, from `now`. If `now` is
 * already Wednesday and past 17:00, rolls to the following week instead of
 * returning a time in the past.
 */
export function nextRequestWindowClose(now: Date = new Date()): Date {
  const nowInVenue = dayjs(now).tz(VENUE_TIMEZONE);
  const daysUntilClose = (CLOSE_WEEKDAY - nowInVenue.day() + 7) % 7;
  let candidate = nowInVenue.add(daysUntilClose, 'day').hour(CLOSE_HOUR).minute(0).second(0).millisecond(0);
  if (candidate.isBefore(nowInVenue)) candidate = candidate.add(7, 'day');
  return candidate.toDate();
}

/**
 * A pending swap request is auto-locked when a DIFFERENT already-approved
 * request already reassigned the same shift out from under it — approving
 * this one too would silently overwrite that resolution. Decided requests
 * (already approved/declined) are never locked; there's nothing left to
 * protect. An unassigned shift (userId: null) has nothing to conflict with.
 */
export function isRequestLocked(
  request: { status: string },
  shift: { userId: string | null },
  requestedById: string,
): boolean {
  if (request.status !== 'PENDING') return false;
  if (shift.userId === null) return false;
  return shift.userId !== requestedById;
}
