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
import { formatVenueTime } from './venueTime.js';

dayjs.extend(utc);

/** Monday (UTC calendar date) of the week containing the given YYYY-MM-DD date. */
export function mondayOfWeek(dateStr: string): string {
  const d = dayjs.utc(dateStr);
  const day = d.day(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return d.add(diffToMonday, 'day').format('YYYY-MM-DD');
}

/**
 * One person's week as "Tue 8 Apr 11:00–15:00 + 18:00–23:00, Wed 9 Apr
 * 17:00–23:00" in venue time — both segments of a split shift under one day.
 */
export function weekScheduleSummary(shifts: { date: Date; startTime: Date; endTime: Date }[], timezone: string): string {
  const byDay = new Map<string, string[]>();
  for (const s of [...shifts].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())) {
    const day = dayjs.utc(s.date).format('ddd D MMM');
    byDay.set(day, [...(byDay.get(day) ?? []), `${formatVenueTime(s.startTime, timezone)}–${formatVenueTime(s.endTime, timezone)}`]);
  }
  return [...byDay].map(([day, times]) => `${day} ${times.join(' + ')}`).join(', ');
}

/**
 * Sends one "your schedule is up" notification to each affected staff
 * member for a single published week. Callers are responsible for scoping
 * `userIds` to one week — a roster upload spanning several weeks calls this
 * once per week, not once for the whole file, so nobody's notification body
 * names the wrong week. `summaries` (rota publish) appends that person's
 * shifts to the body; a person without one gets the plain copy.
 */
export async function notifySchedulePublished(userIds: string[], weekStart: string, summaries?: Map<string, string>): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)];
  await Promise.all(
    uniqueUserIds.map((userId) => {
      const summary = summaries?.get(userId);
      return notifyUser(userId, {
        title: 'Schedule updated',
        body: summary ? `Your schedule for the week of ${weekStart} is up: ${summary}.` : `Your schedule for the week of ${weekStart} is up.`,
        url: '/my-shifts',
      });
    }),
  );
}
