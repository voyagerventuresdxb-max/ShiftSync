/**
 * Text-block roster parser (PDF text extraction, pasted text, WhatsApp
 * forwards). Mirrors the frontend engine's line-oriented strategy but emits
 * the server's canonical `ParsedShiftRow[]` contract so PDFs flow through the
 * exact same DB-resolution + preview pipeline as Excel/CSV uploads.
 *
 * Strategy: each line is classified as a header (day name), a shift
 * assignment ("Maria 6pm-2am Fri"), or noise. Shift lines are tokenized into
 * name, time range, and day, then normalized with the same server helpers
 * used by the workbook parser (parseDateCell/parseTimeCell/...). The week
 * comes from a title line that names it ("Week of 24/08", "Rota 24 - 30 Aug")
 * when the text has one (weekDetection.ts), never from the upload date alone.
 */

import { currentVenueWeekStart } from '../lib/venueWeek.js';
import { DEFAULT_VENUE_TIMEZONE } from './normalize.js';
import { isOvernight, parseTimeCell } from './normalize.js';
import { detectWeek, parseDayLabel, parseTitleDate, type DayLabel } from './weekDetection.js';
import type { WeekDetection } from './rosterContract.js';
import { nonPersonReason } from './personKey.js';
import type { ParsedShiftRow, RowIssue } from './types.js';

/** A weekday as a whole word ("Fri"), never inside a name ("Simon", "Sunil", "Monica"). */
const DAY_WORD = /\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b/gi;

const TIME_TOKEN =
  /(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|\d{3,4})/gi;
/** Same pattern, not global: safe for `.test` (a global regex keeps state between calls). */
const HAS_TIME = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|\d{3,4})/i;

interface ParsedLine {
  employeeName: string;
  role?: string;
  start: string;
  end: string;
  dayName: string;
  raw: string;
}

export interface TextWeekContext {
  /** Today in the venue's timezone (YYYY-MM-DD). */
  today: string;
  /** The week the client asked for; used only when the text names no week. */
  clientWeekStart: string | null;
}

/**
 * Parse a roster text block into ParsedShiftRow[].
 * @param text Raw text extracted from a PDF (or pasted).
 * @param weekStart ISO date (YYYY-MM-DD) of the week's Monday, used for day names when the text
 *                  names no week of its own (and as "today" when `ctx` is not given).
 */
export function parseRosterText(
  text: string,
  weekStart: string,
  ctx: TextWeekContext = { today: weekStart, clientWeekStart: weekStart },
): { rows: ParsedShiftRow[]; issues: RowIssue[]; week: WeekDetection } {
  const issues: RowIssue[] = [];
  const rows: ParsedShiftRow[] = [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // The week: a line that names it ("Week of 24/08", "Rota 24 - 30 Aug") anchors the day names.
  const titles = lines.filter((l) => !HAS_TIME.test(l) && parseTitleDate(l) !== null);
  const monday: DayLabel = { weekday: 0, day: null, month: null, year: null, numericOnly: false };
  const anchor = detectWeek([monday], titles.slice(0, 1), ctx);
  const week = anchor.week;

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const parsed = parseLine(raw);
    if (!parsed) {
      // A line that looks like it was meant to be a shift but failed to parse.
      if (looksLikeShift(raw)) {
        issues.push({
          rowNumber: lineNumber,
          severity: 'warning',
          message: `Could not parse line: "${raw}"`,
        });
      }
      return;
    }

    const isoDate = dayToDate(week.weekStart, parsed.dayName);
    if (!isoDate) {
      issues.push({
        rowNumber: lineNumber,
        severity: 'warning',
        message: `Unknown day "${parsed.dayName}" on line: ${raw}`,
      });
      return;
    }

    // A footer or sign-off line that happens to carry a date and a time is no one's shift.
    if (parsed.employeeName && nonPersonReason(parsed.employeeName)) return;

    const rowNumber = rows.length + 1;
    const rowIssues: RowIssue[] = [];
    if (!parsed.employeeName) {
      rowIssues.push({ rowNumber, field: 'employeeName', severity: 'error', message: 'Employee name is missing.' });
    }
    if (!parsed.role) {
      // Not blocking: the shift is kept and the role is assigned on the review screen.
      rowIssues.push({ rowNumber, field: 'role', severity: 'warning', message: `No role for "${parsed.employeeName}" — assign one on the review screen.` });
    }
    if (parsed.start === parsed.end) {
      rowIssues.push({ rowNumber, field: 'endTime', severity: 'error', message: 'Start time and end time are identical (zero-length shift).' });
    }
    issues.push(...rowIssues);

    const hasBlockingError = rowIssues.some((i) => i.severity === 'error');
    if (hasBlockingError) return;

    rows.push({
      rowNumber,
      employeeName: parsed.employeeName,
      roleName: parsed.role ?? '',
      date: isoDate,
      startTime: parsed.start,
      endTime: parsed.end,
      overnight: isOvernight(parsed.start, parsed.end),
      breakMinutes: 0,
      managerNotes: null,
    });
  });

  return { rows, issues, week };
}

/** Parse a single line into a ParsedLine, or null if it is not a shift line. */
function parseLine(raw: string): ParsedLine | null {
  if (isHeaderLine(raw)) return null;

  const times = [...raw.matchAll(TIME_TOKEN)].map((m) => m[0]);
  if (times.length < 2) return null;

  const start = parseTimeCell(normalizeTimeToken(times[0]));
  const end = parseTimeCell(normalizeTimeToken(times[1]));
  if (!start || !end) return null;

  // Everything before the first time token is the name (and possibly role).
  const firstTimeIndex = raw.indexOf(times[0]);
  const namePart = raw.slice(0, firstTimeIndex).trim();
  if (!namePart) return null;

  // The day: a weekday word after the times, else one in the name part that is not the name.
  const after = [...raw.slice(firstTimeIndex).matchAll(DAY_WORD)].map((m) => m[0]);
  const before = [...namePart.matchAll(DAY_WORD)].map((m) => ({ word: m[0], index: m.index! }));
  let dayName = after[0];
  let nameText = namePart;
  if (!dayName && before.length) {
    // "Fri Maria 6pm-2am" or "Maria Fri 6pm-2am": the day word is taken out of the name.
    const day = before[before.length - 1]!;
    dayName = day.word;
    nameText = `${namePart.slice(0, day.index)} ${namePart.slice(day.index + day.word.length)}`.replace(/\s+/g, ' ').trim();
  }
  if (!dayName || !nameText) return null;

  const { name, role } = splitNameRole(nameText);

  return {
    employeeName: name,
    role,
    start,
    end,
    dayName,
    raw,
  };
}

/** Common hospitality role labels that may trail the name in a text line, longest first. */
const ROLE_LABELS = [
  'floor staff',
  'bartender',
  'waitress',
  'supervisor',
  'hostess',
  'manager',
  'kitchen',
  'barista',
  'server',
  'waiter',
  'runner',
  'busser',
  'chef',
  'cook',
  'host',
  'bar',
];

/** Split a name-part into employee name and optional role label (a whole word, never part of a name). */
function splitNameRole(namePart: string): { name: string; role?: string } {
  for (const label of ROLE_LABELS) {
    const re = new RegExp(`(?:^|[\\s\\-–—|,(])${label}(?=$|[\\s\\-–—|,)])`, 'i');
    const m = namePart.match(re);
    if (!m) continue;
    const name = `${namePart.slice(0, m.index)} ${namePart.slice(m.index! + m[0].length)}`
      .replace(/[-–—|,()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (name) return { name, role: label };
  }
  return { name: namePart.replace(/[-–—|,]+\s*$/, '').trim() };
}

/**
 * Normalize a bare AM/PM time token ("5pm", "9am") into a colon form
 * ("5:00pm") that parseTimeCell understands. Leaves colon forms and 24h
 * times untouched.
 */
function normalizeTimeToken(token: string): string {
  const m = token.match(/^(\d{1,2})\s*(am|pm)$/i);
  if (m) return `${m[1]}:00${m[2].toLowerCase()}`;
  return token;
}

/** True for header/noise lines that should be skipped. */
function isHeaderLine(raw: string): boolean {
  const lower = raw.toLowerCase();
  if (/^(roster|rota|schedule|week of|week starting|shift|staff|team)/i.test(lower)) {
    return true;
  }
  // A line that is only a day name (e.g. "Monday").
  const day = parseDayLabel(raw);
  if (day && day.day === null) return true;
  return false;
}

/** Heuristic: does this line look like it was meant to be a shift? */
function looksLikeShift(raw: string): boolean {
  DAY_WORD.lastIndex = 0;
  const found = DAY_WORD.test(raw) && /\d/.test(raw);
  DAY_WORD.lastIndex = 0;
  return found;
}

const DAY_OFFSET: Record<string, number> = {
  monday: 0, mon: 0, tuesday: 1, tues: 1, tue: 1, wednesday: 2, wed: 2, thursday: 3, thurs: 3, thu: 3,
  friday: 4, fri: 4, saturday: 5, sat: 5, sunday: 6, sun: 6,
};

/** Resolve a day name to an ISO date within the week starting at weekStart (a Monday). */
function dayToDate(weekStart: string, dayName: string): string | null {
  const offset = DAY_OFFSET[dayName.trim().toLowerCase()];
  if (offset === undefined) return null;
  const base = new Date(`${weekStart}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

/**
 * Default week start: the MONDAY of the current week in the venue's timezone
 * (the same rule as the frontend's `src/engine/weekStart.ts`). This used to
 * be the Sunday of the week in the process-local timezone, which on a UTC
 * host disagreed with every Monday-based week the client shows, and put a
 * Sunday roster column into the previous week.
 */
export function currentWeekStart(now: Date = new Date(), timezone: string = DEFAULT_VENUE_TIMEZONE): string {
  return currentVenueWeekStart(now, timezone);
}
