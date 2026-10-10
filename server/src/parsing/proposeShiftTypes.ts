import { SHIFT_TINTS, validateRanges, type ProposedShiftType, type TimeRange } from '../../../shared/rotaWeek.js';
import { parseSingleTime } from './shiftText.js';

/**
 * Rota builder v2 — the shift types a roster import suggests (shared/
 * rotaWeek.ts: ProposedShiftType), returned with the upload preview so the
 * manager can accept them in one go (POST /api/shift-types/:locationId/bulk).
 *
 * Pure: the parsed rows (and the in-file legend, and the venue's existing
 * types) in, at most eight proposals out. Two rows of one person on one day
 * are one split shift, as the import will store them; any other row is its
 * own timing. Identical timings are counted; the most used come first.
 */

/** What a proposal needs from a parsed row. */
export interface ProposalRow {
  employeeName: string;
  /** The source row a person's shifts share (grid and vision readers); falls back to the name. */
  sourceRowIndex?: number;
  date: string;
  startTime: string;
  endTime: string;
}

export const MAX_PROPOSALS = 8;
const NAME_MAX = 40;

/** A time range written inside a legend meaning: "07:00-15:00", "7am – 3pm", "16.00 to 01.00". */
const RANGE_IN_TEXT = /(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/i;

/** The legend's own name for a single timing ("Morning" from "Morning (07:00-15:00)"), when its times match. */
function legendNameFor(range: TimeRange, legend: { code: string; meaning: string }[]): string | null {
  for (const entry of legend) {
    const m = entry.meaning.match(RANGE_IN_TEXT);
    if (!m) continue;
    const start = parseSingleTime(m[1]!.replace('.', ':'));
    const end = parseSingleTime(m[2]!.replace('.', ':'));
    if (start !== range.start || end !== range.end) continue;
    const label = entry.meaning
      .replace(m[0], ' ')
      .replace(/[()[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s=:–—-]+|[\s=:–—-]+$/g, '')
      .trim();
    if (label) return label.slice(0, NAME_MAX).trim();
  }
  return null;
}

/** "Morning" (starts before 11:00), "Mid" (11:00–14:59), "Evening" (15:00 on); "Split" for two ranges. */
function timeOfDayName(ranges: TimeRange[]): string {
  if (ranges.length === 2) return 'Split';
  const start = ranges[0]!.start;
  if (start < '11:00') return 'Morning';
  if (start < '15:00') return 'Mid';
  return 'Evening';
}

const rangesKey = (ranges: TimeRange[]) => ranges.map((r) => `${r.start}|${r.end}`).join('|');

export function proposeShiftTypes(
  rows: ProposalRow[],
  legend: { code: string; meaning: string }[] = [],
  existing: { name: string; ranges: unknown; archived?: boolean }[] = [],
): ProposedShiftType[] {
  // One person-day → one shift: a second row that day is the second range of a split.
  const byPersonDay = new Map<string, TimeRange[]>();
  for (const r of rows) {
    if (!r.startTime || !r.endTime) continue;
    const who = r.sourceRowIndex !== undefined ? `#${r.sourceRowIndex}` : r.employeeName.trim().toLowerCase();
    const key = `${who}|${r.date}`;
    byPersonDay.set(key, [...(byPersonDay.get(key) ?? []), { start: r.startTime, end: r.endTime }]);
  }

  const groups = new Map<string, { ranges: TimeRange[]; count: number; order: number }>();
  const count = (ranges: TimeRange[]) => {
    const key = rangesKey(ranges);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { ranges, count: 1, order: groups.size });
  };
  for (const parts of byPersonDay.values()) {
    const sorted = parts.slice().sort((a, b) => a.start.localeCompare(b.start));
    if (sorted.length === 2 && validateRanges(sorted)) {
      count(sorted);
      continue;
    }
    for (const part of sorted) if (validateRanges([part])) count([part]);
  }

  // A timing the venue already has (a live type) is not proposed again; names already used are not reused.
  const liveTimings = new Set(existing.filter((t) => !t.archived && validateRanges(t.ranges)).map((t) => rangesKey(t.ranges as TimeRange[])));
  const taken = new Set(existing.map((t) => t.name.trim().toLowerCase()));
  const ranked = [...groups.values()]
    .filter((g) => !liveTimings.has(rangesKey(g.ranges)))
    .sort((a, b) => b.count - a.count || a.ranges[0]!.start.localeCompare(b.ranges[0]!.start) || a.order - b.order)
    .slice(0, MAX_PROPOSALS);

  return ranked.map((g, i): ProposedShiftType => {
    const base = (g.ranges.length === 1 ? legendNameFor(g.ranges[0]!, legend) : null) ?? timeOfDayName(g.ranges);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, NAME_MAX - 3)} ${n}`;
    taken.add(name.toLowerCase());
    return { name, ranges: g.ranges, tint: SHIFT_TINTS[i % SHIFT_TINTS.length]!, sortOrder: i, count: g.count };
  });
}
