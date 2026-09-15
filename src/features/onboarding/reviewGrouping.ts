import dayjs from 'dayjs';
import type { PreviewRow } from '../../api/schedules';

/**
 * Pure Review-screen logic, kept in its own CSS-free module (separate from
 * ReviewScreen.tsx, which imports OnboardingScreenShell.tsx, which imports
 * a real .css file — that import breaks under `node --test`/tsx's Node-ESM
 * loader, which has no CSS handling the way Vite's bundler does) so this
 * logic stays independently unit-testable. See ReviewScreen.test.ts.
 */

export interface PersonRow {
  id: string;
  rowNumbers: number[];
  originalName: string;
  originalRole: string;
  shiftSummary: string;
  /** true when any underlying row didn't cleanly match (status !== 'matched'). */
  parserFlagged: boolean;
  note: string | null;
}

/**
 * Whether it's safe to silently advance to Invite right after a confirm
 * response, or whether the manager needs to actually see the outcome first.
 * Exported as a pure function so the "skippedCount must be checked, not
 * just assumed to be zero" rule is independently testable — the prior bug
 * called onContinue() unconditionally right after confirmRoster resolved,
 * so a row whose role silently failed to resolve server-side (e.g. an
 * edited role that trims to empty) was never surfaced to the manager, who
 * landed on Invite believing every row imported.
 */
export function shouldAdvanceAfterConfirm(result: { skippedCount: number }): boolean {
  return result.skippedCount === 0;
}

function summarizeShifts(rows: PreviewRow[]): string {
  if (rows.length === 1) {
    const r = rows[0]!;
    return `${dayjs(r.date).format('ddd')} · ${r.startTime}${r.overnight ? ' (+1)' : ''}`;
  }
  const days = [...new Set(rows.map((r) => dayjs(r.date).format('ddd')))];
  const daysLabel = days.length <= 2 ? days.join('–') : `${days[0]}–${days[days.length - 1]}`;
  const hours = rows.map((r) => Number(r.startTime.split(':')[0] ?? 0));
  const avgHour = hours.reduce((a, b) => a + b, 0) / hours.length;
  const period = avgHour < 15 ? 'AM' : 'PM';
  return `${daysLabel} · ${period}`;
}

export function groupByPerson(preview: PreviewRow[]): PersonRow[] {
  const map = new Map<string, PreviewRow[]>();
  for (const row of preview) {
    // Group by the parser's own per-employee source-row identity when the
    // upload path provides one (grid/vision uploads — see
    // ParsedShiftRow.sourceRowIndex) rather than by name alone: two
    // different real staff who happen to share a name live on different
    // physical source rows, so this keeps them as separate PersonRows
    // instead of silently merging their shifts (and any edit/removal) into
    // one. Falls back to name-only grouping only for free-text uploads,
    // which have no such per-employee structure to begin with (each line is
    // independently one shift, not a block belonging to one employee).
    const key = row.sourceRowIndex !== undefined ? `row:${row.sourceRowIndex}` : `name:${row.employeeName.trim() || `(unnamed row ${row.rowNumber})`}`;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return [...map.entries()].map(([key, rows]) => {
    const parserFlagged = rows.some((r) => r.status !== 'matched');
    const notes = [...new Set(rows.flatMap((r) => r.issues.filter((i) => i.severity !== 'info').map((i) => i.message)))];
    const name = rows[0]!.employeeName.trim() || `(unnamed row ${rows[0]!.rowNumber})`;
    return {
      id: key,
      rowNumbers: rows.map((r) => r.rowNumber),
      originalName: name,
      originalRole: rows[0]!.role || '',
      shiftSummary: summarizeShifts(rows),
      parserFlagged,
      note: notes[0] ?? null,
    };
  });
}
