/**
 * Text-block roster parser (PDF text extraction, pasted text, WhatsApp
 * forwards). Mirrors the frontend engine's line-oriented strategy but emits
 * the server's canonical `ParsedShiftRow[]` contract so PDFs flow through the
 * exact same DB-resolution + preview pipeline as Excel/CSV uploads.
 *
 * Strategy: each line is classified as a header (day name), a shift
 * assignment ("Maria 6pm-2am Fri"), or noise. Shift lines are tokenized into
 * name, time range, and day, then normalized with the same server helpers
 * used by the workbook parser (parseDateCell/parseTimeCell/...).
 */

import { isOvernight, parseTimeCell } from './normalize.js';
import type { ParsedShiftRow, RowIssue } from './types.js';

const DAY_NAMES =
  /(sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat)/i;

const TIME_TOKEN =
  /(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|\d{3,4})/gi;

/** Day-name -> offset from the week's first day (Sunday = 0). */
const DAY_OFFSET: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

interface ParsedLine {
  employeeName: string;
  role?: string;
  start: string;
  end: string;
  dayName: string;
  raw: string;
}

/**
 * Parse a roster text block into ParsedShiftRow[].
 * @param text Raw text extracted from a PDF (or pasted).
 * @param weekStart ISO date (YYYY-MM-DD) of the first day of the roster week.
 *                  Day names in the text are resolved against this week.
 */
export function parseRosterText(
  text: string,
  weekStart: string,
): { rows: ParsedShiftRow[]; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const rows: ParsedShiftRow[] = [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const raw of lines) {
    const parsed = parseLine(raw);
    if (!parsed) {
      // A line that looks like it was meant to be a shift but failed to parse.
      if (looksLikeShift(raw)) {
        issues.push({
          rowNumber: 0,
          severity: 'warning',
          message: `Could not parse line: "${raw}"`,
        });
      }
      continue;
    }

    const isoDate = dayToDate(weekStart, parsed.dayName);
    if (!isoDate) {
      issues.push({
        rowNumber: 0,
        severity: 'warning',
        message: `Unknown day "${parsed.dayName}" on line: ${raw}`,
      });
      continue;
    }

    const rowIssues: RowIssue[] = [];
    if (!parsed.employeeName) {
      rowIssues.push({ rowNumber: 0, field: 'employeeName', severity: 'error', message: 'Employee name is missing.' });
    }
    if (!parsed.role) {
      rowIssues.push({ rowNumber: 0, field: 'role', severity: 'error', message: 'Role is missing.' });
    }
    if (parsed.start === parsed.end) {
      rowIssues.push({ rowNumber: 0, field: 'endTime', severity: 'error', message: 'Start time and end time are identical (zero-length shift).' });
    }
    issues.push(...rowIssues);

    const hasBlockingError = rowIssues.some((i) => i.severity === 'error');
    if (hasBlockingError) continue;

    rows.push({
      rowNumber: 0,
      employeeName: parsed.employeeName,
      roleName: parsed.role ?? 'staff',
      date: isoDate,
      startTime: parsed.start,
      endTime: parsed.end,
      overnight: isOvernight(parsed.start, parsed.end),
      breakMinutes: 0,
      managerNotes: null,
    });
  }

  return { rows, issues };
}

/** Parse a single line into a ParsedLine, or null if it is not a shift line. */
function parseLine(raw: string): ParsedLine | null {
  if (isHeaderLine(raw)) return null;

  const dayMatch = raw.match(DAY_NAMES);
  if (!dayMatch) return null;

  const times = [...raw.matchAll(TIME_TOKEN)].map((m) => m[0]);
  if (times.length < 2) return null;

  const start = parseTimeCell(normalizeTimeToken(times[0]));
  const end = parseTimeCell(normalizeTimeToken(times[1]));
  if (!start || !end) return null;

  // Everything before the first time token is the name (and possibly role).
  const firstTimeIndex = raw.indexOf(times[0]);
  const namePart = raw.slice(0, firstTimeIndex).trim();
  if (!namePart) return null;

  const { name, role } = splitNameRole(namePart);

  return {
    employeeName: name,
    role,
    start,
    end,
    dayName: dayMatch[0],
    raw,
  };
}

/** Split a name-part into employee name and optional role label. */
function splitNameRole(namePart: string): { name: string; role?: string } {
  // Common hospitality role labels that may trail the name in a text line.
  const roleLabels = [
    'bartender',
    'server',
    'waiter',
    'waitress',
    'chef',
    'cook',
    'host',
    'hostess',
    'runner',
    'busser',
    'barista',
    'floor staff',
    'kitchen',
    'bar',
    'manager',
    'supervisor',
  ];
  const lower = namePart.toLowerCase();
  for (const label of roleLabels) {
    if (lower.includes(label)) {
      const name = namePart
        .replace(new RegExp(label, 'i'), '')
        .replace(/[-–—|,]/g, '')
        .trim();
      return { name, role: label };
    }
  }
  return { name: namePart };
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
  if (/^(roster|schedule|week of|week starting|shift|staff|team)/i.test(lower)) {
    return true;
  }
  // A line that is only a day name (e.g. "Monday").
  if (/^(sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat)$/i.test(lower)) {
    return true;
  }
  return false;
}

/** Heuristic: does this line look like it was meant to be a shift? */
function looksLikeShift(raw: string): boolean {
  return DAY_NAMES.test(raw) && /\d/.test(raw);
}

/** Resolve a day name to an ISO date within the week starting at weekStart. */
function dayToDate(weekStart: string, dayName: string): string | null {
  const key = dayName.trim().toLowerCase();
  const targetOffset = DAY_OFFSET[key];
  if (targetOffset === undefined) return null;

  const [y, m, d] = weekStart.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  const startOffset = base.getDay(); // Sunday=0..Saturday=6
  const delta = (targetOffset - startOffset + 7) % 7;
  base.setDate(base.getDate() + delta);

  const yy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Default week start: the Sunday of the current week (matches frontend). */
export function currentWeekStart(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - d.getDay()); // back to Sunday
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
