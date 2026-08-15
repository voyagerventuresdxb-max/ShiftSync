/**
 * ShiftSync text-block parser engine.
 *
 * Turns an "ugly" pasted roster (WhatsApp-forwarded text, Excel text export,
 * mixed languages) into a clean, structured Roster in well under 10 seconds.
 *
 * Strategy: line-oriented. Each line is classified as either a header (day
 * name), a shift assignment ("Maria 6pm-2am Fri"), or noise. Shift lines are
 * tokenized into name, time range, and day, then normalized against the
 * venue config (known staff, role labels, shift-type labels).
 */

import type {
  Employee,
  ParseResult,
  Roster,
  Shift,
  ShiftType,
  VenueConfig,
} from './types';
import { dayToDate, isOvernight, parseTime } from './time';

/** A single parsed shift line. */
interface ParsedLine {
  employeeName: string;
  role?: string;
  start: string;
  end: string;
  dayName: string;
  type: ShiftType;
  raw: string;
}

const DAY_NAMES =
  /(sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat)/i;

const TIME_TOKEN =
  /(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|\d{3,4})/gi;

/**
 * Parse a pasted roster text block into a structured Roster.
 * @param text Raw pasted text.
 * @param config Venue configuration (drives parsing + compliance).
 * @param weekStart ISO date of the first day of the roster week.
 */
export function parseRosterText(
  text: string,
  config: VenueConfig,
  weekStart: string,
): ParseResult {
  const started = performance.now();
  const warnings: string[] = [];
  const unparsedLines: string[] = [];
  const employees = new Map<string, Employee>();
  const shifts: Shift[] = [];
  const knownStaff = new Set((config.knownStaff ?? []).map(normalizeName));

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const raw of lines) {
    const parsed = parseLine(raw, config);
    if (!parsed) {
      // A line that looks like it should be a shift but failed to parse.
      if (looksLikeShift(raw)) unparsedLines.push(raw);
      continue;
    }

    const date = dayToDate(weekStart, parsed.dayName);
    if (!date) {
      warnings.push(`Unknown day "${parsed.dayName}" on line: ${raw}`);
      continue;
    }

    const key = normalizeName(parsed.employeeName);
    let emp = employees.get(key);
    if (!emp) {
      emp = {
        id: `emp-${employees.size + 1}`,
        name: parsed.employeeName,
        role: parsed.role ?? 'staff',
        status: 'active',
      };
      employees.set(key, emp);
    } else if (parsed.role && !emp.role) {
      emp.role = parsed.role;
    }

    shifts.push({
      id: `shift-${shifts.length + 1}`,
      employeeId: emp.id,
      date,
      start: parsed.start,
      end: parsed.end,
      type: parsed.type,
      overnight: isOvernight(parsed.start, parsed.end),
      source: raw,
    });

    if (knownStaff.size > 0 && !knownStaff.has(key)) {
      warnings.push(`Unrecognized staff name "${parsed.employeeName}"`);
    }
  }

  const roster: Roster = {
    id: `roster-${Date.now()}`,
    venueId: config.id,
    weekStart,
    employees: [...employees.values()],
    shifts,
    createdAt: new Date().toISOString(),
  };

  return {
    roster,
    warnings,
    unparsedLines,
    durationMs: Math.round(performance.now() - started),
  };
}

/** Parse a single line into a ParsedLine, or null if it is not a shift line. */
function parseLine(raw: string, config: VenueConfig): ParsedLine | null {
  // Skip pure header/noise lines (day-only, "roster", "week of", etc.).
  if (isHeaderLine(raw)) return null;

  const dayMatch = raw.match(DAY_NAMES);
  if (!dayMatch) return null;

  const times = [...raw.matchAll(TIME_TOKEN)].map((m) => m[0]);
  if (times.length < 2) return null;

  const start = parseTime(times[0]);
  const end = parseTime(times[1]);
  if (!start || !end) return null;

  // Everything before the first time token is the name (and possibly role).
  const firstTimeIndex = raw.indexOf(times[0]);
  const namePart = raw.slice(0, firstTimeIndex).trim();
  if (!namePart) return null;

  const { name, role } = splitNameRole(namePart, config);

  return {
    employeeName: name,
    role,
    start,
    end,
    dayName: dayMatch[0],
    type: detectShiftType(raw, config),
    raw,
  };
}

/** Split a name-part into employee name and optional role label. */
function splitNameRole(
  namePart: string,
  config: VenueConfig,
): { name: string; role?: string } {
  const lower = namePart.toLowerCase();
  for (const label of config.roleLabels) {
    if (lower.includes(label.toLowerCase())) {
      const name = namePart
        .replace(new RegExp(label, 'i'), '')
        .replace(/[-–—|,]/g, '')
        .trim();
      return { name, role: label };
    }
  }
  return { name: namePart };
}

/** Detect the shift type from role/shift-type labels in the line. */
function detectShiftType(raw: string, config: VenueConfig): ShiftType {
  const lower = raw.toLowerCase();
  for (const [label, type] of Object.entries(config.shiftTypeLabels)) {
    if (lower.includes(label.toLowerCase())) return type;
  }
  return 'other';
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

/** Normalize a name for matching (lowercase, strip punctuation/spaces). */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}
