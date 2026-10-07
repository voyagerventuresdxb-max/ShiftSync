import type { FamilyTruth } from './families.js';
import { add, type Tally } from './score.js';

/**
 * Scores one reading of a layout-family roster against its truth. Counts only — never logs.
 *
 *  - staff recall     truth people the reading lists (exact name, or a near-miss spelling the
 *                     review screen can fix) — including people with no shifts that week
 *  - staff exact      … with the exact printed name
 *  - staff precision  people the reading lists that exist on the roster (headcount rows,
 *                     banners, legend entries and captions must never become people)
 *  - shift recall     truth shifts with a shift for the same person on the same date
 *  - exact time       … with start and end both exact (overnight implied by the end)
 *  - role             found shifts whose role is the printed title / section
 *  - week             the reading's week is the printed week
 *  - silent drops     a truth person / shift that is neither in the output nor in unread rows,
 *                     anomalies or flags; and found shifts whose times are wrong with no flag
 *  - wrong day        saved shifts whose times the person works on another day of the week but
 *                     not on the day they were saved on (flagged or not)
 *  - flagged rows     saved shifts the review screen asks about: a row flag, or a note on that
 *                     person for that day (or for the whole person)
 */
export interface ReadingUnderTest {
  rows: { employeeName: string; roleName: string; date: string; startTime: string; endTime: string; flags?: string[] }[];
  leaveRecords: { employeeName: string; date: string; leaveCode: string }[];
  anomalies: { employeeName: string | null; date: string | null; rawText: string }[];
  /** People the reader reports, or null when it has no people list (derived from rows + leave). */
  people: { name: string; nameAlternatives?: { name: string }[] }[] | null;
  unreadRows: { text: string }[];
  /** The week the reader dated the roster in (Monday), or null to derive it from the rows. */
  weekStart: string | null;
}

export interface FamilyScore {
  staffRecall: Tally;
  staffExact: Tally;
  staffPrecision: Tally;
  shiftRecall: Tally;
  exactTime: Tally;
  role: Tally;
  week: Tally;
  flagged: Tally;
  silentPeople: number;
  silentShifts: number;
  /** Shifts not imported but shown to the manager as a cell to look at on that day (not silent). */
  surfacedShifts: number;
  silentTimeErrors: number;
  /** People kept under a misspelt name with no other spelling offered for the manager to check. */
  silentNameErrors: number;
  /** Shifts saved with a wrong start or end (flagged or not). */
  wrongSaved: number;
  extraShifts: number;
  /** Saved shifts on a day the person doesn't work those times, who does on another day (flagged or not). */
  wrongDay: number;
  /** Saved shifts the review screen asks about (a row flag, or a note on that person and day, or on the whole person). */
  flaggedRows: Tally;
}

export const normName = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const normRole = (s: string) => normName(s).replace(/s$/, '');

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Monday (UTC calendar) of an ISO date. */
export function mondayOf(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

export function scoreFamily(reading: ReadingUnderTest | null, truth: FamilyTruth): FamilyScore {
  const rows = reading?.rows ?? [];
  const leave = reading?.leaveRecords ?? [];
  const anomalies = reading?.anomalies ?? [];
  const unread = (reading?.unreadRows ?? []).map((u) => normName(u.text));
  const predicted = [...new Set((reading?.people?.map((p) => p.name) ?? [...rows.map((r) => r.employeeName), ...leave.map((l) => l.employeeName)]).map(normName))].filter(Boolean);

  // truth person → predicted person (exact first, then a near-miss spelling).
  const match = new Map<string, { pred: string; exact: boolean }>();
  const used = new Set<string>();
  for (const p of truth.people) {
    const n = normName(p.name);
    if (predicted.includes(n) && !used.has(n)) {
      match.set(p.name, { pred: n, exact: true });
      used.add(n);
    }
  }
  for (const p of truth.people) {
    if (match.has(p.name)) continue;
    const n = normName(p.name);
    const near = predicted.find((q) => !used.has(q) && levenshtein(q, n) <= Math.max(1, Math.floor(n.length * 0.15)));
    if (near) {
      match.set(p.name, { pred: near, exact: false });
      used.add(near);
    }
  }
  const truthOfPred = new Map([...match].map(([t, m]) => [m.pred, t]));
  const mentioned = (name: string) => {
    const n = normName(name);
    return unread.some((u) => u.includes(n)) || anomalies.some((a) => (a.employeeName && normName(a.employeeName) === n) || normName(a.rawText).includes(n));
  };

  const s: FamilyScore = {
    staffRecall: { ok: match.size, of: truth.people.length },
    staffExact: { ok: [...match.values()].filter((m) => m.exact).length, of: truth.people.length },
    staffPrecision: { ok: predicted.filter((q) => truthOfPred.has(q)).length, of: predicted.length },
    shiftRecall: { ok: 0, of: truth.shifts.length },
    exactTime: { ok: 0, of: truth.shifts.length },
    role: { ok: 0, of: 0 },
    week: { ok: 0, of: 1 },
    flagged: { ok: 0, of: truth.flagged.length },
    silentPeople: truth.people.filter((p) => !match.has(p.name) && !mentioned(p.name)).length,
    silentShifts: 0,
    surfacedShifts: 0,
    silentTimeErrors: 0,
    wrongSaved: 0,
    silentNameErrors: [...match.values()].filter((m) => !m.exact && !(reading?.people?.find((p) => normName(p.name) === m.pred)?.nameAlternatives?.length)).length,
    extraShifts: 0,
    wrongDay: 0,
    flaggedRows: { ok: 0, of: rows.length },
  };

  const rowTruthName = rows.map((r) => truthOfPred.get(normName(r.employeeName)) ?? null);
  const taken = new Set<number>();
  // Assign predicted rows to truth shifts best match first (exact, then same start, then any
  // left that day), so one inexact row can't take the place of an exact one.
  const assigned = new Map<number, { r: ReadingUnderTest['rows'][number]; i: number }>();
  const passes: ((r: ReadingUnderTest['rows'][number], t: (typeof truth.shifts)[number]) => boolean)[] = [
    (r, t) => r.startTime === t.start && r.endTime === t.end,
    (r, t) => r.startTime === t.start,
    () => true,
  ];
  for (const pass of passes) {
    truth.shifts.forEach((t, k) => {
      if (assigned.has(k)) return;
      const i = rows.findIndex((r, j) => !taken.has(j) && rowTruthName[j] === t.name && r.date === t.date && pass(r, t));
      if (i >= 0) {
        taken.add(i);
        assigned.set(k, { r: rows[i]!, i });
      }
    });
  }
  for (const [k, t] of truth.shifts.entries()) {
    const hit = assigned.get(k);
    if (!hit) {
      const covered =
        anomalies.some((a) => a.employeeName && truthOfPred.get(normName(a.employeeName)) === t.name && (a.date === t.date || a.date === null)) ||
        (!match.has(t.name) && mentioned(t.name)) ||
        unread.some((u) => u.includes(normName(t.name)));
      if (!covered) s.silentShifts++;
      else if (anomalies.some((a) => a.employeeName && truthOfPred.get(normName(a.employeeName)) === t.name && (a.date === t.date || a.date === null))) s.surfacedShifts++;
      continue;
    }
    s.shiftRecall.ok++;
    if (hit.r.startTime === t.start && hit.r.endTime === t.end) s.exactTime.ok++;
    else {
      s.wrongSaved++;
      if (!(hit.r.flags ?? []).length) s.silentTimeErrors++;
    }
    s.role.of++;
    if (normRole(hit.r.roleName ?? '') === normRole(t.role)) s.role.ok++;
  }
  s.extraShifts = rows.length - taken.size;
  rows.forEach((r, j) => {
    const who = rowTruthName[j];
    const mine = truth.shifts.filter((t) => t.name === who);
    const same = (t: (typeof mine)[number]) => t.start === r.startTime && t.end === r.endTime;
    if (who && !mine.some((t) => t.date === r.date && same(t)) && mine.some((t) => t.date !== r.date && same(t))) s.wrongDay++;
    const noted = anomalies.some((a) => a.employeeName && normName(a.employeeName) === normName(r.employeeName) && (a.date === r.date || a.date === null));
    if ((r.flags ?? []).length || noted) s.flaggedRows.ok++;
  });

  let weekStart = reading?.weekStart ?? null;
  if (!weekStart && rows.length) {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(mondayOf(r.date), (counts.get(mondayOf(r.date)) ?? 0) + 1);
    weekStart = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  }
  s.week.ok = weekStart === truth.week.weekStart ? 1 : 0;

  const flagKeys = new Set(anomalies.filter((a) => a.employeeName && a.date).map((a) => `${truthOfPred.get(normName(a.employeeName!)) ?? ''}|${a.date}`));
  s.flagged.ok = truth.flagged.filter((f) => flagKeys.has(`${f.name}|${f.date}`)).length;
  return s;
}

export function familyTotals(scores: FamilyScore[]): FamilyScore {
  const zero = (): Tally => ({ ok: 0, of: 0 });
  return scores.reduce<FamilyScore>(
    (a, s) => ({
      staffRecall: add(a.staffRecall, s.staffRecall),
      staffExact: add(a.staffExact, s.staffExact),
      staffPrecision: add(a.staffPrecision, s.staffPrecision),
      shiftRecall: add(a.shiftRecall, s.shiftRecall),
      exactTime: add(a.exactTime, s.exactTime),
      role: add(a.role, s.role),
      week: add(a.week, s.week),
      flagged: add(a.flagged, s.flagged),
      silentPeople: a.silentPeople + s.silentPeople,
      silentShifts: a.silentShifts + s.silentShifts,
      surfacedShifts: a.surfacedShifts + s.surfacedShifts,
      silentTimeErrors: a.silentTimeErrors + s.silentTimeErrors,
      silentNameErrors: a.silentNameErrors + s.silentNameErrors,
      wrongSaved: a.wrongSaved + s.wrongSaved,
      extraShifts: a.extraShifts + s.extraShifts,
      wrongDay: a.wrongDay + s.wrongDay,
      flaggedRows: add(a.flaggedRows, s.flaggedRows),
    }),
    { staffRecall: zero(), staffExact: zero(), staffPrecision: zero(), shiftRecall: zero(), exactTime: zero(), role: zero(), week: zero(), flagged: zero(), silentPeople: 0, silentShifts: 0, surfacedShifts: 0, silentTimeErrors: 0, silentNameErrors: 0, wrongSaved: 0, extraShifts: 0, wrongDay: 0, flaggedRows: zero() },
  );
}

/** Percent with one decimal ("99.5%"), or "—" for nothing to count. */
export const pct1 = (t: Tally) => (t.of === 0 ? '—' : `${(Math.floor((1000 * t.ok) / t.of) / 10).toFixed(1)}%`);

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
