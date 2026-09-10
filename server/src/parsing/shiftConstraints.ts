/**
 * Shared hallucination guard-rails applied to any shift-extraction path
 * (vision-model, OCR/grid, text). Enforces the hard constraint: max 1 shift
 * per (staff, date), or 2 non-overlapping shifts with a real break between
 * them (AM+PM split shift) — never a cell-splitting artifact that inflates
 * one printed cell into many rows.
 */

import type { AnomalyRecord, ParsedShiftRow } from './types.js';

const MIN_BREAK_MINUTES = 30;

/**
 * Enforces the constraint: max 1 shift per day per staff (or 2 if AM+PM
 * non-overlapping with a real break). Flags duplicates, overlaps, and
 * over-counted days as anomalies instead of silently accepting them.
 */
export function enforceNoDoubleShifts(
  shifts: ParsedShiftRow[]
): {
  accepted: ParsedShiftRow[];
  anomalies: AnomalyRecord[];
} {
  const accepted: ParsedShiftRow[] = [];
  const anomalies: AnomalyRecord[] = [];

  const byStaffDate = new Map<string, ParsedShiftRow[]>();
  for (const shift of shifts) {
    const key = `${shift.employeeName}|${shift.date}`;
    if (!byStaffDate.has(key)) byStaffDate.set(key, []);
    byStaffDate.get(key)!.push(shift);
  }

  for (const [, shiftGroup] of byStaffDate.entries()) {
    if (shiftGroup.length === 1) {
      accepted.push(shiftGroup[0]);
    } else if (shiftGroup.length === 2) {
      const [s1, s2] = shiftGroup.sort((a, b) =>
        (a.startTime || '').localeCompare(b.startTime || '')
      );

      // Convert "HH:mm" to minutes-since-midnight. An overnight shift
      // (end <= start, e.g. "18:00-01:00") rolls its end forward by 24h so
      // the overlap/gap math is correct across midnight.
      const toMin = (t: string | undefined, rollNextDay: boolean): number => {
        if (!t) return rollNextDay ? 24 * 60 : 0;
        const [h, m] = t.split(':').map(Number);
        const base = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
        return rollNextDay ? base + 24 * 60 : base;
      };
      const s1End = toMin(s1.endTime, s1.overnight);
      const s2Start = toMin(s2.startTime, false);

      const isOverlapping = s1End > s2Start;
      const gapMinutes = Math.max(0, s2Start - s1End);

      if (!isOverlapping && gapMinutes >= MIN_BREAK_MINUTES) {
        accepted.push(...shiftGroup);
      } else {
        anomalies.push({
          employeeName: shiftGroup[0].employeeName,
          date: shiftGroup[0].date,
          rawText: shiftGroup.map((s) => `${s.startTime}-${s.endTime}`).join(' & '),
          reason: isOverlapping
            ? `Two overlapping shifts on ${shiftGroup[0].date}`
            : `Shifts too close together (${Math.floor(gapMinutes)}min, need ${MIN_BREAK_MINUTES}min)`,
          confidence: 0.2,
          // Both shifts were stripped from `accepted` — neither survives as
          // a PreviewRow, so there's no rowNumber to join against.
          rowNumber: null,
        });
      }
    } else {
      anomalies.push({
        employeeName: shiftGroup[0].employeeName,
        date: shiftGroup[0].date,
        rawText: shiftGroup.map((s) => `${s.startTime}-${s.endTime}`).join(', '),
        reason: `${shiftGroup.length} shifts detected on the same day (max 2 allowed) — likely cell-splitting/hallucination, all flagged for manual review`,
        confidence: 0,
        rowNumber: null,
      });
    }
  }

  return { accepted, anomalies };
}
