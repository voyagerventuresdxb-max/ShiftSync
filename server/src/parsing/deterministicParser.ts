/**
 * Deterministic, venue-agnostic roster parser used as a local fallback when
 * the live Gemini VLM is unavailable (429 rate-limit/quota, 503 overload, or
 * no API key). Unlike the VLM path, this makes NO network calls and NO
 * layout assumptions — it heuristically parses any Excel/CSV/PDF-text roster
 * into ShiftSync's canonical row/issue contracts.
 *
 * It handles:
 *  - Multi-segmented split shifts in one cell ("10am/3pm-7pm/12am",
 *    "10:00-15:00/17:00-00:00", "9-13/18-23")
 *  - 12-hour (am/pm) and 24-hour time formats
 *  - Venue-agnostic role categorization (Manager/Supervisor/Head Waiter/
 *    Waiter/Runner) via keyword matching
 *  - Leave/absence codes (Off, A/L, PH, Sick, etc.)
 */
import * as XLSX from 'xlsx';
import { cellToText, isOvernight } from './normalize.js';
import { detectWeek, parseDayLabel } from './weekDetection.js';
import { readWorkbook } from './parseWorkbook.js';
import type { ParsedShiftRow, ParsedVisionResult, RowIssue } from './types.js';

/** Standardized role categories to prevent generic "Floor" labels. */
const ROLE_HIERARCHY: Record<string, string[]> = {
  MANAGER: ['manager', 'general manager', 'gm', 'assistant manager', 'asst manager', 'floor manager', 'duty manager', 'operations manager'],
  SUPERVISOR: ['supervisor', 'head host', 'maitre d', 'head receptionist', 'team leader', 'team lead'],
  HEAD_WAITER: ['head waiter', 'captain', 'senior waiter', 'section waiter', 'head server'],
  WAITER: ['waiter', 'server', 'barback', 'bartender', 'barista', 'hostess', 'host', 'floor', 'floor staff', 'foh'],
  RUNNER: ['runner', 'food runner', 'busser', 'bar runner'],
};

/** Resolves a raw title string into a structured role category. */
export function resolveRoleCategory(rawTitle = ''): string {
  const normalized = rawTitle.toLowerCase().trim();
  for (const [category, keywords] of Object.entries(ROLE_HIERARCHY)) {
    for (const keyword of keywords) {
      if (normalized.includes(keyword)) {
        return category;
      }
    }
  }
  return 'WAITER'; // Fallback default category
}

/** Converts a 12h/24h time token to 24h "HH:mm". Returns null if unparseable. */
export function normalizeTime(timeStr: string): string | null {
  const raw = timeStr.trim().toLowerCase();
  if (!raw) return null;

  // Match "10", "10:30", "10am", "10:30am", "3pm", "12am", "12pm", "00:00"
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3];

  if (meridiem) {
    if (meridiem === 'am') {
      if (hour === 12) hour = 0; // 12am = 00:00
    } else {
      // pm
      if (hour !== 12) hour += 12; // 12pm stays 12
    }
  } else {
    // 24-hour format; hour 24 means midnight (00:00)
    if (hour === 24) hour = 0;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Parses a single shift cell into structured intervals.
 * Handles: "10:00-15:00/17:00-00:00", "10am-3pm", "10am/3pm-7pm/12am",
 * "Off", "Annual Leave", "A/L", "PH", "Sick", "-".
 */
export function parseShiftCell(cellValue: unknown): {
  type: 'WORKING' | 'OFF' | 'UNKNOWN';
  intervals: { start: string; end: string }[];
  raw: string;
} {
  if (cellValue === null || cellValue === undefined) {
    return { type: 'OFF', intervals: [], raw: '' };
  }

  const raw = cellToText(cellValue).trim();
  const lowerRaw = raw.toLowerCase();

  // Leave/absence codes.
  if (['off', 'a/l', 'annual leave', 'ph', 'sick', 'sick leave', 'sl', 'do', 'day off', '-', ''].includes(lowerRaw)) {
    return { type: 'OFF', intervals: [], raw };
  }

  // Split multi-segmented split shifts (separated by /, ;, or commas).
  const segments = raw.split(/[/;,]/).map((s) => s.trim()).filter(Boolean);
  const intervals: { start: string; end: string }[] = [];

  // Compact split-shift notation like "10am/3pm-7pm/12am" encodes two shifts:
  //   shift 1 = 10am-3pm, shift 2 = 7pm-12am.
  // The segments are: "10am" (start 1), "3pm-7pm" (end 1 + start 2), "12am"
  // (end 2). A "B-C" bridge segment closes the pending shift at B and opens a
  // new one at C. A bare token either opens a shift (no pending) or closes the
  // pending shift (pending exists).
  let pendingStart: string | null = null;
  for (const segment of segments) {
    const pair = segment.match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i);
    if (pair) {
      const first = normalizeTime(pair[1]);
      const second = normalizeTime(pair[2]);
      if (first && second) {
        if (pendingStart) {
          // Bridge: close the pending shift at `first`, open a new one at `second`.
          intervals.push({ start: pendingStart, end: first });
          pendingStart = second;
        } else {
          // Standalone full pair.
          intervals.push({ start: first, end: second });
        }
      }
      continue;
    }

    // Bare time token.
    const bare = segment.match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i);
    if (bare) {
      const time = normalizeTime(bare[1]);
      if (time) {
        if (pendingStart) {
          // pendingStart + this time = a completed interval.
          intervals.push({ start: pendingStart, end: time });
          pendingStart = null;
        } else {
          pendingStart = time;
        }
      }
      continue;
    }
  }
  // If a trailing bare start remains with no end, drop it (incomplete shift).

  return {
    type: intervals.length > 0 ? 'WORKING' : 'UNKNOWN',
    intervals,
    raw,
  };
}

/**
 * Parses a roster file (Excel/CSV ArrayBuffer or PDF text) into a
 * ParsedVisionResult. `weekStart` is the ISO date of the roster week's first
 * day (Sunday); day columns are mapped to it in order.
 */
export function parseRotaFile(
  fileBuffer: ArrayBuffer | string,
  fileType: 'xlsx' | 'csv' | 'pdf-text',
  weekStart?: string,
): ParsedVisionResult {
  let rawRows: unknown[][] = [];

  if (fileType === 'xlsx' || fileType === 'csv') {
    const workbook = readWorkbook(fileBuffer, typeof fileBuffer === 'string' ? 'string' : 'array');
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, UTC: true }) as unknown[][]; // UTC: see buildMergeExpandedGrid
  } else if (fileType === 'pdf-text') {
    // fileBuffer is pre-extracted text lines from pdf-parse.
    rawRows = String(fileBuffer)
      .split('\n')
      .map((line) => line.split(/\s{2,}/));
  }

  return processRowsIntoRoster(rawRows, weekStart);
}

/**
 * Where the day columns are and which date each one is: the first row printing at least two
 * day headers ("17-Aug", "Mon 17/08", "Monday"), dated as printed (weekDetection.ts). Null when
 * no such row exists (the columns are then taken positionally, Monday first, from weekStart).
 */
function headerDates(rows: unknown[][], weekStart?: string): { rowIndex: number; dates: Map<number, string> } | null {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r] ?? [];
    const labels = row.map((cell) => parseDayLabel(cell instanceof Date || typeof cell === 'number' ? cell : cellToText(cell).trim()));
    const cols = labels.map((l, c) => (l && !l.numericOnly ? c : -1)).filter((c) => c >= 0);
    if (cols.length < 2) continue;
    const titles = rows.slice(0, r).flatMap((x) => (x ?? []).map((c) => cellToText(c).trim()).filter(Boolean));
    const today = weekStart ?? new Date().toISOString().slice(0, 10);
    const { dates } = detectWeek(cols.map((c) => labels[c]!), titles, { today, clientWeekStart: weekStart ?? null });
    const map = new Map<number, string>();
    cols.forEach((c, i) => dates[i] && map.set(c, dates[i]!));
    return { rowIndex: r, dates: map };
  }
  return null;
}

export function processRowsIntoRoster(rows: unknown[][], weekStart?: string): ParsedVisionResult {
  const parsedRows: ParsedShiftRow[] = [];
  const issues: RowIssue[] = [];
  const leaveRecords: ParsedVisionResult['leaveRecords'] = [];
  const anomalies: ParsedVisionResult['anomalies'] = [];

  // Dates as the header prints them; without a header row, the week's seven dates in column
  // order from weekStart (a Monday, like every rota week in this app).
  const header = headerDates(rows, weekStart);
  const dayDates = weekStart ? weekDates(weekStart) : null;
  const firstDayCol = header ? Math.min(...header.dates.keys()) : 2;

  let rowNumber = 1;
  for (const [r, row] of rows.entries()) {
    if (!row || row.length < 2) continue;
    if (header && r <= header.rowIndex) continue;

    const possibleName = cellToText(row[firstDayCol >= 2 ? firstDayCol - 1 : 0]).trim();
    const possibleRole = firstDayCol >= 2 ? cellToText(row[firstDayCol - 2]).trim() : '';

    // Skip header rows and empty name cells.
    if (!possibleName || possibleName.toLowerCase().includes('name') || possibleName.toLowerCase().includes('employee')) {
      continue;
    }

    const roleCategory = resolveRoleCategory(possibleRole);

    // Map the day columns to their dates. A row with nothing shift- or leave-like in any day
    // column (a title, a section banner, a caption) is not a staff row.
    const dayCells = header ? [...header.dates.keys()].map((c) => row[c]) : row.slice(2);
    if (!dayCells.some((cell) => parseShiftCell(cell).type === 'WORKING' || /^(off|a\/l|al|ul|sl|ph|sick)$/i.test(cellToText(cell).trim()))) continue;
    dayCells.forEach((cell, dayIndex) => {
      const parsed = parseShiftCell(cell);
      if (parsed.type === 'OFF') return;

      const date = header ? [...header.dates.values()][dayIndex] ?? null : dayDates ? dayDates[dayIndex] : null;
      if (!date) {
        // No weekStart provided — cannot assign a date.
        anomalies.push({
          employeeName: possibleName,
          date: null,
          rawText: parsed.raw,
          reason: 'No roster week start provided — cannot assign a date.',
          confidence: 0,
          rowNumber: null,
        });
        return;
      }

      if (parsed.type === 'UNKNOWN') {
        anomalies.push({
          employeeName: possibleName,
          date,
          rawText: parsed.raw,
          reason: `Could not resolve shift time from cell "${parsed.raw}".`,
          confidence: 0.2,
          rowNumber: null,
        });
        return;
      }

      // WORKING — emit one row per interval (split shifts become separate rows).
      for (const interval of parsed.intervals) {
        parsedRows.push({
          rowNumber: rowNumber++,
          employeeName: possibleName,
          roleName: possibleRole || roleCategory,
          date,
          startTime: interval.start,
          endTime: interval.end,
          overnight: isOvernight(interval.start, interval.end),
          breakMinutes: 0,
          managerNotes: null,
        });
      }
    });
  }

  return {
    templateLabel: 'Deterministic Local Parser',
    rows: parsedRows,
    issues,
    anomalies,
    leaveRecords,
    legend: [],
  };
}

/** Returns the 7 ISO dates of the week starting at weekStart (Monday-first). */
function weekDates(weekStart: string): string[] {
  const base = new Date(`${weekStart}T00:00:00Z`);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}
