/**
 * Schedule-publish notification — shared by both ways a Shift can become
 * PUBLISHED: the manual "Publish" action (routes/shifts.ts) and the roster
 * upload/confirm flow (routes/schedules.ts, via parsing/persistShifts.ts).
 * One digest notification per affected staff member per week, same shape as
 * Floor Plan's publish digest — never a separate delivery path per trigger.
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { notifyUser } from './push.js';

dayjs.extend(utc);

/** Monday (UTC calendar date) of the week containing the given YYYY-MM-DD date. */
export function mondayOfWeek(dateStr: string): string {
  const d = dayjs.utc(dateStr);
  const day = d.day(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return d.add(diffToMonday, 'day').format('YYYY-MM-DD');
}

/**
 * Sends one "your schedule is up" notification to each affected staff
 * member for a single published week. Callers are responsible for scoping
 * `userIds` to one week — a roster upload spanning several weeks calls this
 * once per week, not once for the whole file, so nobody's notification body
 * names the wrong week.
 */
export async function notifySchedulePublished(userIds: string[], weekStart: string): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)];
  await Promise.all(
    uniqueUserIds.map((userId) =>
      notifyUser(userId, {
        title: 'Schedule updated',
        body: `Your schedule for the week of ${weekStart} is up.`,
        url: '/my-shifts',
      }),
    ),
  );
}
