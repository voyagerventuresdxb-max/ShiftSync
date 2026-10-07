/**
 * Deterministic day-grid Excel/CSV parser — the PRIMARY path for grid-format
 * rosters (day-of-week columns, optional AM/PM sub-columns, role-section
 * header rows), replacing a Gemini call for the majority of real-world
 * uploads (Excel exports, digitally-created files) with direct cell-grid
 * reading. No network call, no model, fully reproducible. Also the table
 * reader behind text-layer PDFs (pdfTableExtractor.ts builds the grid).
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
 *
 * Dates come from what the sheet prints (weekDetection.ts): printed day-month
 * headers, or a title naming the week; never the week of the upload.
 */
import { isAllCapsLabel } from './escalation.js';
import { isOvernight, cellToText } from './normalize.js';
import { canonicalRoleName, isRecognizedRoleAlias, isRoleTitle } from './resolveRows.js';
import { detectWeek, isConsecutiveDayRun, parseDayLabel, weekdayOf, type DayLabel } from './weekDetection.js';
import { ambiguousDottedTime, parseShiftText, parseSingleTime, sheetDotStyle, withinOneDay, type ShiftTextOptions } from './shiftText.js';
import { columnHeading, combinedLabelOrder, isFooterTotalOrNote, isLabelLine, isSectionLabel, joinLigatureSplits, looksLikePersonName, nonPersonReason, personKeyOf, splitNameTitle, UNREADABLE_NAME } from './personKey.js';
import type { ReadPerson, UnreadRow, WeekDetection } from './rosterContract.js';
import type { ParsedShiftRow, ParsedVisionResult, RowIssue, AnomalyRecord, LeaveRecord } from './types.js';

/**
 * Thrown when a day-grid shape WAS recognized (header row + day columns
 * found) but the row-count sanity check below determined real shift data
 * was dropped during classification — e.g. a staff row misread as a
 * section header. Deliberately distinct from returning a normal (possibly
 * empty) ParsedVisionResult: an empty/low result for a shape that plainly
 * doesn't match a day-grid roster at all is a legitimate "try another
 * path" signal for callers, but this is a confirmed data-loss condition on
 * a shape we DID recognize, and must surface as a loud, visible failure
 * (see schedules.ts) rather than a silent 200-success with missing rows.
 */
export class RosterExtractionAnomalyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterExtractionAnomalyError';
  }
}

const LEAVE_CODES: Record<string, LeaveRecord['category']> = {
  off: 'day_off', 'day off': 'day_off', 'day-off': 'day_off', dayoff: 'day_off', 'off day': 'day_off', do: 'day_off', rest: 'day_off', 'rest day': 'day_off',
  // A day with no shift, as people mark it: "O", "X", a dash, "R/O" (rest / requested off), "REQ".
  o: 'day_off', x: 'day_off', '-': 'day_off', '–': 'day_off', '—': 'day_off', 'r/o': 'day_off', req: 'day_off', 'req off': 'day_off', 'requested off': 'day_off',
  al: 'leave', 'a/l': 'leave', 'annual leave': 'leave', hol: 'leave', hols: 'leave', vac: 'leave', vacation: 'leave', leave: 'leave',
  sick: 'leave', sl: 'leave', 's/l': 'leave', 'sick leave': 'leave', mc: 'leave',
  unpaid: 'leave', 'unpaid leave': 'leave',
  ul: 'leave', // Unpaid Leave (Bar des Pres shorthand)
  ph: 'public_holiday', 'public holiday': 'public_holiday', holiday: 'public_holiday',
  request: 'day_off', closing: 'day_off',
};

/**
 * Small, closed vocabulary of tabular summary/footer captions ("Total
 * hours: 09:00-17:00") that must never become a staff row even though a
 * neighbouring cell can coincidentally look shift-shaped (e.g. a literal
 * time range printed as the total). Unlike the open-ended, venue-specific
 * section-header vocabulary problem, this set is small and universal
 * across spreadsheet conventions — it can't collide with a real person's
 * name or a real section header, so a fixed list here doesn't reintroduce
 * the coverage gap the structural signal was built to avoid.
 */
const SUMMARY_ROW_LABELS = new Set(['total', 'totals', 'subtotal', 'sum', 'grand total', 'hours', 'total hours']);

/**
 * Caption rows printed above or inside the listing that describe the day, not a person:
 * a covers/pax line, an events line, notes. Same closed-vocabulary reasoning as above.
 */
const CAPTION_WORDS = /^(covers?|pax|events?|functions?|bookings?|reservations?|notes?|remarks?|comments?|forecast|occupancy|day of the week|date)\b/i;

/** A footer, totals or note line ("Prepared by: …", "Total staff on rota 22", "Page 1 of 2"): never a person or a section. */
const isFooterOrNote = isFooterTotalOrNote;

/** What the review says about a row whose name couldn't be read ("[?]", "?", "…"). */
const UNREADABLE_ROW = "A row whose name couldn't be read. Add the person and their shifts by hand if it is one.";

/** A line of text rather than a heading: five words or more, or a sentence's end ("Any changes must be agreed with the duty manager"). */
const isSentence = (text: string) => text.trim().split(/\s+/).length >= 5 || /[.!?]$/.test(text.trim());

/** What the review says about a line below the roster that has text but no shift, time or leave in its days. */
const BELOW_ROSTER = 'A line below the roster with no shift, time or leave in its days: not read as a person. Add them by hand if it is one.';

/** Words that name a group of staff, not a person ("Bar Team", "Night Crew"). */
const GROUP_WORDS = /\b(team|staff|crew|squad|section|department|dept|group|shift|service|foh|boh|management)\b/i;

/**
 * `key in obj` also matches inherited Object.prototype property names
 * ("constructor", "toString", "hasOwnProperty", ...) even when the plain
 * object literal never defined them — so a day-cell whose exact text
 * happens to be one of those reserved names would otherwise silently
 * "resolve" against Object.prototype itself (e.g. `fileLegend['constructor']`
 * is the real Object constructor function, whose .start/.end are
 * undefined) instead of correctly falling through to 'unresolved'.
 */
function hasOwnKey<T extends object>(obj: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeCell(value: unknown): string {
  // A Date here is a typed date/time cell (see parseWorkbook.ts `readWorkbook`);
  // its text must not depend on the host's zone, so never `String(date)`.
  // A word a text layer split at a ligature ("O ffi ce", "Sa ffi ya") is read whole.
  return joinLigatureSplits(cellToText(value).trim());
}

/** True when every cell in a row (besides the given column range) is blank. */
function isBlank(value: unknown): boolean {
  const s = normalizeCell(value);
  return s === '' || s === '-';
}

/** One time token of a legend line ("07:00", "7am") as HH:mm. */
const legendTime = (token: string) => parseSingleTime(token);

interface ShiftInterval {
  start: string;
  end: string;
}

// --- Legend-code detection ----------------------------------------------
//
// Some venues print short shorthand codes in day cells ("M", "E", "N")
// backed by an in-file legend/key ("M = Morning 07:00-15:00"), instead of
// literal times. Unlike LEAVE_CODES (a fixed, hardcoded absence vocabulary),
// these codes are venue-specific and represent an actual WORKED shift, not
// an absence — so they can't be hardcoded and must be read from the file
// itself, per-file.
//
// Detection is deliberately narrow: a legend block, when present, is
// expected to sit in a FOOTER region below the main staff-data grid,
// separated from it by at least one fully-blank row (confirmed against a
// real reference fixture: a blank row, then a "Shift Code Legend" caption,
// then one code per row). Requiring that separator is what keeps this from
// ever misreading real staff/shift data as a legend line — a staff row's
// own short name (e.g. "Ali") sitting next to a real shift cell ("9-17")
// could otherwise coincidentally match the same "code + time-range" shape
// this looks for, corrupting a real name into a bogus legend entry. Never
// scanning above the separator rules that out entirely.
//
// Known limitations (not handled, by design — see report): a legend printed
// ABOVE the day-header row, in a side column running alongside the staff
// rows (not below a blank-row separator), or split across more cells than
// the two shapes below expect (e.g. code/"="/time as three separate cells).

// Capped at 3 characters total — every real shift-code convention found in
// research and the actual reference fixture is single-letter or a short
// abbreviation (M/E/N/G, OFF, AL), never a whole word. A wider cap (6 chars)
// let an ordinary short English word in unrelated footer content (e.g. a
// "TOTAL" summary line whose other cells happen to contain a resolvable time
// range) get mistaken for a real legend code — caught by review with a
// constructed real-shaped test case. This narrows the false-positive surface
// without excluding any known real code.
const CODE_TOKEN = '[A-Za-z][A-Za-z0-9]{0,2}';
const TIME_TOKEN = '\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?';
const RANGE_SEP = '(?:-|–|to)';

/** A cell containing ONLY a short code, e.g. "M", "A1" — nothing else. */
const CODE_ONLY_RE = new RegExp(`^${CODE_TOKEN}$`);
/** A cell containing ONLY a time range, e.g. "07:00-15:00", "7am-3pm". */
const RANGE_ONLY_RE = new RegExp(`^(${TIME_TOKEN})\\s*${RANGE_SEP}\\s*(${TIME_TOKEN})$`, 'i');
/**
 * A single cell spelling out the whole legend line, e.g. "M = Morning
 * 07:00-15:00", "A: 7am-3pm", "A - 07:00-15:00". The optional label between
 * the separator and the time range covers the common "code = name time"
 * phrasing without requiring it.
 */
const SINGLE_CELL_LEGEND_RE = new RegExp(
  `^(${CODE_TOKEN})\\s*[=:-]\\s*(?:[A-Za-z][A-Za-z\\s]{0,24}?\\s+)?(${TIME_TOKEN})\\s*${RANGE_SEP}\\s*(${TIME_TOKEN})$`,
  'i',
);

interface LegendLineMatch {
  code: string;
  start: string;
  end: string;
  label: string | null;
}

/**
 * Tries to read one legend line out of a single grid row, in either of two
 * shapes:
 *  - Multi-column: "M" | "Morning" | "07:00-15:00" (code, optional label,
 *    time range each in their own cell — the shape of the real reference
 *    fixture's own legend block).
 *  - Single-cell: "M = Morning 07:00-15:00" all in one cell (the shape a
 *    PDF-text extraction of the same content tends to produce).
 * Returns null when the row doesn't confidently match either shape (a
 * caption like "Shift Code Legend", a code with no resolvable time range
 * such as "OFF = Day Off", or unrelated footer content) — callers skip
 * rather than treat that as the end of the legend block, so a caption or a
 * time-less entry in the middle of the block doesn't cut it short.
 */
function matchLegendRow(row: unknown[]): LegendLineMatch | null {
  const cells = row.map(normalizeCell);
  const firstNonBlankIdx = cells.findIndex((c) => c !== '' && c !== '-');
  if (firstNonBlankIdx === -1) return null;

  const first = cells[firstNonBlankIdx];
  if (CODE_ONLY_RE.test(first)) {
    for (let i = firstNonBlankIdx + 1; i < cells.length; i++) {
      const rangeMatch = cells[i].match(RANGE_ONLY_RE);
      if (!rangeMatch) continue;
      const start = legendTime(rangeMatch[1]);
      const end = legendTime(rangeMatch[2]);
      if (!start || !end) continue;
      const label = cells.slice(firstNonBlankIdx + 1, i).find((c) => c !== '') ?? null;
      return { code: first, start, end, label };
    }
  }

  for (const cell of cells) {
    if (!cell) continue;
    const m = cell.match(SINGLE_CELL_LEGEND_RE);
    if (!m) continue;
    const start = legendTime(m[2]);
    const end = legendTime(m[3]);
    if (start && end) return { code: m[1], start, end, label: null };
  }

  return null;
}

/**
 * Scans for a legend block sitting in a footer region below the main
 * staff-data grid (from `searchFromRow` — `header.dataStartIdx` — onward),
 * separated from it by at least one fully-blank row. Returns an empty
 * legend/map when no such block is found — the caller's existing
 * LEAVE_CODES-only resolution is then completely unchanged, exactly as
 * before this feature existed.
 */
function detectLegend(
  grid: unknown[][],
  searchFromRow: number,
): { legend: { code: string; meaning: string }[]; map: Record<string, ShiftInterval>; footerStartRow: number | null } {
  const empty = {
    legend: [] as { code: string; meaning: string }[],
    map: {} as Record<string, ShiftInterval>,
    footerStartRow: null as number | null,
  };
  if (searchFromRow >= grid.length) return empty;

  const isBlankRow = (row: unknown[]): boolean => row.every((c) => isBlank(c));

  let separatorIdx = -1;
  for (let r = searchFromRow; r < grid.length; r++) {
    if (isBlankRow(grid[r] ?? [])) {
      separatorIdx = r;
      break;
    }
  }
  if (separatorIdx === -1) return empty;

  const legend: { code: string; meaning: string }[] = [];
  const map: Record<string, ShiftInterval> = {};
  const seenCodes = new Set<string>();
  // Bounds how many CONSECUTIVE non-blank, non-legend-shaped lines (a
  // caption like "Shift Code Legend", or a timeless entry like "OFF = Day
  // Off" with no resolvable range) are tolerated in a row, anywhere in the
  // block — not just before the first entry. A real legend entry resets the
  // streak, so a timeless/caption line sitting BETWEEN two real entries
  // (order isn't guaranteed — "OFF" could sit alphabetically in the middle
  // of a venue's own list, not always last) doesn't truncate everything
  // after it. Two consecutive non-matching lines, though, means this has
  // stopped being a clean legend block — abort entirely rather than keep
  // scanning past it for a stray later match, which could otherwise walk
  // straight through an entirely different, unrelated section (e.g. a
  // blank-row-separated role header followed by real staff rows) and either
  // swallow those real rows into the excluded footer region, or fabricate a
  // bogus entry out of unrelated footer text — both confirmed via
  // real-world-shaped test cases during review.
  let consecutiveNonMatchCount = 0;

  for (let r = separatorIdx + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (isBlankRow(row)) continue; // allow further blank gaps within the footer

    const match = matchLegendRow(row);
    if (!match) {
      consecutiveNonMatchCount++;
      if (consecutiveNonMatchCount > 1) return empty; // two non-legend lines in a row — this isn't actually a legend footer
      continue; // tolerate exactly one non-matching line (a caption, or a timeless entry) before requiring the next real match
    }
    consecutiveNonMatchCount = 0; // a real entry resets the streak — a caption/timeless line elsewhere in the block gets its own fresh tolerance

    const key = match.code.toLowerCase();
    if (seenCodes.has(key)) continue; // first occurrence wins on an (unusual) repeated code
    seenCodes.add(key);
    map[key] = { start: match.start, end: match.end };
    legend.push({
      code: match.code,
      meaning: match.label ? `${match.label} (${match.start}-${match.end})` : `${match.start}-${match.end}`,
    });
  }

  // Only report the footer as a legend block (and have the caller exclude
  // it from ordinary staff-row processing) once we've actually resolved at
  // least one real entry from it — a blank-row separator followed by
  // unrelated content that doesn't match the legend shape at all (e.g. a
  // stray totals note) is left completely alone, same as before this
  // feature existed.
  return { legend, map, footerStartRow: legend.length > 0 ? separatorIdx : null };
}


export type CellParseResult =
  | { kind: 'blank' }
  | { kind: 'leave'; category: LeaveRecord['category']; code: string }
  | { kind: 'shifts'; intervals: ShiftInterval[]; /** am / pm had to be inferred. */ inferred?: boolean }
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
 * Parses one day-cell's raw content (or one day's sub-cells joined in column
 * order) into shift interval(s) or a leave code. Times are read by
 * shiftText.ts: "9-17", "17:00-01:00", "4pm to 2am", "11 17 18 25" (AM
 * start/end, PM start/end), "10am/3pm-7pm/12am", "10:30-4:00-8:00-12",
 * decimal hours and dot separators, "7a-3p", "12n", "1830-0200". Also
 * "10IN"/"12CL"/"IN", "4pm-close", "open-3pm" (open-ended / until-closing /
 * fully-flexible shorthand: flagged, never given an invented end) and
 * leave/absence codes ("OFF", "O", "X", "-", "REQ", "S/L", "HOL").
 */
function parseCellValue(raw: unknown, fileLegend?: Record<string, ShiftInterval>, timeOptions: ShiftTextOptions = {}): CellParseResult {
  if (isBlank(raw)) return { kind: 'blank' };
  const text = normalizeCell(raw);
  const lower = text.toLowerCase();

  // A code detected in THIS file's own legend takes precedence over the
  // fixed LEAVE_CODES table when both would match the same short code —
  // it's more specific (literally printed by this venue for this roster)
  // than a generic hardcoded absence vocabulary, and represents a real
  // worked shift rather than an absence, which is the more useful reading
  // of an otherwise-ambiguous short code.
  if (fileLegend && hasOwnKey(fileLegend, lower)) {
    const interval = fileLegend[lower];
    return { kind: 'shifts', intervals: [{ start: interval.start, end: interval.end }] };
  }

  if (hasOwnKey(LEAVE_CODES, lower)) return { kind: 'leave', category: LEAVE_CODES[lower], code: text };

  // Fully flexible / on-call: no fixed start or end at all.
  if (/^in$/i.test(text)) {
    return { kind: 'flagged', raw: text, reason: 'On call — no start or end time printed; set the hours.' };
  }
  // Open-ended cells: one end of the shift is printed, the other is "close" / "open" / left out.
  // They are flagged with what was read; the missing end is never invented.
  const open = openEndedCell(text, timeOptions);
  if (open) return { kind: 'flagged', raw: text, reason: open };
  // A dotted time this roster writes both ways (".5" beside "18.30"): shown to check, never guessed.
  if (ambiguousDottedTime(text, timeOptions)) {
    return { kind: 'flagged', raw: text, reason: 'This roster writes times both as hours.minutes ("18.30") and as decimal hours ("18.5"), so this cell could be read either way. Check it on the roster.' };
  }

  const read = parseShiftText(text, timeOptions);
  // Times that overlap or run on past a day are two days' cells run together: never saved on one day.
  if (read && !withinOneDay(read.segments)) {
    return { kind: 'flagged', raw: text, reason: 'These times overlap or run on past one day, so two days may have run together here. Check the days on the roster.' };
  }
  if (read) return { kind: 'shifts', intervals: read.segments.map((s) => ({ start: s.start, end: s.end })), ...(read.inferred ? { inferred: true } : {}) };

  return { kind: 'unresolved', raw: text };
}

/** One time as people type it: "10", "10:30", "18.30", "4pm", "7a", "1830", "noon". */
const TIME_WORD = String.raw`(?:\d{1,4}(?:[:.]\d{1,2})?\s*(?:a\.?m\.?|p\.?m\.?|a|p)?|noon|midnight|12\s*[nm])`;
const UNTIL = String.raw`(?:-|–|—|~|to|till|til|'til|until|thru)`;
const CLOSE = String.raw`(?:cl|close|closing|late|finish)`;

/**
 * An open-ended cell: the start is printed and the end is closing time or left out ("10IN",
 * "IN 10", "4CL", "4pm-close", "5 till close"), the end is printed and the start is opening time
 * ("open-3pm"), or neither ("to close", "open-close"). Returns what was read, for the manager, or
 * null when the cell is not one.
 */
function openEndedCell(text: string, timeOptions: ShiftTextOptions): string | null {
  const t = text.trim();
  /** "16:00" → "4 pm", "10:30" → "10:30 am", "12:00" → "12 pm", "00:00" → "midnight". */
  const plain = (hm: string) => {
    const [h, m] = hm.split(':').map(Number) as [number, number];
    if (h === 0 && m === 0) return 'midnight';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
  };
  const startIn = t.match(new RegExp(`^(?:in|start|from)\\s*[:\\-]?\\s*(${TIME_WORD})$`, 'i')) ?? t.match(new RegExp(`^(${TIME_WORD})\\s*(?:in|start|onwards?)$`, 'i'));
  if (startIn) {
    const at = parseSingleTime(startIn[1]!, timeOptions);
    if (at) return `Starts ${plain(at)} — no end time printed; set the end time.`;
  }
  const untilClose = t.match(new RegExp(`^(${TIME_WORD})\\s*${UNTIL}?\\s*${CLOSE}$`, 'i'));
  if (untilClose) {
    const at = parseSingleTime(untilClose[1]!, timeOptions);
    if (at) {
      // A closing shift that starts at a bare hour starts in the afternoon or evening ("4CL" =
      // 4 pm until close) unless "am" is written.
      const bare = /^\s*\d{1,2}(?:[:.]\d{2})?\s*$/.test(untilClose[1]!);
      const hour = Number(at.slice(0, 2));
      const startAt = bare && hour >= 1 && hour <= 11 ? `${String(hour + 12).padStart(2, '0')}${at.slice(2)}` : at;
      return `Starts ${plain(startAt)}, until close — no end time printed; set the end time.`;
    }
  }
  const fromOpen = t.match(new RegExp(`^(?:open|opening)\\s*${UNTIL}\\s*(${TIME_WORD})$`, 'i'));
  if (fromOpen) {
    const at = parseSingleTime(fromOpen[1]!, timeOptions);
    if (at) return `From opening until ${plain(at)} — no start time printed; set the start time.`;
  }
  if (new RegExp(`^(?:${UNTIL}\\s*)?${CLOSE}$|^(?:open|opening)\\s*${UNTIL}\\s*${CLOSE}$`, 'i').test(t)) {
    return 'Until close — no start or end time printed; set the hours.';
  }
  return null;
}

/** One cell's text read by the table reader's own rules — so the AI reader's cells mean the same. */
export function interpretCell(text: string, timeOptions: ShiftTextOptions = {}): CellParseResult {
  return parseCellValue(text, undefined, timeOptions);
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
  if (hasOwnKey(LEAVE_CODES, candidate.toLowerCase())) return false;
  if (canonicalRoleName(candidate) !== candidate) return true;
  if (!hasSeenAnyStaffRow) return false;
  const letters = candidate.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false; // too short to be a confident signal (avoids "AM"/"OK"/initials)
  return letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

interface DayColumn {
  /** The sheet columns this day (or day half) occupies: one, or several merged sub-columns. */
  colIndexes: number[];
  date: string;
  period: 'AM' | 'PM' | null;
  /** The header prints a weekday that `date` doesn't fall on ("Thu 19/08" when 19/08 is a Wednesday). */
  weekdayMismatch?: { header: string; printed: string; actual: string };
}

/**
 * One day's cell text: the sub-cells joined in column order ("11 17 18 25" from four
 * AM-start/AM-end/PM-start/PM-end columns). A label merged across the sub-columns (repeated by
 * merge expansion) counts once.
 */
function dayCellText(row: unknown[], col: DayColumn): string {
  const parts = col.colIndexes.map((c) => normalizeCell(row[c])).filter((v) => v !== '' && v !== '-');
  if (parts.length > 1 && parts.every((p) => p === parts[0]) && !/^\d+(?:[.:]\d+)?$/.test(parts[0]!)) return parts[0]!;
  return parts.join(' ');
}

/**
 * Structural override for the case-based header signal above: true when
 * ANY day-column cell on this row holds real shift-shaped content (a
 * worked interval, a leave code, or a recognized-but-flagged shorthand
 * like "10IN"). A genuine section-header row never carries that — it's a
 * caption, its day cells are blank (or, on a merge-expanded grid, repeat
 * the label itself, which parses as 'unresolved', not shift-shaped).
 *
 * This exists because the case/vocabulary signal in isRoleHeaderLabel is
 * defeated by an ALL-CAPS venue: once `hasSeenAnyStaffRow` flips true,
 * EVERY later ALL-CAPS row — including a real staff member's own ALL-CAPS
 * name — satisfies the pattern signal and gets misread as a new header,
 * silently dropping that employee's entire week (see the audit in
 * server/test-fixtures/edge-case-audit/). A row with real shift-shaped
 * data is unambiguous proof it's a staff row, regardless of casing or
 * vocabulary — checked BEFORE the case-based signal at every call site
 * below so it can never be overridden by it.
 */
function rowHasShiftShapedData(row: unknown[], columns: DayColumn[], fileLegend: Record<string, ShiftInterval>, timeOptions: ShiftTextOptions): boolean {
  for (const col of columns) {
    const parsed = parseCellValue(dayCellText(row, col), fileLegend, timeOptions);
    if (parsed.kind === 'shifts' || parsed.kind === 'leave' || parsed.kind === 'flagged') return true;
  }
  return false;
}

/**
 * Independent re-derivation of "how many rows in this grid plainly carry
 * real shift data", computed from scratch via parseCellValue alone — no
 * shared state with the classification loop below (no currentRole, no
 * hasSeenAnyStaffRow — the actual header-vs-staff heuristic this gate
 * exists to catch mistakes in). Used as a post-hoc sanity check: if the
 * classification loop's own count of successfully-processed staff rows
 * comes in lower than this independent count, something dropped real data
 * regardless of which code path caused it — see RosterExtractionAnomalyError.
 *
 * Mirrors the row-level exclusions the main loop itself applies before
 * a row can ever become a staff row — a blank label (no employee name), a
 * bare-number headcount/totals row, a summary or caption row — so this
 * doesn't count rows the main loop was never going to treat as staff in
 * the first place. Also counts a row whose day columns are blank but a
 * trailing notes column carries a recognizable leave code, matching the
 * same fallback processStaffRow applies (see `extraNoteExcludedCols`).
 */
function countRowsWithRealShiftData(
  grid: unknown[][],
  dataStartIdx: number,
  dataEndIdx: number,
  columns: DayColumn[],
  fileLegend: Record<string, ShiftInterval>,
  labelColIndex: number,
  excludedNoteCols: Set<number>,
  timeOptions: ShiftTextOptions,
): number {
  const dayColIndexSet = new Set(columns.flatMap((c) => c.colIndexes));
  let count = 0;
  for (let r = dataStartIdx; r < dataEndIdx; r++) {
    const row = grid[r] ?? [];
    const label = normalizeCell(row[labelColIndex]);
    if (!label) continue; // no employee name in this row -> can never become a staff row
    if (/^\d+(\.\d+)?$/.test(label)) continue; // headcount/totals row, same exclusion the main loop applies
    if (SUMMARY_ROW_LABELS.has(label.toLowerCase())) continue; // footer/summary caption
    if (CAPTION_WORDS.test(label) || isFooterOrNote(label)) continue; // caption / note line

    if (rowHasShiftShapedData(row, columns, fileLegend, timeOptions)) {
      count++;
      continue;
    }
    for (let c = 0; c < row.length; c++) {
      if (excludedNoteCols.has(c) || dayColIndexSet.has(c)) continue;
      const note = normalizeCell(row[c]);
      if (note && hasOwnKey(LEAVE_CODES, note.toLowerCase())) {
        count++;
        break;
      }
    }
  }
  return count;
}

// --- day headers ------------------------------------------------------------------------------

const PERIOD_CELL = /^(am|pm)$/i;
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The day labels a row prints, by column (column 0, the name column, never holds one). */
function rowDayLabels(row: unknown[]): Map<number, DayLabel> {
  const out = new Map<number, DayLabel>();
  for (let c = 1; c < row.length; c++) {
    const label = parseDayLabel(row[c] instanceof Date || typeof row[c] === 'number' ? row[c] : normalizeCell(row[c]));
    if (label) out.set(c, label);
  }
  return out;
}

/** Collapses runs of identical labels (one header merged across sub-columns) into one entry. */
function distinctRuns(labels: Map<number, DayLabel>): DayLabel[] {
  const out: DayLabel[] = [];
  let prevKey = '';
  for (const [, l] of [...labels].sort((a, b) => a[0] - b[0])) {
    const key = JSON.stringify(l);
    if (key !== prevKey) out.push(l);
    prevKey = key;
  }
  return out;
}

/**
 * Whether a row is a day-header row. Day and month names make it one outright (with at least
 * two days, and most of the row's cells being days). A row of digits only ("17/08 | 18/08") also
 * reads as shift times ("9-12" = 9 Dec), so it counts only as a run of consecutive days — which
 * a data row's shift times never form.
 */
function isDayHeaderRow(row: unknown[], labels: Map<number, DayLabel>): boolean {
  const runs = distinctRuns(labels);
  if (runs.length < 2) return false;
  let nonBlank = 0;
  // Column labels before the days ("NAME", "POSITION", "S/N") are not other text on the row.
  for (let c = 1; c < row.length; c++) if (normalizeCell(row[c]) && (labels.has(c) || !columnHeading(normalizeCell(row[c])))) nonBlank++;
  if (labels.size / Math.max(1, nonBlank) < 0.6) return false;
  if (runs.some((l) => !l.numericOnly)) return true;
  return isConsecutiveDayRun(runs);
}

function isPeriodRow(row: unknown[]): boolean {
  const cells = row.slice(1).map(normalizeCell).filter(Boolean);
  return cells.length >= 2 && cells.filter((c) => PERIOD_CELL.test(c)).length / cells.length >= 0.6;
}

interface HeaderBlock {
  dayRowIdxs: number[];
  periodRowIdx: number | null;
  dataStartIdx: number;
  /** Text printed above the header rows (titles such as "Rota 24 - 30 Aug"). */
  titles: string[];
}

/** Locates the stacked day-header rows (dates and/or weekdays), the AM/PM row under them, and any title above. */
function findHeaderBlock(grid: unknown[][]): HeaderBlock | null {
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const row = grid[r] ?? [];
    if (!isDayHeaderRow(row, rowDayLabels(row))) continue;
    const dayRowIdxs = [r];
    let periodRowIdx: number | null = null;
    let next = r + 1;
    // A second stacked header row (weekdays under dates, or dates under weekdays), then AM/PM.
    while (next < grid.length && next <= r + 3) {
      const candidate = grid[next] ?? [];
      if (periodRowIdx === null && isDayHeaderRow(candidate, rowDayLabels(candidate))) dayRowIdxs.push(next);
      else if (periodRowIdx === null && isPeriodRow(candidate)) periodRowIdx = next;
      else break;
      next++;
    }
    const titles: string[] = [];
    for (let t = 0; t < r; t++) {
      for (const cell of grid[t] ?? []) {
        const text = normalizeCell(cell);
        if (text && !titles.includes(text)) titles.push(text);
      }
    }
    return { dayRowIdxs, periodRowIdx, dataStartIdx: next, titles };
  }
  return null;
}

/** Combines what stacked header rows print over one column ("17-Aug" over "MONDAY"). */
function mergeLabels(a: DayLabel | undefined, b: DayLabel): DayLabel {
  if (!a) return b;
  return {
    weekday: a.weekday ?? b.weekday,
    day: a.day ?? b.day,
    month: a.month ?? b.month,
    year: a.year ?? b.year,
    numericOnly: a.numericOnly && b.numericOnly,
  };
}

export interface GridParseOptions {
  /** Today in the venue's timezone (YYYY-MM-DD): the reference for unprinted years. Default: weekStart. */
  today?: string;
  /** The week the client asked for; used only when the sheet prints no dates. Default: weekStart. */
  clientWeekStart?: string | null;
  /** Page and row of each grid row in the source file (PDF reconstruction); default: the grid row. */
  rowRefs?: { page: number | null; row: number }[];
  /**
   * Day cells (page and row as in rowRefs, and the grid column) whose day the PDF reader could
   * only infer from how the columns line up: their shifts are kept, flagged to check.
   */
  inferredCells?: { page: number | null; row: number; col: number }[];
}

function buildDayColumns(
  grid: unknown[][],
  header: HeaderBlock,
  ctx: { today: string; clientWeekStart: string | null },
): { columns: DayColumn[]; week: WeekDetection } | null {
  const labelsByCol = new Map<number, DayLabel>();
  const rawByCol = new Map<number, string>();
  for (const r of header.dayRowIdxs) {
    for (const [c, l] of rowDayLabels(grid[r] ?? [])) {
      labelsByCol.set(c, mergeLabels(labelsByCol.get(c), l));
      rawByCol.set(c, [rawByCol.get(c), normalizeCell(grid[r]![c])].filter(Boolean).join(' '));
    }
  }
  const cols = [...labelsByCol.keys()].sort((a, b) => a - b);
  if (cols.length === 0) return null;
  // One slot per printed day: adjacent columns printing the same label are one merged day.
  const slots: { cols: number[]; label: DayLabel }[] = [];
  for (const c of cols) {
    const label = labelsByCol.get(c)!;
    const last = slots[slots.length - 1];
    if (last && last.cols[last.cols.length - 1] === c - 1 && JSON.stringify(last.label) === JSON.stringify(label)) last.cols.push(c);
    else slots.push({ cols: [c], label });
  }
  // A day header that was merged across sub-columns but saved without its merge (CSV) prints
  // only over the first one: the blank-headed columns up to the next day belong to that day.
  // The last day takes as many as the others do.
  const headerRows = header.dayRowIdxs.map((r) => grid[r] ?? []);
  const blankHeaded = (c: number) => headerRows.every((row) => !normalizeCell(row[c]));
  const widths: number[] = [];
  slots.forEach((slot, i) => {
    const next = slots[i + 1]?.cols[0];
    const usualWidth = widths.length ? Math.round(widths.reduce((a, b) => a + b, 0) / widths.length) : 1;
    const limit = next ?? slot.cols[slot.cols.length - 1]! + Math.max(0, usualWidth - slot.cols.length) + 1;
    for (let c = slot.cols[slot.cols.length - 1]! + 1; c < limit && blankHeaded(c); c++) slot.cols.push(c);
    if (next !== undefined) widths.push(slot.cols.length);
  });
  const { week, dates } = detectWeek(slots.map((s) => s.label), header.titles, ctx);
  const periodRow = header.periodRowIdx !== null ? grid[header.periodRowIdx] ?? [] : null;
  const columns: DayColumn[] = [];
  slots.forEach((slot, i) => {
    const date = dates[i];
    if (!date) return;
    const printedWeekday = slot.label.weekday;
    const actual = weekdayOf(date);
    const mismatch =
      printedWeekday !== null && printedWeekday !== actual
        ? { header: rawByCol.get(slot.cols[0]!) ?? '', printed: WEEKDAY_NAMES[printedWeekday]!, actual: WEEKDAY_NAMES[actual]! }
        : undefined;
    // AM/PM sub-columns split the day; without them, all of the day's columns are one cell. A
    // blank sub-header cell belongs to the period printed before it (a merge saved without it).
    const byPeriod = new Map<string, number[]>();
    let carried = '';
    for (const c of slot.cols) {
      const p = periodRow ? normalizeCell(periodRow[c]).toUpperCase() : '';
      const key = p === 'AM' || p === 'PM' ? p : p ? '' : carried;
      carried = key;
      byPeriod.set(key, [...(byPeriod.get(key) ?? []), c]);
    }
    for (const [p, colIndexes] of byPeriod) {
      columns.push({ colIndexes, date, period: (p || null) as DayColumn['period'], ...(mismatch ? { weekdayMismatch: mismatch } : {}) });
    }
  });
  return { columns, week };
}

/** A title cell: a role word or abbreviation, or a word with a position number ("Waiter 3"). A number alone ("1042") is an ID, not a title. */
const roleishCell = (v: string) =>
  isRecognizedRoleAlias(v) || isRecognizedRoleAlias(v.replace(/\s*\d+$/, '')) || /[A-Za-z].*\d/.test(v) || /^[A-Z]{2,4}$/.test(v) || canonicalRoleName(v) !== v || isRoleTitle(v);
/** A name cell: words of letters that are not a title. */
const nameishCell = (v: string) => looksLikePersonName(v) && !roleishCell(v);
/** An index, row-number or ID cell ("1", "12.", "#7", "104233", "E-1042", "PR0042"): never a name. */
const indexCell = (v: string) => /^#?\d{1,4}[.)]?$/.test(v) || /^[A-Za-z]{0,4}[-_#/ ]?\d{3,10}$/.test(v);

/**
 * Two leading columns before the days: which is the per-row title ("RM", "Head waiter 1",
 * "Sup") and which the person's name? Titles repeat a role word, carry numbers or short
 * capital abbreviations; names are words of letters. Returns null when neither column leans.
 */
function titleColumnByContent(pairs: { col0: string; col1: string }[]): 0 | 1 | null {
  const score = (vals: string[]) => vals.filter(roleishCell).length - vals.filter(nameishCell).length;
  const s0 = score(pairs.map((p) => p.col0));
  const s1 = score(pairs.map((p) => p.col1));
  if (s0 === s1) return null;
  return s0 > s1 ? 0 : 1;
}

/**
 * Three or more leading columns before the days ("No. | NAME | POSITION", "Position | S/N |
 * Staff", "# | Employee | Role | Dept"): which one holds the person's name and which the
 * per-row title. Headings printed over the columns say it outright; otherwise content decides
 * — an index column holds numbers, a title column repeats role words and abbreviations, a
 * name column holds words of letters. An index column is never the name column. Null when no
 * column reads as names.
 */
function leadColumnsByHeadingAndContent(headings: (ReturnType<typeof columnHeading>)[], values: string[][]): { name: number; title: number } | null {
  const read = values.map((vals, c) => {
    const filled = vals.filter(Boolean);
    const share = (f: (v: string) => boolean) => (filled.length ? filled.filter(f).length / filled.length : 0);
    return { c, said: headings[c] ?? null, ids: share(indexCell), names: share(nameishCell), roles: share(roleishCell) };
  });
  // A heading row printed off its columns (a broken export) puts "NAME" over the row numbers and
  // "POSITION" over the names: when any heading is plainly contradicted by its column's own cells,
  // no heading of that row is believed, and the cells alone decide.
  const contradicted = read.some((k) =>
    k.said === 'name' ? k.ids >= 0.6 || k.roles > k.names : k.said === 'index' ? k.names >= 0.6 : k.said === 'title' ? k.ids >= 0.6 || (k.names >= 0.6 && k.roles < 0.2) : false,
  );
  const cols = read.map((k) => {
    const heading = contradicted ? null : k.said;
    return { c: k.c, heading, index: heading === 'index' || k.ids >= 0.6, names: k.names, roles: k.roles };
  });
  const candidates = cols.filter((k) => !k.index && k.heading !== 'title' && k.heading !== 'other');
  const name = candidates.find((k) => k.heading === 'name') ?? [...candidates].filter((k) => k.names > 0).sort((a, b) => b.names - b.roles - (a.names - a.roles))[0];
  if (!name) return null;
  const rest = cols.filter((k) => k.c !== name.c);
  const title =
    rest.find((k) => k.heading === 'title') ??
    [...rest].filter((k) => !k.index && k.heading !== 'other' && k.roles > 0).sort((a, b) => b.roles - b.names - (a.roles - a.names))[0] ??
    rest.find((k) => k.index) ??
    rest[0]!;
  return { name: name.c, title: title.c };
}

/** A row number printed in front of a name in the same cell ("1 Marites Horvat", "12. Ana Silva"): the name alone. */
function withoutLeadingIndex(label: string): string {
  const rest = label.replace(/^#?\d{1,3}[.)]?\s+(?=\p{L})/u, '');
  return rest !== label && looksLikePersonName(rest) ? rest : label;
}

/**
 * Parses a merge-expanded grid into ShiftSync's canonical result contract.
 * Returns 0 rows (with no anomalies) when the grid doesn't look like a
 * day-grid roster at all (e.g. no recognizable date header row) — callers
 * should treat that as "not this shape" and try another path, not as a
 * hard error.
 *
 * `weekStart` is the fallback reference week: the year reference when
 * `options.today` is not given, and the week for weekday-only headers when
 * `options.clientWeekStart` is not given (callers that pass both use it for
 * nothing else). Besides rows, the result lists every person read
 * (`people`, including people with no shifts that week), rows that could not
 * be read (`unreadRows`) and the detected `week`.
 */
export function parseExcelGrid(grid: unknown[][], weekStart: string, options: GridParseOptions = {}): ParsedVisionResult {
  const rows: ParsedShiftRow[] = [];
  const issues: RowIssue[] = [];
  const anomalies: AnomalyRecord[] = [];
  const leaveRecords: LeaveRecord[] = [];
  const people: ReadPerson[] = [];
  const unreadRows: UnreadRow[] = [];
  const refOf = (r: number) => options.rowRefs?.[r] ?? { page: null, row: r + 1 };
  const inferredCells = new Set((options.inferredCells ?? []).map((c) => `${c.page}:${c.row}:${c.col}`));

  const header = findHeaderBlock(grid);
  if (!header) {
    return { templateLabel: 'Deterministic Grid Parser (no day-header row detected)', rows, issues, anomalies, leaveRecords, legend: [] };
  }
  const built = buildDayColumns(grid, header, {
    today: options.today ?? weekStart,
    clientWeekStart: options.clientWeekStart === undefined ? weekStart : options.clientWeekStart,
  });
  if (!built || built.columns.length === 0) {
    return { templateLabel: 'Deterministic Grid Parser (no resolvable day columns)', rows, issues, anomalies, leaveRecords, legend: [] };
  }
  const { columns, week } = built;

  // Legend detection is additive: when no legend block is found (the vast
  // majority of files), `fileLegend` is an empty map and `parseCellValue`'s
  // new lookup is always a no-op, leaving every existing code path
  // (LEAVE_CODES-only resolution) completely unchanged from before.
  const { legend, map: fileLegend, footerStartRow } = detectLegend(grid, header.dataStartIdx);
  // A confirmed legend block is footer content, not staff data — excluded
  // from the ordinary staff-row loop below entirely, so a legend row (e.g.
  // "M | Morning | 07:00-15:00") is never itself misread as a staff name
  // with shift cells (that time range would otherwise parse as a valid
  // shift on its own).
  const dataEndIdx = footerStartRow ?? grid.length;

  // How this sheet writes dotted times ("18.30" = 18:30 when any cell shows ".30"; else decimal hours).
  const dayTexts: string[] = [];
  for (let r = header.dataStartIdx; r < dataEndIdx; r++) for (const col of columns) dayTexts.push(dayCellText(grid[r] ?? [], col));
  const timeOptions: ShiftTextOptions = { dotMeans: sheetDotStyle(dayTexts) };
  const cellOf = (row: unknown[], col: DayColumn) => parseCellValue(dayCellText(row, col), fileLegend, timeOptions);
  const hasData = (row: unknown[]) => rowHasShiftShapedData(row, columns, fileLegend, timeOptions);
  const daysBlank = (row: unknown[]) => columns.every((col) => dayCellText(row, col) === '');
  /** One label merged across the whole row: every filled cell (at least three) carries the same text. */
  const isMergedBanner = (row: unknown[]) => {
    const filled = row.map(normalizeCell).filter(Boolean);
    return filled.length >= 3 && filled.every((v) => v === filled[0]) && !hasData(row);
  };

  // Most rosters have exactly one leading column (the staff name). Some
  // print an explicit per-row title in its own column before the name
  // (e.g. "RM" | "Nedak Mizon" | ... — Bar des Pres FOH style), on top
  // of (or instead of) grouping staff under section headers. Inferred from
  // where the day columns actually start, rather than hardcoded, so both
  // shapes work without knowing in advance which one a given file uses.
  const firstDayColIndex = Math.min(...columns.flatMap((c) => c.colIndexes));
  const lastDayColIndex = Math.max(...columns.flatMap((c) => c.colIndexes));
  const hasTitleColumn = firstDayColIndex >= 2;
  let nameColIndex = hasTitleColumn ? firstDayColIndex - 1 : 0;
  let titleColIndex: number | null = hasTitleColumn ? 0 : null;

  // With exactly 2 leading columns, position alone can't say which is the
  // staff name and which is the role — "Role, Name, Mon..." and the reverse
  // "Name, Role, Mon..." are structurally identical from the header row
  // alone. Disambiguate by content: titles repeat role words, carry numbers
  // ("Waiter 3") or short capital abbreviations ("RM", "JAM"); names are
  // words of letters. Rows where both columns hold the same text (a label
  // merged across both) say nothing and are left out. With no lean either
  // way the sheet is genuinely ambiguous and gets flagged for manual review
  // below instead of silently resolved on a guess either way.
  let columnOrderAmbiguous = false;
  /** The heading printed over a leading column on the day-header rows or the row of labels just under them. */
  const headingOf = (c: number) =>
    [...header.dayRowIdxs, header.dataStartIdx]
      .map((r) => {
        const row = grid[r] ?? [];
        // The row of labels under the days counts only when its days are blank and it holds labels alone.
        if (r === header.dataStartIdx && !(daysBlank(row) && row.slice(0, firstDayColIndex).every((v) => !normalizeCell(v) || columnHeading(normalizeCell(v))))) return null;
        return columnHeading(normalizeCell(row[c]));
      })
      .find(Boolean) ?? null;
  if (hasTitleColumn && firstDayColIndex === 2) {
    const pairs: { col0: string; col1: string }[] = [];
    for (let r = header.dataStartIdx; r < dataEndIdx; r++) {
      const v0 = normalizeCell(grid[r]?.[0]);
      const v1 = normalizeCell(grid[r]?.[1]);
      if (v0 && v1 && v0 !== v1 && !CAPTION_WORDS.test(v0) && !CAPTION_WORDS.test(v1)) pairs.push({ col0: v0, col1: v1 });
    }
    // Headings printed over the two columns ("NAME" | "TITLE", in either order) say it outright —
    // unless a heading is plainly contradicted by its column's cells (a header row printed off its
    // columns puts "NAME" over the row numbers). An ID or row-number column is never the names.
    const [h0, h1] = [headingOf(0), headingOf(1)];
    const shareOf = (c: 0 | 1, f: (v: string) => boolean) => (pairs.length ? pairs.filter((p) => f(c === 0 ? p.col0 : p.col1)).length / pairs.length : 0);
    const ids = [shareOf(0, indexCell), shareOf(1, indexCell)];
    const names = [shareOf(0, nameishCell), shareOf(1, nameishCell)];
    const roles = [shareOf(0, roleishCell), shareOf(1, roleishCell)];
    const contradicted = [h0, h1].some((h, c) =>
      h === 'name' ? ids[c]! >= 0.6 || roles[c]! > names[c]! : h === 'index' ? names[c]! >= 0.6 : h === 'title' ? ids[c]! >= 0.6 || (names[c]! >= 0.6 && roles[c]! < 0.2) : false,
    );
    const byHeading = contradicted ? null : h0 === 'title' || h1 === 'name' ? 0 : h0 === 'name' || h1 === 'title' ? 1 : null;
    let titleCol = byHeading ?? titleColumnByContent(pairs);
    if (ids[0]! >= 0.6 && ids[1]! < 0.6) titleCol = 0;
    else if (ids[1]! >= 0.6 && ids[0]! < 0.6) titleCol = 1;
    if (titleCol === 1) {
      titleColIndex = 1;
      nameColIndex = 0;
    } else if (titleCol === null) {
      columnOrderAmbiguous = pairs.length > 0;
    }
  } else if (hasTitleColumn) {
    const values: string[][] = [];
    for (let c = 0; c < firstDayColIndex; c++) {
      const vals: string[] = [];
      for (let r = header.dataStartIdx; r < dataEndIdx; r++) {
        const row = grid[r] ?? [];
        const v = normalizeCell(row[c]);
        // A banner merged across the leading columns says nothing about any one of them.
        if (v && !CAPTION_WORDS.test(v) && !isMergedBanner(row) && !row.slice(0, firstDayColIndex).every((o) => normalizeCell(o) === v)) vals.push(v);
      }
      values.push(vals);
    }
    const lead = leadColumnsByHeadingAndContent(
      values.map((_, c) => headingOf(c)),
      values,
    );
    if (lead) {
      nameColIndex = lead.name;
      titleColIndex = lead.title;
    }
  }

  // Columns to the right of the days that run alongside rows which are not people (a banner, a
  // headcount line, an empty row): a colour key or side legend, not anyone's notes.
  const sideLegendCols = new Set<number>();
  for (let r = header.dataStartIdx; r < dataEndIdx; r++) {
    const row = grid[r] ?? [];
    const label = normalizeCell(row[hasTitleColumn ? nameColIndex : 0]);
    const personLike = label && !/^\d+(\.\d+)?$/.test(label);
    if (personLike && !(daysBlank(row) && isRoleHeaderLabel(label, true))) continue;
    for (let c = lastDayColIndex + 1; c < row.length; c++) if (normalizeCell(row[c])) sideLegendCols.add(c);
  }

  // An "ALL-CAPS venue": every row that carries real shift data has its staff name in capitals.
  // There, "written in caps" says nothing about a label being a section header (a staff member
  // with a blank week looks exactly like one), so a header recognised ONLY by that pattern is
  // treated like an unrecognised header below — provisional and flagged for the manager —
  // instead of silently relabelling everyone beneath it. Vocabulary matches are unaffected.
  const dataLabels: string[] = [];
  for (let r = header.dataStartIdx; r < dataEndIdx; r++) {
    const row = grid[r] ?? [];
    const label = normalizeCell(row[hasTitleColumn ? nameColIndex : 0]);
    if (!label || /^\d+(\.\d+)?$/.test(label) || !hasData(row)) continue;
    dataLabels.push(label);
  }
  const allCapsVenue = !columnOrderAmbiguous && dataLabels.length >= 2 && dataLabels.every(isAllCapsLabel);
  const mixedCaseVenue = dataLabels.some((l) => !isAllCapsLabel(l));
  // Where people carry their own title (the title-column shape), the share of rows with shifts that print one.
  let titledRows = 0;
  let dataRows = 0;
  if (hasTitleColumn && !columnOrderAmbiguous) {
    for (let r = header.dataStartIdx; r < dataEndIdx; r++) {
      const row = grid[r] ?? [];
      if (!normalizeCell(row[nameColIndex]) || !hasData(row)) continue;
      dataRows++;
      if (normalizeCell(row[titleColIndex!]) && !/^\d+$/.test(normalizeCell(row[titleColIndex!]))) titledRows++;
    }
  }
  const peopleCarryTitles = dataRows >= 3 && titledRows / dataRows >= 0.8;
  // A name column that writes the title in the same cell ("Ana Silva / Waiter", "Ana Silva (RM)"):
  // the column's own order, from all its cells, so a title no vocabulary knows splits off too.
  const nameColumnLabels: string[] = [];
  for (let r = header.dataStartIdx; r < dataEndIdx; r++) nameColumnLabels.push(normalizeCell(grid[r]?.[hasTitleColumn ? nameColIndex : 0]));
  const combinedOrder = combinedLabelOrder(nameColumnLabels);
  /** A name cell that holds the title too, split; null when it holds a name (or a heading) alone. */
  const splitLead = (label: string) => (label ? splitNameTitle(label, combinedOrder) : null);
  /** A header that only the ALL-CAPS pattern recognised, in a sheet where that pattern proves nothing. */
  const isPatternOnlyHeaderInCapsVenue = (label: string) => allCapsVenue && canonicalRoleName(label) === label;

  // How THIS sheet prints its section banners, learned from the banners the role vocabulary
  // recognises: centred / merged across the days (never alone in the name column), and/or in
  // capitals. A blank-week label that doesn't look like the sheet's own banners is a person.
  const knownBanners: { text: string; awayFromName: boolean }[] = [];
  if (!hasTitleColumn) {
    for (let r = header.dataStartIdx; r < dataEndIdx; r++) {
      const row = grid[r] ?? [];
      if (hasData(row)) continue;
      const inDays = columns.map((col) => dayCellText(row, col)).filter(Boolean);
      const first = normalizeCell(row[0]);
      for (const text of new Set([first, ...inDays])) {
        if (text && canonicalRoleName(text) !== text) knownBanners.push({ text, awayFromName: inDays.includes(text) });
      }
    }
  }
  const bannersAwayFromName = knownBanners.length > 0 && knownBanners.every((b) => b.awayFromName);
  const bannersInCaps = knownBanners.length > 0 && knownBanners.every((b) => isAllCapsLabel(b.text));
  /** A name-column label printed unlike every banner of this sheet. */
  const unlikeSheetBanners = (label: string) => bannersAwayFromName || (bannersInCaps && !isAllCapsLabel(label));

  let currentRole = '';
  /** The section banner the following people are listed under, as printed (null before any). */
  let currentSection: string | null = null;
  // True whenever `currentRole` was set by the unrecognized-section-header
  // promotion below (or hasn't been set to anything real yet), false once
  // it's been set by a REAL, recognized header (vocabulary or ALL-CAPS
  // match). A provisional role is safe to freely replace with the next
  // provisional candidate — that's what lets a run of several unrecognized
  // headers (e.g. fixture 2's "Poolside Detail" -> "Shisha Terrace" ->
  // "Valet & Door") each correctly take over from the last. A REAL role
  // must never be silently overwritten by an ambiguous blank row, though
  // — a blank-week employee sitting INSIDE an already-correct section is
  // a person, never a new header.
  let currentRoleIsProvisional = true;
  let rowNumber = 1;
  let hasSeenAnyStaffRow = false;
  /** People rows read so far (to tell a blank-week person in a header-less first group from a heading). */
  let peopleSoFar = 0;
  // One value per physical sheet row treated as a staff row (unlike
  // `rowNumber` above, a per-SHIFT counter — one busy employee's several
  // shifts share one `sourceRowIndex` but get different `rowNumber`s), so a
  // consumer can group shifts by the actual employee record instead of by
  // name alone (two different real staff sharing a name land on different
  // physical rows, hence different indices).
  let sourceRowCounter = 0;
  const dayColIndexes = new Set(columns.flatMap((c) => c.colIndexes));

  const setSection = (label: string, provisional: boolean) => {
    currentRole = label;
    currentSection = label;
    currentRoleIsProvisional = provisional;
  };
  const addPerson = (r: number, name: string, roleLabel: string | null): string => {
    const ref = refOf(r);
    const personKey = personKeyOf(name, ref.page, ref.row);
    people.push({ personKey, name, roleLabel: roleLabel || null, section: currentSection, sourcePage: ref.page, sourceRow: ref.row, readerSource: 'table' });
    peopleSoFar++;
    return personKey;
  };
  const addUnread = (r: number, text: string, reason: string) => {
    const ref = refOf(r);
    unreadRows.push({ page: ref.page, row: ref.row, text, reason });
  };

  /**
   * Parses every day-column cell for one confirmed staff row (shared by
   * both column shapes below). Returns whether real shift/leave data was
   * found — feeds the post-loop sanity check (RosterExtractionAnomalyError).
   */
  function processStaffRow(
    r: number,
    row: unknown[],
    employeeName: string,
    roleName: string,
    extraNoteExcludedCols: Set<number>,
    sourceRowIndex: number,
    personKey: string,
  ): boolean {
    const ref = refOf(r);
    let hasShiftOrLeaveThisRow = false;
    for (const col of columns) {
      const parsed = cellOf(row, col);
      if (parsed.kind === 'blank') continue;
      // A day the PDF reader could only infer from the column alignment is never saved silently.
      const dayInferred = col.colIndexes.some((c) => inferredCells.has(`${ref.page}:${ref.row}:${c}`));

      // The date wins (it's the more specific of the two), but a weekday that
      // disagrees with it means the column may be the wrong day: flag every
      // entry under it for the manager rather than guess.
      if (col.weekdayMismatch) {
        const { header: printedHeader, printed, actual } = col.weekdayMismatch;
        anomalies.push({
          employeeName,
          date: col.date,
          rawText: printedHeader,
          reason: `The day header says ${printed}, but ${col.date} is a ${actual}. Check which day this is before confirming.`,
          confidence: 0.5,
          rowNumber: parsed.kind === 'shifts' ? rowNumber : null,
        });
      }

      if (parsed.kind === 'leave') {
        hasShiftOrLeaveThisRow = true;
        leaveRecords.push({ employeeName, date: col.date, leaveCode: parsed.code, category: parsed.category, ...(dayInferred ? { inferredDay: true } : {}) });
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
          sourceRowIndex,
          employeeName,
          roleName,
          date: col.date,
          startTime: interval.start,
          endTime: interval.end,
          overnight: isOvernight(interval.start, interval.end),
          breakMinutes: 0,
          managerNotes: col.period ? `[${col.period}]` : null,
          personKey,
          section: currentSection,
          sourcePage: ref.page,
          readerSource: 'table',
          ...(dayInferred ? { inferredDay: true, flags: ['low_confidence' as const] } : {}),
          ...(parsed.inferred ? { inferredTimes: true } : {}),
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
    // to someone who worked normally) is never misread as an absence. A
    // side legend (colour key) running alongside the rows is nobody's note.
    if (!hasShiftOrLeaveThisRow) {
      for (let c = 0; c < row.length; c++) {
        if (extraNoteExcludedCols.has(c) || dayColIndexes.has(c) || sideLegendCols.has(c)) continue;
        const note = normalizeCell(row[c]);
        if (!note) continue;
        const lower = note.toLowerCase();
        if (hasOwnKey(LEAVE_CODES, lower)) {
          leaveRecords.push({ employeeName, date: week.weekStart, leaveCode: note, category: LEAVE_CODES[lower] });
          hasShiftOrLeaveThisRow = true;
          break; // one leave record is enough to surface "this person is out"
        }
      }
    }
    return hasShiftOrLeaveThisRow;
  }

  // Independently re-derived (see countRowsWithRealShiftData) count of rows
  // that plainly carry real shift data, versus how many the classification
  // loop below actually routed into processStaffRow and found data for.
  // Compared after the loop — see RosterExtractionAnomalyError.
  let staffRowsWithRealDataProcessed = 0;

  // Raw label text of every row promoted to a provisional section header
  // (see the `!hasTitleColumn` branch below) — one AnomalyRecord is
  // emitted per unique text after the loop, listing every row it ended up
  // grouping, rather than one per occurrence.
  const unrecognizedHeaderTexts = new Set<string>();
  const HEADING_NOTE = 'Read as a section heading. If this is a person with no shifts this week, add them on the review screen.';

  // The last row of the listing that holds a shift, a time or a leave code. Below it, a line with
  // text in its days but no data there is a footer or a sign-off (spread across the page), never
  // a person.
  let lastDataRow = -1;
  for (let r = header.dataStartIdx; r < dataEndIdx; r++) if (hasData(grid[r] ?? [])) lastDataRow = r;

  for (let r = header.dataStartIdx; r < dataEndIdx; r++) {
    const row = grid[r] ?? [];

    // A line with no shift, time or leave in any day that reads, anywhere along it, as a label, a
    // form line, a footer or a row of column headings ("Checked by: ____", "Date:", "Page 2 of 3",
    // "Office use only", "Payroll ID | Name | Pos"): never a person, wherever it sits and in
    // whatever column order — even when what is left in the name column looks like a name.
    if (!hasData(row) && (row.some((c) => isLabelLine(normalizeCell(c))) || row.filter((c) => columnHeading(normalizeCell(c))).length >= 2)) continue;
    if (lastDataRow >= 0 && r > lastDataRow && !hasData(row) && !daysBlank(row)) {
      const label = withoutLeadingIndex(normalizeCell(row[hasTitleColumn ? nameColIndex : 0]));
      if (looksLikePersonName(label) && !nonPersonReason(label)) addUnread(r, row.map(normalizeCell).filter(Boolean).join(' | '), BELOW_ROSTER);
      continue;
    }

    if (!hasTitleColumn) {
      // Single-label-column shape: the name column IS where a role/section
      // header also appears (e.g. Gattopardo's "SUPERVISORS"), so header
      // vs. real name is discriminated by content, not position.
      const leadText = withoutLeadingIndex(normalizeCell(row[0]));
      // Name and title in one cell: the name is the label, the title is this person's own role.
      const combined = splitLead(leadText);
      const firstCell = combined?.name ?? leadText;
      const roleOfRow = combined?.title || currentRole;
      if (SUMMARY_ROW_LABELS.has(firstCell.toLowerCase()) || (firstCell && isFooterOrNote(firstCell))) continue; // footer/summary/totals line, never a staff row or a real section header

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
        const v = dayCellText(row, col);
        if (v) nonBlankValues.push(v);
      }
      if (nonBlankValues.length === 0) continue; // fully blank row

      const rowHasData = hasData(row);
      // A label merged across the whole row heads a section (provisionally when the vocabulary doesn't know it).
      if (isMergedBanner(row) && !CAPTION_WORDS.test(nonBlankValues[0]!) && !isRoleHeaderLabel(nonBlankValues[0]!, hasSeenAnyStaffRow) && !isSentence(nonBlankValues[0]!)) {
        setSection(nonBlankValues[0]!, true);
        unrecognizedHeaderTexts.add(nonBlankValues[0]!);
        continue;
      }
      // A caption line (covers / events / notes) or a footer describes the day, never a person.
      if (firstCell && !rowHasData && (CAPTION_WORDS.test(firstCell) || isFooterOrNote(firstCell) || (mixedCaseVenue && isAllCapsLabel(firstCell) && !daysBlank(row) && !isRoleHeaderLabel(firstCell, false)))) continue;

      // Role/section-header detection takes priority over everything else
      // below: a header row can carry an unrelated stray value alongside
      // the label itself (e.g. a headcount summary number sharing a
      // reconstructed PDF row with "HEAD WAITERS" due to imprecise row
      // clustering) — if ANY value in this row is recognized as a header
      // label, that's the section header for the rows beneath it.
      //
      // Structural override checked first: a row with real shift-shaped
      // data in its day columns is proof it's a staff row, regardless of
      // what isRoleHeaderLabel's case/vocabulary signal would otherwise
      // say — this is what stops an ALL-CAPS staff name from being
      // misread as a new section header once hasSeenAnyStaffRow is true.
      // Likewise, on a sheet whose banners sit away from the name column, a
      // name-column label in capitals is a person, not a banner.
      const roleMatch = rowHasData
        ? undefined
        : nonBlankValues.find((v) => isRoleHeaderLabel(v, hasSeenAnyStaffRow) && !(v === firstCell && bannersAwayFromName && canonicalRoleName(v) === v));
      if (roleMatch) {
        const provisional = isPatternOnlyHeaderInCapsVenue(roleMatch);
        setSection(roleMatch, provisional);
        if (provisional) {
          unrecognizedHeaderTexts.add(roleMatch);
          if (roleMatch === firstCell) addUnread(r, roleMatch, HEADING_NOTE);
        }
        continue;
      }

      // A bare number in the name column (and no role keyword found above) is a headcount/totals row.
      if (/^\d+(\.\d+)?$/.test(firstCell)) continue;
      if (!firstCell) {
        // Blank name column but real shift-shaped data sits in this row's
        // day columns — a real, observed cause (see the round-2 audit): a
        // staff-name cell vertically merged across several rows in the
        // source file (parseWorkbook.ts's expandMergedCells deliberately
        // never auto-expands a vertical merge — see its own doc comment)
        // leaves every row but the merge's own top-left with a genuinely
        // blank name cell, each still carrying its OWN real, different
        // shift pattern underneath. Silently dropping this data, or —
        // worse — ever attributing it to whoever the last real employee
        // happened to be, is exactly the failure shape this feature
        // exists to avoid; surface it as its own explicit anomaly instead.
        if (rowHasData) {
          const dayCellSummary = columns
            .map((col) => {
              const v = dayCellText(row, col);
              return v ? `${col.date}: ${v}` : null;
            })
            .filter((v): v is string => v !== null)
            .join(', ');
          anomalies.push({
            employeeName: null,
            date: null,
            rawText: dayCellSummary,
            reason:
              `This row has real shift data (${dayCellSummary}) but no staff name — likely a name ` +
              `cell merged across several rows in the source file, each with its own real, different ` +
              `shift pattern. Never auto-attributed to another employee — please check the source ` +
              `file (a vertically merged name cell is the most common cause) and re-upload.`,
            confidence: 0,
            rowNumber: null,
            kind: 'unrecognized_merged_name_cell',
          });
          addUnread(r, dayCellSummary, 'This row has shifts but no name.');
          continue;
        }
        // One heading printed away from the name column (centred across the days): a section
        // banner the role vocabulary doesn't know. It can't be a person — names sit in the name
        // column — so it groups the rows below, provisionally and flagged.
        const texts = [...new Set(nonBlankValues)];
        if (texts.length === 1 && !/^\d+(\.\d+)?$/.test(texts[0]!) && !isFooterOrNote(texts[0]!) && !CAPTION_WORDS.test(texts[0]!) && !isSentence(texts[0]!)) {
          setSection(texts[0]!, true);
          unrecognizedHeaderTexts.add(texts[0]!);
        }
        continue; // no employee name in this row — can't emit a staff row either way
      }

      // A department or section word alone on a blank row ("BAR", "HOSTS") heads the rows below it.
      if (!rowHasData && daysBlank(row) && isSectionLabel(firstCell)) {
        setSection(firstCell, false);
        continue;
      }
      // A title, column heading or caption in the name column is never a person, whatever is
      // beside it ("Waiter 3" with shifts is a position nobody's name is on): its shifts are
      // shown as an unread row, never imported under a title.
      const notPerson = nonPersonReason(firstCell);
      if (notPerson) {
        if (notPerson === UNREADABLE_NAME) {
          addUnread(r, [firstCell, ...columns.map((col) => dayCellText(row, col))].filter(Boolean).join(' | '), UNREADABLE_ROW);
          if (rowHasData) staffRowsWithRealDataProcessed++;
        } else if (rowHasData) {
          addUnread(r, [firstCell, ...columns.map((col) => dayCellText(row, col))].filter(Boolean).join(' | '), `"${firstCell}" reads as ${notPerson}; its shifts were not imported. Add them by hand if they belong to someone.`);
          staffRowsWithRealDataProcessed++;
        }
        continue;
      }

      // A named row. With shift/leave data it is a person; with nothing in its days it is a
      // person with no shifts this week — or a section heading the vocabulary doesn't know.
      const employeeName = firstCell;
      const peopleBefore = peopleSoFar;
      hasSeenAnyStaffRow = true;
      if (rowHasData || !daysBlank(row)) {
        const key = addPerson(r, employeeName, roleOfRow);
        if (processStaffRow(r, row, employeeName, roleOfRow, new Set([0]), sourceRowCounter++, key)) staffRowsWithRealDataProcessed++;
        continue;
      }

      // Every day cell is blank. A name-like label inside a section whose header is real (or in
      // a header-less first group that already has people), or printed unlike every banner of
      // this sheet, is a person with a blank week. A label that names a group, is written in
      // capitals among mixed-case names, or opens the listing is a heading the vocabulary
      // doesn't know: it groups the rows below provisionally and is flagged (see
      // `currentRoleIsProvisional`), and — since it might still be a person with a blank week —
      // it is listed as an unread row too, never dropped.
      const unlikeBanners = unlikeSheetBanners(employeeName);
      const personLike = looksLikePersonName(employeeName) && !GROUP_WORDS.test(employeeName) && (unlikeBanners || !(mixedCaseVenue && isAllCapsLabel(employeeName)));
      const insideRealSection = !currentRoleIsProvisional || (currentRole === '' && peopleBefore > 0);
      if (personLike && (insideRealSection || unlikeBanners || combined)) {
        const key = addPerson(r, employeeName, roleOfRow);
        if (processStaffRow(r, row, employeeName, roleOfRow, new Set([0]), sourceRowCounter++, key)) staffRowsWithRealDataProcessed++;
        continue;
      }
      if (currentRoleIsProvisional) {
        setSection(employeeName, true);
        unrecognizedHeaderTexts.add(employeeName);
        if (personLike) addUnread(r, employeeName, HEADING_NOTE);
      }
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
      if (CAPTION_WORDS.test(col0Val || col1Val) || isFooterOrNote(col0Val || col1Val)) continue;

      if (!col0Val || !col1Val) {
        const label = col0Val || col1Val;
        if (/^\d+(\.\d+)?$/.test(label)) continue; // headcount/totals row
        if (SUMMARY_ROW_LABELS.has(label.toLowerCase())) continue; // footer/summary caption
        // Same structural override as the single-label-column shape above:
        // real shift-shaped data on this row rules out a header match.
        if (!hasData(row) && isRoleHeaderLabel(label, hasSeenAnyStaffRow)) {
          setSection(label, false);
          continue;
        }
      }

      const rawText = `"${col0Val || '(blank)'}" | "${col1Val || '(blank)'}"`;
      anomalies.push({
        employeeName: null,
        date: null,
        rawText,
        reason:
          'Could not confidently tell which of the first two columns is the staff name and which is the role (neither matches known role vocabulary clearly enough to disambiguate). Flagged for manual entry instead of guessing.',
        confidence: 0.3,
        rowNumber: null,
      });
      addUnread(r, rawText, "Couldn't tell which column is the name and which is the title.");
      continue;
    }

    // Two-leading-column shape: column 0 is a per-row title, column
    // nameColIndex is the actual staff name — no content-based ambiguity,
    // an empty name column always means "not a real staff row."
    const nameCell = withoutLeadingIndex(normalizeCell(row[nameColIndex]));
    const titleCell = normalizeCell(row[titleColIndex!]);
    const lead = nameCell || titleCell;
    if (lead && (CAPTION_WORDS.test(lead) || isFooterOrNote(lead)) && !hasData(row)) continue; // caption / note line

    // A banner merged across the row (the same text in every filled cell), or a role or department
    // word alone in the name column with no title and no days ("BAR", "HOSTS"), heads a section;
    // it is nobody's name.
    if (nameCell && (isMergedBanner(row) || (daysBlank(row) && (nameCell === titleCell || (!titleCell && (canonicalRoleName(nameCell) !== nameCell || isSectionLabel(nameCell))))))) {
      setSection(nameCell, canonicalRoleName(nameCell) === nameCell && !isSectionLabel(nameCell));
      continue;
    }
    // A label alone in the name column — no title, no days — in capitals on a sheet whose names
    // are not and whose people carry their own titles: a banner the vocabulary doesn't know
    // ("TERRACE"). It groups the rows below provisionally, and is listed to check in case it is
    // a person with a blank week.
    if (nameCell && !titleCell && daysBlank(row) && peopleCarryTitles && mixedCaseVenue && isAllCapsLabel(nameCell)) {
      setSection(nameCell, true);
      unrecognizedHeaderTexts.add(nameCell);
      addUnread(r, nameCell, HEADING_NOTE);
      continue;
    }

    if (!nameCell) {
      const rowHasData = hasData(row);
      const headerCandidates: string[] = [];
      if (titleCell) headerCandidates.push(titleCell);
      for (const col of columns) {
        const v = dayCellText(row, col);
        if (v) headerCandidates.push(v);
      }
      const roleMatch = rowHasData ? undefined : headerCandidates.find((v) => isRoleHeaderLabel(v, hasSeenAnyStaffRow));
      if (roleMatch) {
        const provisional = isPatternOnlyHeaderInCapsVenue(roleMatch);
        setSection(roleMatch, provisional);
        if (provisional) unrecognizedHeaderTexts.add(roleMatch);
        continue;
      }
      if (rowHasData) {
        // A title and shifts but no name: never attributed to anyone, never dropped.
        const summary = [titleCell, ...columns.map((col) => dayCellText(row, col)).filter(Boolean)].filter(Boolean).join(' | ');
        addUnread(r, summary, 'This row has shifts but no name.');
        continue;
      }
      // One unrecognised label on an otherwise blank row (no staff name, no day data): a novel
      // section header — possibly the very first one, with no staff above it, which neither
      // the vocabulary nor the caps signal can catch. Group the untitled rows below under it
      // provisionally and flag it, exactly like the single-label shape does; per-row titles
      // still take precedence. Never replaces a real (recognised) header.
      const label = headerCandidates.length === 1 ? headerCandidates[0]! : null;
      if (
        label &&
        currentRoleIsProvisional &&
        !/^\d+(\.\d+)?$/.test(label) &&
        !SUMMARY_ROW_LABELS.has(label.toLowerCase()) &&
        !isSentence(label) &&
        daysBlank(row)
      ) {
        setSection(label, true);
        unrecognizedHeaderTexts.add(label);
      }
      continue;
    }

    if (/^\d+(\.\d+)?$/.test(nameCell)) continue; // headcount/totals row

    // A title or heading where the name should be is never a person. When the title cell holds
    // a person's name instead, this row has the two the other way round; otherwise its shifts
    // are shown as an unread row.
    const combinedName = splitLead(nameCell);
    let employeeName = combinedName?.name ?? nameCell;
    let rowTitle = titleCell || combinedName?.title || '';
    const notPerson = nonPersonReason(employeeName);
    if (notPerson) {
      if (looksLikePersonName(titleCell) && !nonPersonReason(titleCell)) {
        employeeName = titleCell;
        rowTitle = nameCell;
      } else {
        if (notPerson === UNREADABLE_NAME) {
          addUnread(r, [titleCell, nameCell, ...columns.map((col) => dayCellText(row, col))].filter(Boolean).join(' | '), UNREADABLE_ROW);
          if (hasData(row)) staffRowsWithRealDataProcessed++;
        } else if (hasData(row)) {
          addUnread(r, [titleCell, nameCell, ...columns.map((col) => dayCellText(row, col))].filter(Boolean).join(' | '), `"${nameCell}" reads as ${notPerson}; its shifts were not imported. Add them by hand if they belong to someone.`);
          staffRowsWithRealDataProcessed++;
        }
        continue;
      }
    }
    hasSeenAnyStaffRow = true;
    // A per-row title is more specific than whatever section header
    // preceded it and always takes precedence; falls back to the
    // section-derived role when this row's own title cell is blank (or
    // only a number, such as an employee ID, which is no title).
    const roleName = (/^\d+$/.test(rowTitle) ? '' : rowTitle) || currentRole;
    const key = addPerson(r, employeeName, roleName);
    if (processStaffRow(r, row, employeeName, roleName, new Set([nameColIndex, titleColIndex!]), sourceRowCounter++, key)) staffRowsWithRealDataProcessed++;
  }

  // One blocking anomaly per unique unrecognized section header, listing
  // every row it ended up grouping — surfaced to the manager exactly like
  // a vision-fallback anomaly (same `anomalies` array, same review-gate),
  // requiring an explicit acknowledge/dismiss before Confirm rather than a
  // warning buried in `issues`. Skipped entirely if the header ended up
  // with zero affected rows (nothing after it before the next real header
  // or end of sheet — nothing for a manager to act on).
  for (const headerText of unrecognizedHeaderTexts) {
    const affectedRowNumbers = rows.filter((r) => r.roleName === headerText).map((r) => r.rowNumber);
    if (affectedRowNumbers.length === 0) continue;
    const affectedEmployees = [...new Set(rows.filter((r) => r.roleName === headerText).map((r) => r.employeeName))];
    anomalies.push({
      employeeName: null,
      date: null,
      rawText: headerText,
      reason:
        `Section header "${headerText}" is not a known role — ${affectedRowNumbers.length} shift(s) across ` +
        `${affectedEmployees.length} employee(s) (${affectedEmployees.join(', ')}) are grouped under it and ` +
        `need a role confirmed before this roster is complete.`,
      confidence: 0,
      rowNumber: affectedRowNumbers[0],
      kind: 'unrecognized_section_header',
      affectedRowNumbers,
    });
  }

  // Hard sanity gate (independent of the structural heuristic fix above):
  // re-derive "how many rows plainly carry real shift data" from scratch
  // and compare against how many the loop actually processed. A shortfall
  // means real data was dropped somewhere — silently returning a
  // 200-shaped partial/empty result would hide that from the manager
  // uploading the file, so this throws instead of returning.
  //
  // Skipped when columnOrderAmbiguous: that shape never routes a row into
  // processStaffRow at all — by design, every row it can't confidently
  // classify becomes an explicit anomaly instead of a guess (see above) —
  // so it already surfaces its own "needs manual review" signal and this
  // gate would trip on every such file for no new information.
  if (!columnOrderAmbiguous) {
    const labelColIndex = hasTitleColumn ? nameColIndex : 0;
    const excludedNoteCols = new Set([...(hasTitleColumn ? [nameColIndex, titleColIndex!] : [0]), ...sideLegendCols]);
    const minExpectedStaffRows = countRowsWithRealShiftData(grid, header.dataStartIdx, dataEndIdx, columns, fileLegend, labelColIndex, excludedNoteCols, timeOptions);
    if (staffRowsWithRealDataProcessed < minExpectedStaffRows) {
      throw new RosterExtractionAnomalyError(
        `Found real shift data on ${minExpectedStaffRows} row(s) of the uploaded file, but only ${staffRowsWithRealDataProcessed} could be matched to an employee. This usually means a staff name or section header was misread — please check the file and try again, or contact support.`,
      );
    }
  }

  return {
    templateLabel: 'Deterministic Grid Parser',
    rows,
    issues,
    anomalies,
    leaveRecords,
    legend,
    people,
    unreadRows,
    week,
  };
}
