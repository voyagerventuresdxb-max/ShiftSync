import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

/** Fallback IANA zone when a Location record has no explicit timezone set. */
export const DEFAULT_VENUE_TIMEZONE = 'Asia/Dubai';

// Text dates as CSV and HTML exports write them (SheetJS no longer guesses at
// them for us, see parseWorkbook.ts `readWorkbook`): ISO, day-first and
// month-first numerics, and the month-name spellings `20-Aug-2026`,
// `20-Aug-26`, `20 Aug 2026`, `Aug 20, 2026`.
const DATE_FORMATS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'DD/MM/YYYY',
  'D/M/YYYY',
  'MM/DD/YYYY',
  'DD-MM-YYYY',
  'D-MMM-YYYY',
  'DD-MMM-YYYY',
  'D-MMM-YY',
  'DD-MMM-YY',
  'D MMM YYYY',
  'D MMMM YYYY',
  'MMM D, YYYY',
  'MMM D YYYY',
  'MMMM D, YYYY',
];
const TIME_FORMATS = ['HH:mm', 'H:mm', 'HH:mm:ss', 'H:mm:ss', 'hh:mm A', 'h:mm A', 'hh:mmA', 'h:mmA', 'h:mm:ss A', 'h A', 'hA', 'HHmm'];

// Excel's epoch is 1899-12-30 (accounting for the historic leap-year bug).
export const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * An Excel serial (days since the epoch, fraction = time of day) as a UTC
 * Date whose UTC fields are the sheet's wall-clock values. Rounded to the
 * nearest second first: SheetJS derives a CSV/HTML serial through a local
 * Date, which on a host whose zone had a sub-minute offset in 1899
 * (Asia/Dubai: +3:41:12) leaves ~12s of noise. Pure arithmetic, no
 * timezone involved, so every host produces the same Date.
 */
export function excelSerialToUtcDate(serial: number): Date {
  return new Date(EXCEL_EPOCH_MS + Math.round(serial * 86_400) * 1000);
}

/**
 * A grid cell as text for the text paths (Gemini prompt, local fallback,
 * header detection), identical on every host: a Date is rendered from its UTC
 * fields (the sheet's wall-clock values, see parseWorkbook.ts `readWorkbook`),
 * never via `String(date)`, whose output carries the host's zone and offset.
 * A pure time-of-day cell (a serial below 1, i.e. on the Excel epoch day)
 * renders as "HH:mm"; a date-only cell as "YYYY-MM-DD"; a date-time as both.
 */
export function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return '';
    const iso = cell.toISOString();
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 16);
    const sinceEpoch = cell.getTime() - EXCEL_EPOCH_MS;
    if (sinceEpoch >= 0 && sinceEpoch < 86_400_000) return time;
    return time === '00:00' ? date : `${date} ${time}`;
  }
  return String(cell);
}


/**
 * Resolves a day-month date that has no year (e.g. "18-Aug", "17-Aug MONDAY",
 * "18 Aug") to a full ISO date, using a reference week to infer the year.
 * Gemini often returns dates as "D-MMM" without a year; the roster week
 * (weekStart, an ISO Sunday) anchors the correct year.
 */
export function resolveDayMonthDate(value: unknown, weekStart: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Strip a trailing day name ("17-Aug MONDAY" -> "17-Aug").
  const withoutDay = trimmed.replace(/\s+(?:sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat)\s*$/i, '').trim();
  if (!withoutDay) return null;

  // Accept "18-Aug", "18 Aug", "18/Aug", "18.08" (day.month).
  const m = withoutDay.match(/^(\d{1,2})\s*[-/.\s]\s*([A-Za-z]{3,9}|\d{1,2})$/);
  if (!m) return null;

  const day = Number(m[1]);
  let month: number;
  if (/^\d{1,2}$/.test(m[2])) {
    month = Number(m[2]);
  } else {
    const monthIdx = new Date(`${m[2]} 1, 2000`).getMonth();
    if (Number.isNaN(monthIdx)) return null;
    month = monthIdx + 1;
  }
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  // Infer the year from the reference week: pick the year whose occurrence of
  // this day-month is closest to (or within) the week starting at weekStart.
  const [wy, wm, wd] = weekStart.split('-').map(Number);
  const weekBase = new Date(wy, wm - 1, wd);
  const candidates = [wy - 1, wy, wy + 1];
  let best: string | null = null;
  let bestDist = Infinity;
  for (const year of candidates) {
    const d = new Date(year, month - 1, day);
    if (d.getMonth() !== month - 1 || d.getDate() !== day) continue; // invalid (e.g. Feb 30)
    const dist = Math.abs(d.getTime() - weekBase.getTime());
    if (dist < bestDist) {
      bestDist = dist;
      best = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return best;
}

/** Parses a spreadsheet date cell: JS Date (xlsx cellDates), Excel serial, or common string formats. */
export function parseDateCell(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // xlsx's cellDates:true builds these from UTC fields — read them back as
    // UTC too, so the host machine's local timezone can never shift the
    // calendar day (e.g. UTC midnight rendering as "yesterday" west of UTC).
    return dayjs.utc(value).format('YYYY-MM-DD');
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Use UTC fields throughout so local server timezone never shifts the calendar day.
    // Same second-rounding as excelSerialToUtcDate before taking the day.
    const d = excelSerialToUtcDate(value);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    for (const fmt of DATE_FORMATS) {
      const parsed = dayjs(trimmed, fmt, true);
      if (parsed.isValid()) return parsed.format('YYYY-MM-DD');
    }
  }
  return null;
}

/** Parses a spreadsheet time cell into 24h "HH:mm". Handles Date, Excel fraction, and text formats. */
export function parseTimeCell(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // Same UTC-read rationale as parseDateCell — the wall-clock time on the
    // sheet is what matters, not how the host machine's zone renders it.
    return dayjs.utc(value).format('HH:mm');
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const fraction = (Math.round(value * 86_400) / 86_400) % 1;
    const totalMinutes = Math.round(fraction * 24 * 60);
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!trimmed) return null;
    for (const fmt of TIME_FORMATS) {
      const parsed = dayjs(trimmed, fmt, true);
      if (parsed.isValid()) return parsed.format('HH:mm');
    }
  }
  return null;
}

/**
 * Splits a combined "9:00 AM - 5:00 PM" / "17:00-01:00" / "09:00 to 17:00"
 * cell (Template 3) into { start, end } 24h "HH:mm" strings.
 */
export function parseTimeRangeCell(value: unknown): { start: string; end: string } | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(/\s*(?:-|–|—|to)\s*/i).filter(Boolean);
  if (parts.length !== 2) return null;
  const start = parseTimeCell(parts[0]);
  const end = parseTimeCell(parts[1]);
  if (!start || !end) return null;
  return { start, end };
}

/** True when end is earlier than or equal to start (shift crosses midnight). */
export function isOvernight(start: string, end: string): boolean {
  return end <= start;
}

/**
 * Combines an ISO date and 24h "HH:mm" into a full UTC instant, interpreting
 * the wall-clock time in the given IANA venue timezone (e.g. "Asia/Dubai")
 * rather than the host machine's OS-local timezone. Rolls to the next
 * calendar day first when `nextDay` is set (overnight shifts), so DST
 * transitions in the venue's zone are still resolved correctly.
 */
export function combineDateAndTime(
  isoDate: string,
  hhmm: string,
  timezone: string = DEFAULT_VENUE_TIMEZONE,
  nextDay = false,
): Date {
  const wallClock = dayjs.tz(`${isoDate}T${hhmm}:00`, timezone);
  return (nextDay ? wallClock.add(1, 'day') : wallClock).toDate();
}

/** Parses a break-duration cell (minutes, or "30 min", "1h", "0:30") into whole minutes. */
export function parseBreakMinutes(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return 0;
    const hourMinMatch = trimmed.match(/^(\d+)\s*:\s*(\d+)$/);
    if (hourMinMatch) return Number(hourMinMatch[1]) * 60 + Number(hourMinMatch[2]);
    const hourMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*h/);
    const minMatch = trimmed.match(/(\d+)\s*m/);
    if (hourMatch || minMatch) {
      const hours = hourMatch ? parseFloat(hourMatch[1]) : 0;
      const mins = minMatch ? parseInt(minMatch[1], 10) : 0;
      return Math.round(hours * 60 + mins);
    }
    const bare = Number(trimmed);
    if (Number.isFinite(bare)) return Math.max(0, Math.round(bare));
  }
  return 0;
}
