/**
 * Uncovered shifts: shifts in the week with nobody assigned. The client marks
 * them with an `open-<id>` employee id (AppStateContext maps a null user that
 * way), which is also how RotaBuilder's "Open shifts" row finds them.
 */
export interface OpenShiftCounts {
  total: number;
  byDay: Record<string, number>;
}

export function openShiftCounts(shifts: { date: string; employeeId: string }[], days: string[]): OpenShiftCounts {
  const byDay: Record<string, number> = Object.fromEntries(days.map((d) => [d, 0]));
  let total = 0;
  for (const s of shifts) {
    if (!s.employeeId.startsWith('open-') || !(s.date in byDay)) continue;
    byDay[s.date] = (byDay[s.date] ?? 0) + 1;
    total += 1;
  }
  return { total, byDay };
}

/** "1 uncovered shift" / "3 uncovered shifts". */
export function uncoveredLabel(n: number): string {
  return `${n} uncovered shift${n === 1 ? '' : 's'}`;
}
