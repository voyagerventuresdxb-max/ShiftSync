/**
 * Child-process half of timezoneMatrix.test.ts: prints one JSON line of date
 * results computed under whatever `TZ` this process was started with.
 */
import { currentVenueWeekStart, isMondayIso, venueDateOf, venueWeekRange } from './venueWeek.js';
import { nextRequestWindowClose } from './swapRequestPolicy.js';
import { shiftLabelOf } from './actions/swapActions.js';

const DUBAI = 'Asia/Dubai';
const LA = 'America/Los_Angeles';
const at = (iso: string) => new Date(iso);

const out = {
  weekStart_oct3_dubai: currentVenueWeekStart(at('2026-10-03T06:00:00.000Z'), DUBAI),
  today_oct3_dubai: venueDateOf(at('2026-10-03T06:00:00.000Z'), DUBAI),
  weekStart_oct31_dubai: currentVenueWeekStart(at('2026-10-31T19:30:00.000Z'), DUBAI),
  today_oct31_dubai: venueDateOf(at('2026-10-31T19:30:00.000Z'), DUBAI),
  weekStart_dec31_dubai: currentVenueWeekStart(at('2026-12-31T19:30:00.000Z'), DUBAI),
  today_dec31_dubai: venueDateOf(at('2026-12-31T19:30:00.000Z'), DUBAI),
  weekStart_monday_0030_dubai: currentVenueWeekStart(at('2026-10-04T20:30:00.000Z'), DUBAI),
  today_monday_0030_dubai: venueDateOf(at('2026-10-04T20:30:00.000Z'), DUBAI),
  weekStart_monday_0030_dubai_as_la_venue: currentVenueWeekStart(at('2026-10-04T20:30:00.000Z'), LA),
  close_wed_1659: nextRequestWindowClose(at('2026-10-07T12:59:00.000Z'), DUBAI).toISOString(),
  close_wed_1701: nextRequestWindowClose(at('2026-10-07T13:01:00.000Z'), DUBAI).toISOString(),
  close_wed_1700: nextRequestWindowClose(at('2026-10-07T13:00:00.000Z'), DUBAI).toISOString(),
  close_wed_la_venue: nextRequestWindowClose(at('2026-10-07T12:59:00.000Z'), LA).toISOString(),
  label_dubai_shift: shiftLabelOf({
    date: at('2026-10-05T00:00:00.000Z'),
    startTime: at('2026-10-05T05:00:00.000Z'),
    endTime: at('2026-10-05T13:00:00.000Z'),
    location: { timezone: DUBAI },
  }),
  week_range_dubai_start: venueWeekRange('2026-10-05', DUBAI).start.toISOString(),
  week_range_dubai_end: venueWeekRange('2026-10-05', DUBAI).end.toISOString(),
  monday_check: [isMondayIso('2026-10-05'), isMondayIso('2026-10-04'), isMondayIso('2026-10-32'), isMondayIso('2027-01-04')],
};
console.log(JSON.stringify(out));
