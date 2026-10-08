/**
 * Which week a roster is for, read from what it PRINTS — never the week of the upload.
 *
 * Shared by every reader (table reader, AI reader, text fallback) so a roster is dated the same
 * way whichever reader saw it:
 *  - Day headers with a day and a month ("17-Aug", "Mon 17/08", "MONDAY 17 AUGUST", "Aug 17",
 *    "17th Aug"): the year in which those dates fall on the printed weekdays, nearest to today;
 *    without weekdays, the year nearest to today.
 *  - Weekday-only headers ("Mon", "MONDAY") with a title that names the week ("Rota 24 - 30 Aug",
 *    "Week of 24/08"): anchored on the title.
 *  - Weekday-only headers and nothing else: the client's weekStart when it sent one, else the
 *    coming Monday — and the manager is asked to confirm (`needsConfirmation`).
 * Pure functions: no clock, no timezone; callers pass `today` (YYYY-MM-DD, venue-local).
 */
import type { WeekDetection } from './rosterContract.js';

/** Monday = 0 … Sunday = 6. */
const WEEKDAY: Record<string, number> = {
  monday: 0, mon: 0,
  tuesday: 1, tues: 1, tue: 1,
  wednesday: 2, weds: 2, wed: 2,
  thursday: 3, thurs: 3, thur: 3, thu: 3,
  friday: 4, fri: 4,
  saturday: 5, sat: 5,
  sunday: 6, sun: 6,
};
const MONTH: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};
const WEEKDAY_WORD = Object.keys(WEEKDAY).sort((a, b) => b.length - a.length).join('|');
const MONTH_WORD = Object.keys(MONTH).sort((a, b) => b.length - a.length).join('|');
const ORD = '(?:st|nd|rd|th)?';

/** What one day-column header prints. Every field is optional; at least one is set. */
export interface DayLabel {
  /** Monday = 0 … Sunday = 6. */
  weekday: number | null;
  day: number | null;
  month: number | null;
  year: number | null;
  /** Only digits ("17/08"): also reads as a shift time ("17-08"), so it counts as a header only in a run of consecutive days. */
  numericOnly: boolean;
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function label(weekday: number | null, day: number | null, month: number | null, year: number | null, numericOnly = false): DayLabel | null {
  if (day !== null && (day < 1 || day > 31)) return null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (year !== null && year < 100) year += 2000;
  if (weekday === null && day === null) return null;
  return { weekday, day, month, year, numericOnly };
}

/**
 * Reads one day-header cell. Accepts a Date (spreadsheet date cell), an Excel serial, ISO and
 * day-first numeric dates, month names before or after the day, ordinals, a weekday before or
 * after, and weekday names alone. Returns null for anything else (names, times, captions).
 */
export function parseDayLabel(value: unknown): DayLabel | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return label((value.getUTCDay() + 6) % 7, value.getUTCDate(), value.getUTCMonth() + 1, value.getUTCFullYear());
  }
  if (typeof value === 'number') {
    // A spreadsheet date serial (2000-01-01 … 2063); small numbers are counts, not dates.
    if (!Number.isInteger(value) || value < 36_526 || value > 59_000) return null;
    return parseDayLabel(new Date(EXCEL_EPOCH_MS + value * 86_400_000));
  }
  if (typeof value !== 'string') return null;
  let text = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text || text.length > 40) return null;

  // A weekday at either end ("mon 17/08", "17-aug monday", "monday, 17 august 2026").
  let weekday: number | null = null;
  const lead = text.match(new RegExp(`^(${WEEKDAY_WORD})\\.?,?(?:\\s+|$)`));
  if (lead) {
    weekday = WEEKDAY[lead[1]!]!;
    text = text.slice(lead[0].length).trim();
  } else {
    const trail = text.match(new RegExp(`[\\s,]+(${WEEKDAY_WORD})\\.?$`));
    if (trail) {
      weekday = WEEKDAY[trail[1]!]!;
      text = text.slice(0, trail.index).trim();
    }
  }
  text = text.replace(/^[,(]+|[,)]+$/g, '').trim();
  if (!text) return weekday === null ? null : label(weekday, null, null, null);

  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return label(weekday, +m[3]!, +m[2]!, +m[1]!);
  m = text.match(/^(\d{1,2})\s*([/.-])\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2}|\d{4}))?$/);
  // "18.5" is a decimal hour, not 18 May: a dotted day.month counts only with a weekday or a year.
  if (m && !(m[2] === '.' && weekday === null && !m[4])) return label(weekday, +m[1]!, +m[3]!, m[4] ? +m[4] : null, weekday === null && !m[4]);
  m = text.match(new RegExp(`^(\\d{1,2})${ORD}(?:\\s*[-/.\\s]\\s*|\\s+of\\s+)(${MONTH_WORD})\\.?(?:[\\s,/.-]+(\\d{2}|\\d{4}))?$`));
  if (m) return label(weekday, +m[1]!, MONTH[m[2]!]!, m[3] ? +m[3] : null);
  m = text.match(new RegExp(`^(${MONTH_WORD})\\.?[\\s-]+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?$`));
  if (m) return label(weekday, +m[2]!, MONTH[m[1]!]!, m[3] ? +m[3] : null);
  // A day number alone beside a weekday ("Mon 24", "Monday 24th").
  m = text.match(new RegExp(`^(\\d{1,2})${ORD}$`));
  if (m && weekday !== null) return label(weekday, +m[1]!, null, null);
  return null;
}

/** A date printed in a title or caption: "Rota 24 - 30 Aug", "Week of 24/08", "w/c 24th August 2026". */
export function parseTitleDate(text: string): { day: number; month: number; year: number | null } | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  const tries: [RegExp, (m: RegExpMatchArray) => [number, number, string | undefined]][] = [
    // "24 - 30 aug", "24th to 30th august 2026"
    [new RegExp(`\\b(\\d{1,2})${ORD}\\s*(?:-|–|to)\\s*\\d{1,2}${ORD}\\s+(${MONTH_WORD})\\b\\.?(?:\\s+(\\d{4}))?`), (m) => [+m[1]!, MONTH[m[2]!]!, m[3]]],
    // "24 aug", "24th of august 2026"
    [new RegExp(`\\b(\\d{1,2})${ORD}\\s*(?:of\\s+)?[-\\s]?(${MONTH_WORD})\\b\\.?(?:[\\s,]+(\\d{4}))?`), (m) => [+m[1]!, MONTH[m[2]!]!, m[3]]],
    // "aug 24", "august 24th, 2026"
    [new RegExp(`\\b(${MONTH_WORD})\\.?\\s+(\\d{1,2})${ORD}\\b(?:,?\\s+(\\d{4}))?`), (m) => [+m[2]!, MONTH[m[1]!]!, m[3]]],
    // "24/08", "24.08.2026"
    [/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/, (m) => [+m[1]!, +m[2]!, m[3]]],
  ];
  for (const [re, read] of tries) {
    const m = t.match(re);
    if (!m) continue;
    const [day, month, y] = read(m);
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : null;
    return { day, month, year };
  }
  return null;
}

// --- calendar helpers (UTC calendar days, no timezone) ----------------------------------------

const DAY_MS = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => toIso(toMs(iso) + n * DAY_MS);
/** Monday = 0 … Sunday = 6. */
export const weekdayOf = (iso: string) => (new Date(toMs(iso)).getUTCDay() + 6) % 7;
export const mondayOfIso = (iso: string) => addDays(iso, -weekdayOf(iso));
const validDate = (y: number, m: number, d: number) => {
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return toIso(toMs(iso)) === iso ? iso : null;
};

/** The Monday on or after `today`: where a weekday-only roster lands when nothing else says. */
export function comingMonday(today: string): string {
  return addDays(today, (7 - weekdayOf(today)) % 7);
}

export interface WeekContext {
  /** Today in the venue's timezone (YYYY-MM-DD): the reference for an unprinted year. */
  today: string;
  /** The Monday the client asked for, used only when the roster prints no dates. */
  clientWeekStart?: string | null;
}

export interface WeekResult {
  week: WeekDetection;
  /** ISO date of each column (null where a column prints nothing usable). */
  dates: (string | null)[];
}

/** The ISO Monday of the week holding most of the dates (a Sun–Sat roster lands on the Mon–Sat week). */
function weekOfDates(dates: string[]): string {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(mondayOfIso(d), (counts.get(mondayOfIso(d)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]![0];
}

function detection(weekStart: string, source: WeekDetection['source'], printedLabel: string | null, needsConfirmation: boolean, reason: string | null): WeekDetection {
  return { weekStart, weekEnd: addDays(weekStart, 6), source, printedLabel, needsConfirmation, reason };
}

/** Lays weekday-only columns out as consecutive days, the first one nearest to `anchor`. */
function datesFromWeekdays(labels: (DayLabel | null)[], anchor: string): (string | null)[] {
  const out: (string | null)[] = [];
  let prev: string | null = null;
  for (const l of labels) {
    if (!l || l.weekday === null) {
      out.push(null);
      continue;
    }
    let date: string;
    if (prev === null) {
      const delta = ((l.weekday - weekdayOf(anchor) + 10) % 7) - 3; // −3 … +3 days from the anchor
      date = addDays(anchor, delta);
    } else {
      date = addDays(prev, ((l.weekday - weekdayOf(prev) + 6) % 7) + 1);
    }
    out.push(date);
    prev = date;
  }
  return out;
}

/**
 * Dates every column from what is printed. `labels` are the day columns' parsed headers (null
 * for a column that prints nothing usable); `titles` are lines printed above the grid.
 */
export function detectWeek(labels: (DayLabel | null)[], titles: string[], ctx: WeekContext): WeekResult {
  const printed = labels.filter((l): l is DayLabel => l !== null);
  const dated = labels.map((l, i) => ({ l, i })).filter(({ l }) => l && l.day !== null && l.month !== null) as { l: DayLabel; i: number }[];

  if (dated.length > 0) {
    const first = dated[0]!;
    const years = first.l.year !== null ? [first.l.year] : [Number(ctx.today.slice(0, 4)) - 1, Number(ctx.today.slice(0, 4)), Number(ctx.today.slice(0, 4)) + 1];
    let best: { dates: (string | null)[]; matches: number; distance: number } | null = null;
    for (const y of years) {
      const dates: (string | null)[] = labels.map(() => null);
      let prev: string | null = null;
      let ok = true;
      for (const { l, i } of dated) {
        let date: string | null = null;
        if (l.year !== null) date = validDate(l.year, l.month!, l.day!);
        else if (prev === null) date = validDate(y, l.month!, l.day!);
        else {
          // The next printed date at or after the previous one (a roster crossing New Year moves on a year).
          const py = Number(prev.slice(0, 4));
          for (const cy of [py, py + 1]) {
            const c = validDate(cy, l.month!, l.day!);
            if (c && c >= prev) {
              date = c;
              break;
            }
          }
        }
        if (!date) {
          ok = false;
          break;
        }
        dates[i] = date;
        prev = date;
      }
      if (!ok) continue;
      // Columns that print only a weekday sit between dated neighbours.
      labels.forEach((l, i) => {
        if (dates[i] || !l || l.weekday === null) return;
        const before = dates.slice(0, i).reverse().find((d) => d);
        if (before) dates[i] = addDays(before, ((l.weekday - weekdayOf(before) + 6) % 7) + 1);
      });
      const withWeekday = labels.map((l, i) => ({ l, d: dates[i] })).filter(({ l, d }) => l?.weekday != null && d);
      const matches = withWeekday.filter(({ l, d }) => weekdayOf(d!) === l!.weekday).length;
      const distance = Math.abs(toMs(dates[first.i]!) - toMs(ctx.today));
      if (!best || matches > best.matches || (matches === best.matches && distance < best.distance)) best = { dates, matches, distance };
    }
    if (best) {
      const known = best.dates.filter((d): d is string => d !== null);
      const weekStart = weekOfDates(known);
      const withWeekday = labels.filter((l) => l?.weekday != null).length;
      const span = `${known[0]} … ${known[known.length - 1]}`;
      if (withWeekday > 0 && best.matches < withWeekday) {
        return {
          week: detection(weekStart, 'printed_dates', span, true, "The printed weekdays don't match the printed dates for any nearby year. Check the week before confirming."),
          dates: best.dates,
        };
      }
      const farOff = withWeekday === 0 && first.l.year === null && best.distance > 183 * DAY_MS;
      return {
        week: detection(weekStart, 'printed_dates', span, farOff, farOff ? 'No year is printed and these dates are far from today. Check the year before confirming.' : null),
        dates: best.dates,
      };
    }
  }

  // Day numbers with weekdays but no month ("Mon 24"): the month comes from a title, else the
  // nearest month in which those days fall on those weekdays.
  const dayOnly = labels.map((l, i) => ({ l, i })).filter(({ l }) => l && l.day !== null && l.month === null && l.weekday !== null) as { l: DayLabel; i: number }[];
  const titleDate = titles.map(parseTitleDate).find((t) => t !== null) ?? null;
  if (dayOnly.length > 0) {
    const first = dayOnly[0]!;
    const candidates: string[] = [];
    const ty = Number(ctx.today.slice(0, 4));
    for (const y of [ty - 1, ty, ty + 1]) {
      for (let m = 1; m <= 12; m++) {
        if (titleDate && titleDate.month !== m) continue;
        const c = validDate(titleDate?.year ?? y, m, first.l.day!);
        if (c && weekdayOf(c) === first.l.weekday) candidates.push(c);
      }
    }
    if (candidates.length) {
      const start = [...new Set(candidates)].sort((a, b) => Math.abs(toMs(a) - toMs(ctx.today)) - Math.abs(toMs(b) - toMs(ctx.today)))[0]!;
      const anchored = labels.map(() => null as string | null);
      anchored[first.i] = start;
      labels.forEach((l, i) => {
        if (i <= first.i || !l || l.weekday === null) return;
        const before = anchored.slice(0, i).reverse().find((d) => d)!;
        anchored[i] = addDays(before, ((l.weekday - weekdayOf(before) + 6) % 7) + 1);
      });
      const known = anchored.filter((d): d is string => d !== null);
      return {
        week: detection(weekOfDates(known), titleDate ? 'title' : 'printed_dates', titles.find((t) => parseTitleDate(t)) ?? `${known[0]} …`, !titleDate, titleDate ? null : 'The roster prints day numbers without a month. Check the week before confirming.'),
        dates: anchored,
      };
    }
  }

  const weekdays = printed.filter((l) => l.weekday !== null);
  if (weekdays.length === 0) {
    const start = ctx.clientWeekStart ?? comingMonday(ctx.today);
    return { week: detection(start, 'none', null, !ctx.clientWeekStart, ctx.clientWeekStart ? null : 'The roster prints no dates. Check the week before confirming.'), dates: labels.map(() => null) };
  }

  if (titleDate) {
    // Anchor the first weekday column on the title's date, in the year where they agree.
    const firstWeekday = weekdays[0]!.weekday!;
    const ty = Number(ctx.today.slice(0, 4));
    const years = titleDate.year !== null ? [titleDate.year] : [ty - 1, ty, ty + 1];
    const options = years.map((y) => validDate(y, titleDate.month, titleDate.day)).filter((d): d is string => d !== null);
    const agreeing = options.filter((d) => weekdayOf(d) === firstWeekday);
    const pool = agreeing.length ? agreeing : options;
    const anchor = pool.sort((a, b) => Math.abs(toMs(a) - toMs(ctx.today)) - Math.abs(toMs(b) - toMs(ctx.today)))[0];
    if (anchor) {
      const dates = datesFromWeekdays(labels, anchor);
      const known = dates.filter((d): d is string => d !== null);
      const title = titles.find((t) => parseTitleDate(t)) ?? null;
      return {
        week: detection(weekOfDates(known), 'title', title, !agreeing.length, agreeing.length ? null : "The title's date doesn't fall on the first day printed. Check the week before confirming."),
        dates,
      };
    }
  }

  const anchor = ctx.clientWeekStart ?? comingMonday(ctx.today);
  const dates = datesFromWeekdays(labels, anchor);
  return {
    week: detection(
      weekOfDates(dates.filter((d): d is string => d !== null)),
      'weekday_only',
      null,
      !ctx.clientWeekStart,
      ctx.clientWeekStart ? null : 'This roster only shows weekday names, so it was placed in the coming week. Check the week before confirming.',
    ),
    dates,
  };
}

/** True when a run of labels reads as consecutive days (how a numeric-only date row proves it is a header). */
export function isConsecutiveDayRun(labels: DayLabel[]): boolean {
  if (labels.length < 2) return false;
  for (let i = 1; i < labels.length; i++) {
    const a = labels[i - 1]!;
    const b = labels[i]!;
    if (a.day === null || b.day === null) return false;
    const sameMonth = a.month === b.month && b.day === a.day + 1;
    const nextMonth = b.day === 1 && a.day >= 28 && (b.month === (a.month! % 12) + 1);
    if (!sameMonth && !nextMonth) return false;
  }
  return true;
}
