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
import { isOvernight } from './normalize.js';
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

  const raw = String(cellValue).trim();
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
    const workbook = XLSX.read(fileBuffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as unknown[][];
  } else if (fileType === 'pdf-text') {
    // fileBuffer is pre-extracted text lines from pdf-parse.
    rawRows = String(fileBuffer)
      .split('\n')
      .map((line) => line.split(/\s{2,}/));
  }

  return processRowsIntoRoster(rawRows, weekStart);
}

export function processRowsIntoRoster(rows: unknown[][], weekStart?: string): ParsedVisionResult {
  const parsedRows: ParsedShiftRow[] = [];
  const issues: RowIssue[] = [];
  const leaveRecords: ParsedVisionResult['leaveRecords'] = [];
  const anomalies: ParsedVisionResult['anomalies'] = [];

  // Determine the week's day dates (Sunday-first) from weekStart.
  const dayDates = weekStart ? weekDates(weekStart) : null;

  let rowNumber = 1;
  for (const row of rows) {
    if (!row || row.length < 2) continue;

    const possibleName = String(row[0] ?? '').trim();
    const possibleRole = String(row[1] ?? '').trim();

    // Skip header rows and empty name cells.
    if (!possibleName || possibleName.toLowerCase().includes('name') || possibleName.toLowerCase().includes('employee')) {
      continue;
    }

    const roleCategory = resolveRoleCategory(possibleRole);

    // Map remaining columns to days of the week.
    const dayCells = row.slice(2);
    dayCells.forEach((cell, dayIndex) => {
      const parsed = parseShiftCell(cell);
      if (parsed.type === 'OFF') return;

      const date = dayDates ? dayDates[dayIndex] : null;
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

/** Returns the 7 ISO dates (Sunday-first) for the week containing weekStart. */
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
