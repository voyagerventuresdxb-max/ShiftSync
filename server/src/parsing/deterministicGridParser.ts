/**
 * Deterministic day-grid Excel/CSV parser — the PRIMARY path for grid-format
 * rosters (day-of-week columns, optional AM/PM sub-columns, role-section
 * header rows), replacing a Gemini call for the majority of real-world
 * uploads (Excel exports, digitally-created files) with direct cell-grid
 * reading. No network call, no model, fully reproducible.
 *
 * Input is the merge-expanded grid from buildMergeExpandedGrid() — merges
 * must already be expanded so a day header that spans AM/PM sub-columns, or
 * a role-section header that spans the full staff-block width, repeats its
 * value into every covered cell.
 *
 * Encodes the same two structural rules the VLM path had to learn the hard
 * way (see MEMORY.md "COVERS" bug and overnight-hour bug):
 *  - A role/section header only ever applies to staff rows that follow it —
 *    never inferred from anywhere else on the sheet. A staff row with no
 *    section header above it gets roleName "" (surfaced for manual review
 *    downstream), never a guessed/borrowed label.
 *  - Any parsed hour of 24 or higher (a common "hours past midnight" way of
 *    printing an overnight end time, e.g. "26:00" = 2am next day) is always
 *    normalized by subtracting 24 and marking the shift overnight — never
 *    passed through as a literal invalid time.
 */
import { parseDateCell, resolveDayMonthDate, isOvernight } from './normalize.js';
import { canonicalRoleName, isRecognizedRoleAlias } from './resolveRows.js';
import type { ParsedShiftRow, ParsedVisionResult, RowIssue, AnomalyRecord, LeaveRecord } from './types.js';

const DAY_OFFSET: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const LEAVE_CODES: Record<string, LeaveRecord['category']> = {
  off: 'day_off', 'day off': 'day_off', do: 'day_off', rest: 'day_off',
  al: 'leave', 'a/l': 'leave', 'annual leave': 'leave',
  sick: 'leave', sl: 'leave', 'sick leave': 'leave',
  unpaid: 'leave', 'unpaid leave': 'leave',
  ul: 'leave', // Unpaid Leave (Bar des Pres shorthand)
  ph: 'public_holiday', 'public holiday': 'public_holiday', holiday: 'public_holiday',
  request: 'day_off', closing: 'day_off',
};

function normalizeCell(value: unknown): string {
  return String(value ?? '').trim();
}

/** True when every cell in a row (besides the given column range) is blank. */
function isBlank(value: unknown): boolean {
  const s = normalizeCell(value);
  return s === '' || s === '-';
}

/** Resolves a day-header cell (day name, "17-Aug", ISO date, Excel date) to an ISO date anchored to weekStart. */
function resolveHeaderDate(cell: unknown, weekStart: string): string | null {
  const iso = parseDateCell(cell);
  if (iso) return iso;

  const raw = normalizeCell(cell);
  if (!raw) return null;

  const dayMonth = resolveDayMonthDate(raw, weekStart);
  if (dayMonth) return dayMonth;

  const key = raw.toLowerCase();
  const offset = DAY_OFFSET[key];
  if (offset === undefined) return null;
  const [wy, wm, wd] = weekStart.split('-').map(Number);
  const base = new Date(wy, wm - 1, wd);
  const startOffset = base.getDay();
  const delta = (offset - startOffset + 7) % 7;
  base.setDate(base.getDate() + delta);
  const yy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Converts a single time token ("9", "9am", "9:30", "18.5", "26") to 24h HH:mm, rolling >=24h hours to wall-clock time. */
function normalizeTimeToken(token: string): string | null {
  const raw = token.trim().toLowerCase();
  if (!raw) return null;

  // Decimal-hour form seen in real rota exports ("18.5" = 18:30).
  const decimal = raw.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (decimal) {
    let hour = parseInt(decimal[1], 10);
    const fractional = Number(`0.${decimal[2]}`);
    const minute = Math.round(fractional * 60);
    hour = hour % 24; // OVERNIGHT-ROLLOVER RULE: 24+ is hours-past-midnight, never a literal hour.
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3];

  if (meridiem) {
    if (meridiem === 'am') {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }
  } else {
    // OVERNIGHT-ROLLOVER RULE: a rota may print an overnight end time as
    // hours-past-midnight ("26:00" = 2am next day). Always normalize to a
    // true wall-clock hour instead of passing the raw number through — an
    // hour of 24+ is never a literal valid time.
    hour = hour % 24;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

interface ShiftInterval {
  start: string;
  end: string;
}

type CellParseResult =
  | { kind: 'blank' }
  | { kind: 'leave'; category: LeaveRecord['category']; code: string }
  | { kind: 'shifts'; intervals: ShiftInterval[] }
  | { kind: 'unresolved'; raw: string }
  // Recognized-but-intentionally-not-a-fixed-interval: a real start time
  // with no end ("10IN"), a real start that runs until an unspecified
  // closing time ("12CL"), or no fixed time at all ("IN" alone). These are
  // confidently understood, not garbage — `reason` says exactly what was
  // read — but ParsedShiftRow's startTime/endTime are both required
  // "HH:mm" fields (the DB's Shift model needs two real DateTimes), so
  // there's no way to represent "no end time" as a normal shift row without
  // a schema change. Routed through `anomalies` for manager review instead
  // of forcing a fake end time or silently dropping the cell — narrower
  // than a fully separate "open-ended shift" concept in the UI, which
  // would need that schema change to do properly.
  | { kind: 'flagged'; raw: string; reason: string };

/**
 * Parses one day-cell's raw content into shift interval(s) or a leave code.
 * Handles: "9-17", "9am-5pm", "17:00-01:00" (single range); "10am/3pm-7pm/
 * 12am", "9-13/18-23" (multi-segment split shifts, slash/semicolon
 * separated, using the same start-pending/bridge logic as the deterministic
 * PDF-text fallback); "10:30-4:00-8:00-12" (four hyphen-chained numbers,
 * no slash — two shifts back to back, as printed on the Bar des Pres
 * reference file); "11 17 18 25" (four space-separated numbers = AM
 * start/end, PM start/end, as literally printed on the Gattopardo
 * reference venue's rota); "10IN"/"12CL"/"IN" (open-ended/until-closing/
 * fully-flexible shorthand, confirmed with the Bar des Pres venue); and
 * leave/absence codes.
 */
function parseCellValue(raw: unknown): CellParseResult {
  if (isBlank(raw)) return { kind: 'blank' };
  const text = normalizeCell(raw);
  const lower = text.toLowerCase();

  if (lower in LEAVE_CODES) return { kind: 'leave', category: LEAVE_CODES[lower], code: text };

  // Fully flexible / on-call: no fixed start or end at all.
  if (/^in$/i.test(text)) {
    return { kind: 'flagged', raw: text, reason: 'Flexible/on-call shift — no fixed start or end time given; needs a manager to assign specific hours.' };
  }
  // "<N>IN" — a real start time, open-ended (no end given).
  const openEnded = text.match(/^(\d{1,2}(?::\d{2})?)\s*in$/i);
  if (openEnded) {
    const start = normalizeTimeToken(openEnded[1]);
    if (start) return { kind: 'flagged', raw: text, reason: `Open-ended shift — starts ${start}, no end time given.` };
  }
  // "<N>CL" — a real start time, runs until closing (not a literal end time).
  const untilClosing = text.match(/^(\d{1,2}(?::\d{2})?)\s*cl$/i);
  if (untilClosing) {
    const start = normalizeTimeToken(untilClosing[1]);
    if (start) return { kind: 'flagged', raw: text, reason: `Shift starts ${start}, runs until closing (no fixed end time) — show as "until close" rather than a guessed time.` };
  }

  // Four hyphen-chained numbers with no slash/semicolon separator: two
  // back-to-back shifts, e.g. "10:30-4:00-8:00-12" -> 10:30-4:00 and
  // 8:00-12:00. Distinct from the slash-separated multi-segment form below
  // (same two-shifts-in-one-cell idea, different punctuation convention).
  const hyphenChain4 = text.match(
    /^(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2}(?::\d{2})?)$/,
  );
  if (hyphenChain4) {
    const [start1, end1, start2, end2] = hyphenChain4.slice(1, 5).map(normalizeTimeToken);
    if (start1 && end1 && start2 && end2) {
      return { kind: 'shifts', intervals: [{ start: start1, end: end1 }, { start: start2, end: end2 }] };
    }
  }

  // Four space-separated numbers: AM start, AM end, PM start, PM end.
  const fourNums = text.match(/^(\d{1,2}(?:\.\d{1,2})?)\s+(\d{1,2}(?:\.\d{1,2})?)\s+(\d{1,2}(?:\.\d{1,2})?)\s+(\d{1,2}(?:\.\d{1,2})?)$/);
  if (fourNums) {
    const [amStart, amEnd, pmStart, pmEnd] = fourNums.slice(1, 5).map(normalizeTimeToken);
    if (amStart && amEnd && pmStart && pmEnd) {
      return { kind: 'shifts', intervals: [{ start: amStart, end: amEnd }, { start: pmStart, end: pmEnd }] };
    }
  }

  // Two space-separated numbers: single start/end, no AM/PM split.
  const twoNums = text.match(/^(\d{1,2}(?:\.\d{1,2})?)\s+(\d{1,2}(?:\.\d{1,2})?)$/);
  if (twoNums) {
    const [start, end] = twoNums.slice(1, 3).map(normalizeTimeToken);
    if (start && end) return { kind: 'shifts', intervals: [{ start, end }] };
  }

  // Multi-segmented split shifts, separated by / ; or , — same
  // bridge-segment logic as the deterministic PDF-text fallback:
  // "10am/3pm-7pm/12am" -> two intervals via a pending-start bridge.
  const segments = text.split(/[/;,]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length > 0) {
    const intervals: ShiftInterval[] = [];
    let pendingStart: string | null = null;
    let matchedAny = false;
    for (const segment of segments) {
      const pair = segment.match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i);
      if (pair) {
        const first = normalizeTimeToken(pair[1]);
        const second = normalizeTimeToken(pair[2]);
        if (first && second) {
          matchedAny = true;
          if (pendingStart) {
            intervals.push({ start: pendingStart, end: first });
            pendingStart = second;
          } else {
            intervals.push({ start: first, end: second });
          }
        }
        continue;
      }
      const bare = segment.match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i);
      if (bare) {
        const time = normalizeTimeToken(bare[1]);
        if (time) {
          matchedAny = true;
          if (pendingStart) {
            intervals.push({ start: pendingStart, end: time });
            pendingStart = null;
          } else {
            pendingStart = time;
          }
        }
      }
    }
    if (matchedAny && intervals.length > 0) return { kind: 'shifts', intervals };
  }

  return { kind: 'unresolved', raw: text };
}

/**
 * True when a lone label sitting in an otherwise-blank row looks like a
 * role/section header rather than a real staff member's name. Deliberately
 * not just a vocabulary match, since a fixed hospitality-role word list
 * only ever recognizes labels it already knows about, and every venue's
 * own shorthand ("FOH TEAM", "BAR STAFF", a department code) is different.
 * Two independent signals, either is enough:
 *  - Known vocabulary match (fast path — the same alias map DB resolution
 *    uses, e.g. "SUPERVISORS", "Head Waiter") — allowed anywhere in the
 *    sheet, position doesn't matter.
 *  - Structural pattern: the label is written in ALL CAPS AND at least one
 *    genuine staff row has already been seen above it in this parse.
 *    Section headers are conventionally printed in caps specifically to
 *    stand out from the names listed below them, and a real person's name
 *    is essentially never written in full caps — but an all-caps label
 *    can also just be some OTHER kind of sheet caption (a covers-count
 *    panel title, a legend heading) that has nothing to do with grouping
 *    staff, especially near the top of the sheet before any real staff
 *    data has appeared. Requiring at least one staff row already seen is
 *    what tells those apart: a genuine role-section header always sits
 *    inside the staff listing, splitting one group of names from the
 *    next — never before the listing has started.
 *
 * A known leave/absence code (many are themselves short all-caps words —
 * "OFF", "SICK", "UNPAID") is never treated as a header candidate, checked
 * first and unconditionally.
 *
 * Known limitation (see MEMORY.md for the honest coverage picture): a
 * venue that writes every name in the sheet in capital letters — a style
 * choice, not a header signal — defeats the all-caps signal exactly the
 * way a coincidental vocabulary match could defeat a keyword-only rule;
 * this isn't a new class of false positive, just a different trigger for
 * the same one. And a genuinely novel-vocabulary section header that
 * happens to be the very first labelled group in the sheet (no unlabeled
 * staff rows above it, so hasSeenAnyStaffRow is still false) won't be
 * recognized by the pattern signal — only the vocabulary one.
 */
function isRoleHeaderLabel(candidate: string, hasSeenAnyStaffRow: boolean): boolean {
  if (candidate.toLowerCase() in LEAVE_CODES) return false;
  if (canonicalRoleName(candidate) !== candidate) return true;
  if (!hasSeenAnyStaffRow) return false;
  const letters = candidate.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false; // too short to be a confident signal (avoids "AM"/"OK"/initials)
  return letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

interface DayColumn {
  colIndex: number;
  date: string;
  period: 'AM' | 'PM' | null;
}

/** Locates the day-header row and, if present, the AM/PM sub-header row directly beneath it. */
function findHeaderRows(grid: unknown[][], weekStart: string): { dayRowIdx: number; periodRowIdx: number | null; dataStartIdx: number } | null {
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const row = grid[r] ?? [];
    let dateHits = 0;
    for (let c = 1; c < row.length; c++) {
      if (resolveHeaderDate(row[c], weekStart)) dateHits++;
    }
    if (dateHits >= 2) {
      const nextRow = grid[r + 1] ?? [];
      const nextIsPeriodRow = nextRow.slice(1).some((cell) => /^(am|pm)$/i.test(normalizeCell(cell)));
      if (nextIsPeriodRow) {
        return { dayRowIdx: r, periodRowIdx: r + 1, dataStartIdx: r + 2 };
      }
      // Some files stack a second header row with no AM/PM concept at all
      // — a weekday-name row ("Monday", "Tuesday", ...) repeating the same
      // dates already read from the numeric-date row above it. Detected
      // the same way as the date row itself (>=2 resolvable date-like
      // cells) and skipped, so it isn't mistaken for the first staff row.
      let secondDateHits = 0;
      for (let c = 1; c < nextRow.length; c++) {
        if (resolveHeaderDate(nextRow[c], weekStart)) secondDateHits++;
      }
      const dataStartIdx = secondDateHits >= 2 ? r + 2 : r + 1;
      return { dayRowIdx: r, periodRowIdx: null, dataStartIdx };
    }
  }
  return null;
}

function buildDayColumns(grid: unknown[][], header: { dayRowIdx: number; periodRowIdx: number | null }, weekStart: string): DayColumn[] {
  const dayRow = grid[header.dayRowIdx] ?? [];
  const periodRow = header.periodRowIdx !== null ? grid[header.periodRowIdx] ?? [] : null;
  const columns: DayColumn[] = [];
  for (let c = 1; c < dayRow.length; c++) {
    const date = resolveHeaderDate(dayRow[c], weekStart);
    if (!date) continue;
    const periodCell = periodRow ? normalizeCell(periodRow[c]).toUpperCase() : '';
    const period = periodCell === 'AM' || periodCell === 'PM' ? (periodCell as 'AM' | 'PM') : null;
    columns.push({ colIndex: c, date, period });
  }
  return columns;
}

/**
 * Parses a merge-expanded grid into ShiftSync's canonical result contract.
 * Returns 0 rows (with no anomalies) when the grid doesn't look like a
 * day-grid roster at all (e.g. no recognizable date header row) — callers
 * should treat that as "not this shape" and try another path, not as a
 * hard error.
 */
export function parseExcelGrid(grid: unknown[][], weekStart: string): ParsedVisionResult {
  const rows: ParsedShiftRow[] = [];
  const issues: RowIssue[] = [];
  const anomalies: AnomalyRecord[] = [];
  const leaveRecords: LeaveRecord[] = [];

  const header = findHeaderRows(grid, weekStart);
  if (!header) {
    return { templateLabel: 'Deterministic Grid Parser (no day-header row detected)', rows, issues, anomalies, leaveRecords, legend: [] };
  }
  const columns = buildDayColumns(grid, header, weekStart);
  if (columns.length === 0) {
    return { templateLabel: 'Deterministic Grid Parser (no resolvable day columns)', rows, issues, anomalies, leaveRecords, legend: [] };
  }

  // Most rosters have exactly one leading column (the staff name). Some
  // print an explicit per-row title in its own column before the name
  // (e.g. "RM" | "Robert Orgovan" | ... — Bar des Pres FOH style), on top
  // of (or instead of) grouping staff under section headers. Inferred from
  // where the day columns actually start, rather than hardcoded, so both
  // shapes work without knowing in advance which one a given file uses.
  const firstDayColIndex = columns[0].colIndex;
  const hasTitleColumn = firstDayColIndex >= 2;
  let nameColIndex = hasTitleColumn ? firstDayColIndex - 1 : 0;
  let titleColIndex: number | null = hasTitleColumn ? 0 : null;

  // With exactly 2 leading columns, position alone can't say which is the
  // staff name and which is the role — "Role, Name, Mon..." (Bar des
  // Pres's own layout, the shape the col0=title/col1=name default above
  // was built for) and the reverse "Name, Role, Mon..." are structurally
  // identical from the header row alone. Disambiguate by content instead:
  // sample each candidate column against the known role-alias vocabulary
  // and see which one actually looks like roles. Only overrides the
  // position-based default on a confident, one-sided signal — with no
  // signal on either side (e.g. this venue's role titles genuinely aren't
  // in ROLE_ALIASES yet, a separate vocabulary gap) the sheet is
  // genuinely ambiguous and gets flagged for manual review below instead
  // of silently resolved on a guess either way.
  let columnOrderAmbiguous = false;
  if (hasTitleColumn && firstDayColIndex === 2) {
    // Prefer rows where BOTH candidate columns are populated — a genuine
    // per-row (title, name) pair is the most reliable signal available,
    // and excludes a section-header-only row (one column blank, e.g.
    // "FLOOR" in column 0 with column 1 empty) from corrupting the sample:
    // "floor" is itself a ROLE_ALIASES key, so a "FLOOR" section header
    // would otherwise get miscounted as evidence that column 0 holds
    // roles even on a sheet where column 0 is actually the name column —
    // a header's own column placement doesn't reliably indicate which
    // column means what, only a real paired data row does.
    const pairedRows: { col0: string; col1: string }[] = [];
    for (let r = header.dataStartIdx; r < grid.length; r++) {
      const v0 = normalizeCell(grid[r]?.[0]);
      const v1 = normalizeCell(grid[r]?.[1]);
      if (v0 && v1) pairedRows.push({ col0: v0, col1: v1 });
    }

    let col0: { hits: number; total: number };
    let col1: { hits: number; total: number };
    if (pairedRows.length > 0) {
      col0 = { hits: pairedRows.filter((p) => isRecognizedRoleAlias(p.col0)).length, total: pairedRows.length };
      col1 = { hits: pairedRows.filter((p) => isRecognizedRoleAlias(p.col1)).length, total: pairedRows.length };
    } else {
      // No genuine two-value rows anywhere on the sheet to sample from
      // (rare in practice — a real roster's staff rows almost always
      // carry both a title and a name per row). Fall back to every
      // non-blank value per column, header rows included — noisier, but
      // still better than no signal at all when it's the only signal
      // there is.
      const fullColumnShare = (colIndex: number): { hits: number; total: number } => {
        let hits = 0;
        let total = 0;
        for (let r = header.dataStartIdx; r < grid.length; r++) {
          const v = normalizeCell(grid[r]?.[colIndex]);
          if (!v) continue;
          total++;
          if (isRecognizedRoleAlias(v)) hits++;
        }
        return { hits, total };
      };
      col0 = fullColumnShare(0);
      col1 = fullColumnShare(1);
    }

    if (col0.hits === 0 && col1.hits === 0) {
      // No content signal on either side — e.g. this venue's own role
      // titles ("RM", "Chef de Rang", ...) genuinely aren't in
      // ROLE_ALIASES yet. Position alone would just be a guess here.
      columnOrderAmbiguous = true;
    } else if (col0.hits > 0 && col1.hits === 0) {
      // Only column 0 has any role-vocabulary hits — content agrees with
      // the position default (col0=title/col1=name). A real staff-name
      // column essentially never accidentally matches role vocabulary, so
      // even a low hit *rate* on column 0 (most real rosters mix a few
      // recognized titles with several venue-specific ones ROLE_ALIASES
      // doesn't know yet) is still a confident, one-sided signal — it's
      // the zero-vs-nonzero split that matters, not the absolute rate.
    } else if (col1.hits > 0 && col0.hits === 0) {
      // Mirror image: only column 1 has hits — content confidently
      // disagrees with the position default. Column 1 is the role column
      // here, column 0 is the name.
      titleColIndex = 1;
      nameColIndex = 0;
    } else {
      // Both columns have at least one hit (rare — e.g. a name that
      // happens to coincidentally match a role alias). Fall back to
      // comparing rates, and only trust a clear, not marginal, lean.
      const col0Rate = col0.hits / col0.total;
      const col1Rate = col1.hits / col1.total;
      const CONFIDENT_MARGIN = 0.25;
      if (col1Rate - col0Rate > CONFIDENT_MARGIN) {
        titleColIndex = 1;
        nameColIndex = 0;
      } else if (col0Rate - col1Rate > CONFIDENT_MARGIN) {
        // keep col0=title/col1=name
      } else {
        columnOrderAmbiguous = true;
      }
    }
  }

  let currentRole = '';
  let rowNumber = 1;
  let hasSeenAnyStaffRow = false;
  const dayColIndexes = new Set(columns.map((c) => c.colIndex));

  /** Parses every day-column cell for one confirmed staff row (shared by both column shapes below). */
  function processStaffRow(row: unknown[], employeeName: string, roleName: string, extraNoteExcludedCols: Set<number>): void {
    let hasShiftOrLeaveThisRow = false;
    for (const col of columns) {
      const parsed = parseCellValue(row[col.colIndex]);
      if (parsed.kind === 'blank') continue;

      if (parsed.kind === 'leave') {
        hasShiftOrLeaveThisRow = true;
        leaveRecords.push({ employeeName, date: col.date, leaveCode: parsed.code, category: parsed.category });
        continue;
      }

      if (parsed.kind === 'unresolved') {
        anomalies.push({
          employeeName,
          date: col.date,
          rawText: parsed.raw,
          reason: `Could not resolve shift time from cell "${parsed.raw}".`,
          confidence: 0.2,
          rowNumber: null,
        });
        continue;
      }

      if (parsed.kind === 'flagged') {
        // Recognized but intentionally not a fixed interval (open-ended,
        // until-closing, fully flexible) — see CellParseResult's 'flagged'
        // variant for why this can't become a normal shift row without a
        // DB schema change. Higher confidence than a genuine unresolved
        // cell: this was understood, not guessed at.
        hasShiftOrLeaveThisRow = true;
        anomalies.push({
          employeeName,
          date: col.date,
          rawText: parsed.raw,
          reason: parsed.reason,
          confidence: 0.7,
          rowNumber: null,
        });
        continue;
      }

      // shifts — one or more intervals for this cell (AM/PM split or multi-segment).
      hasShiftOrLeaveThisRow = true;
      for (const interval of parsed.intervals) {
        if (!roleName) {
          issues.push({
            rowNumber,
            field: 'role',
            severity: 'warning',
            message: `No role/section header precedes "${employeeName}" — flagged for manual role assignment.`,
          });
        }
        rows.push({
          rowNumber: rowNumber++,
          employeeName,
          roleName,
          date: col.date,
          startTime: interval.start,
          endTime: interval.end,
          overnight: isOvernight(interval.start, interval.end),
          breakMinutes: 0,
          managerNotes: col.period ? `[${col.period}]` : null,
        });
      }
    }

    // No shift or leave data in any day column for this employee this
    // week — before letting them silently produce nothing, check whether
    // some other column on their row (a notes/comments column outside the
    // day-column range) carries a recognizable leave code, and surface
    // that as an explicit leave record instead. Deliberately narrow: only
    // fires when the day columns were completely empty, so a real working
    // week with some unrelated trailing text (e.g. a "Closing" note next
    // to someone who worked normally) is never misread as an absence.
    if (!hasShiftOrLeaveThisRow) {
      for (let c = 0; c < row.length; c++) {
        if (extraNoteExcludedCols.has(c) || dayColIndexes.has(c)) continue;
        const note = normalizeCell(row[c]);
        if (!note) continue;
        const lower = note.toLowerCase();
        if (lower in LEAVE_CODES) {
          leaveRecords.push({ employeeName, date: weekStart, leaveCode: note, category: LEAVE_CODES[lower] });
          break; // one leave record is enough to surface "this person is out"
        }
      }
    }
  }

  for (let r = header.dataStartIdx; r < grid.length; r++) {
    const row = grid[r] ?? [];

    if (!hasTitleColumn) {
      // Single-label-column shape: the name column IS where a role/section
      // header also appears (e.g. Gattopardo's "SUPERVISORS"), so header
      // vs. real name is discriminated by content, not position.
      const firstCell = normalizeCell(row[0]);

      // Every distinct non-blank value in this row (name column + day
      // columns). A role/section header doesn't always sit in the name
      // column — on a PDF-reconstructed grid a centred section label can
      // land under whichever day column it happens to be closest to, and
      // a merge can repeat the label into every column, or leave it only
      // in column 0. Collecting every non-blank value and checking for a
      // header match anywhere handles all of those shapes with one rule.
      const nonBlankValues: string[] = [];
      if (firstCell) nonBlankValues.push(firstCell);
      for (const col of columns) {
        const v = normalizeCell(row[col.colIndex]);
        if (v) nonBlankValues.push(v);
      }
      if (nonBlankValues.length === 0) continue; // fully blank row

      // Role/section-header detection takes priority over everything else
      // below: a header row can carry an unrelated stray value alongside
      // the label itself (e.g. a headcount summary number sharing a
      // reconstructed PDF row with "HEAD WAITERS" due to imprecise row
      // clustering) — if ANY value in this row is recognized as a header
      // label, that's the section header for the rows beneath it.
      const roleMatch = nonBlankValues.find((v) => isRoleHeaderLabel(v, hasSeenAnyStaffRow));
      if (roleMatch) {
        currentRole = roleMatch;
        continue;
      }

      // A bare number in the name column (and no role keyword found above) is a headcount/totals row.
      if (/^\d+(\.\d+)?$/.test(firstCell)) continue;
      if (!firstCell) continue; // no employee name in this row — can't emit a staff row

      const employeeName = firstCell;
      hasSeenAnyStaffRow = true;
      processStaffRow(row, employeeName, currentRole, new Set([0]));
      continue;
    }

    // Two-leading-column shape, but content couldn't confidently say which
    // of column 0 / column 1 is the name and which is the role (see the
    // disambiguation above). A single populated candidate column can still
    // be recognized as a section header without knowing column identity
    // (that check doesn't depend on which column means what) — only a row
    // with BOTH columns populated is genuinely ambiguous and gets flagged
    // instead of guessed.
    if (columnOrderAmbiguous) {
      const col0Val = normalizeCell(row[0]);
      const col1Val = normalizeCell(row[1]);
      if (!col0Val && !col1Val) continue; // fully blank row

      if (!col0Val || !col1Val) {
        const label = col0Val || col1Val;
        if (/^\d+(\.\d+)?$/.test(label)) continue; // headcount/totals row
        if (isRoleHeaderLabel(label, hasSeenAnyStaffRow)) {
          currentRole = label;
          continue;
        }
      }

      anomalies.push({
        employeeName: null,
        date: null,
        rawText: `"${col0Val || '(blank)'}" | "${col1Val || '(blank)'}"`,
        reason:
          'Could not confidently tell which of the first two columns is the staff name and which is the role (neither matches known role vocabulary clearly enough to disambiguate). Flagged for manual entry instead of guessing.',
        confidence: 0.3,
        rowNumber: null,
      });
      continue;
    }

    // Two-leading-column shape: column 0 is a per-row title, column
    // nameColIndex is the actual staff name — no content-based ambiguity,
    // an empty name column always means "not a real staff row."
    const nameCell = normalizeCell(row[nameColIndex]);
    const titleCell = normalizeCell(row[titleColIndex!]);

    if (!nameCell) {
      const headerCandidates: string[] = [];
      if (titleCell) headerCandidates.push(titleCell);
      for (const col of columns) {
        const v = normalizeCell(row[col.colIndex]);
        if (v) headerCandidates.push(v);
      }
      const roleMatch = headerCandidates.find((v) => isRoleHeaderLabel(v, hasSeenAnyStaffRow));
      if (roleMatch) currentRole = roleMatch;
      continue;
    }

    if (/^\d+(\.\d+)?$/.test(nameCell)) continue; // headcount/totals row

    const employeeName = nameCell;
    hasSeenAnyStaffRow = true;
    // A per-row title is more specific than whatever section header
    // preceded it and always takes precedence; falls back to the
    // section-derived role when this row's own title cell is blank.
    const roleName = titleCell || currentRole;
    processStaffRow(row, employeeName, roleName, new Set([nameColIndex, titleColIndex!]));
  }

  return {
    templateLabel: 'Deterministic Grid Parser',
    rows,
    issues,
    anomalies,
    leaveRecords,
    legend: [],
  };
}
