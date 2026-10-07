/**
 * How the voice confirm sheet spells out a day and a shift, so a wrong day or a wrong time is
 * visible at a glance: the full weekday, the date with the year, and the times as said — an
 * overnight shift says which day it ends ("Friday 9 October 2026, 18:30 – 01:00 (ends Saturday)").
 * Dates are venue-local calendar days (YYYY-MM-DD); times are venue-local "HH:MM".
 */

const parse = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** "Friday 9 October 2026" for a YYYY-MM-DD venue day (the input unchanged if it isn't one). */
export function fullDay(iso: string): string {
  const d = parse(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${weekday} ${date}`;
}

/** True when a shift from `start` to `end` ("18:30" → "01:00") runs past midnight. */
export function endsNextDay(start: string, end: string): boolean {
  return /^\d{1,2}:\d{2}$/.test(start) && /^\d{1,2}:\d{2}$/.test(end) && end.padStart(5, '0') <= start.padStart(5, '0');
}

/** "18:30 – 01:00 (ends Saturday)" for an overnight shift; "09:00 – 17:00" otherwise. */
export function timeSpan(date: string | undefined, start: string, end: string): string {
  const span = `${start} – ${end}`;
  if (!endsNextDay(start, end)) return span;
  const d = date ? parse(date) : null;
  if (!d || Number.isNaN(d.getTime())) return `${span} (ends next day)`;
  d.setUTCDate(d.getUTCDate() + 1);
  return `${span} (ends ${d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })})`;
}

/** "Friday 9 October 2026, 18:30 – 01:00 (ends Saturday)". */
export function shiftWhen(date: string, start: string, end: string): string {
  return `${fullDay(date)}, ${timeSpan(date, start, end)}`;
}
