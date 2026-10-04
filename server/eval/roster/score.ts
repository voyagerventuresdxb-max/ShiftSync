import type { ParsedVisionResult } from '../../src/parsing/types.js';
import type { Truth } from './spec.js';

/** One field's tally: `ok` out of `of`. */
export interface Tally {
  ok: number;
  of: number;
}
export interface Score {
  /** Staff present in the truth that the parse found at all. */
  name: Tally;
  /** Truth shifts with a predicted shift for the same person and day. */
  day: Tally;
  start: Tally;
  end: Tally;
  /** Role of shifts found for the right person and day. */
  role: Tally;
  leave: Tally;
  /** Open-ended cells (CL/IN) surfaced for review on the right person and day. */
  flagged: Tally;
  /** Predicted shifts that match no truth shift (person + day + start). */
  extraShifts: number;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
/** "SUPERVISORS", "Supervisor" and "supervisors" are the same role for scoring. */
const normRole = (s: string) => norm(s).replace(/s$/, '');

export const pct = (t: Tally) => (t.of === 0 ? '—' : `${Math.round((100 * t.ok) / t.of)}%`);
export const add = (a: Tally, b: Tally): Tally => ({ ok: a.ok + b.ok, of: a.of + b.of });

/** Scores a parse (null = nothing usable) against the truth. Never logs anything. */
export function score(result: Pick<ParsedVisionResult, 'rows' | 'leaveRecords' | 'anomalies'> | null, truth: Truth): Score {
  const rows = result?.rows ?? [];
  const leave = result?.leaveRecords ?? [];
  const anomalies = result?.anomalies ?? [];
  const predictedNames = new Set([...rows.map((r) => norm(r.employeeName)), ...leave.map((l) => norm(l.employeeName))]);
  const truthNames = new Set([...truth.shifts, ...truth.leave, ...truth.flagged].map((x) => norm(x.name)));

  const s: Score = {
    name: { ok: [...truthNames].filter((n) => predictedNames.has(n)).length, of: truthNames.size },
    day: { ok: 0, of: truth.shifts.length },
    start: { ok: 0, of: truth.shifts.length },
    end: { ok: 0, of: truth.shifts.length },
    role: { ok: 0, of: 0 },
    leave: { ok: 0, of: truth.leave.length },
    flagged: { ok: 0, of: truth.flagged.length },
    extraShifts: 0,
  };

  const used = new Set<number>();
  for (const t of truth.shifts) {
    const sameDay = rows.map((r, i) => ({ r, i })).filter(({ r }) => norm(r.employeeName) === norm(t.name) && r.date === t.date);
    if (sameDay.length === 0) continue;
    s.day.ok++;
    const hit = sameDay.find(({ r, i }) => !used.has(i) && r.startTime === t.start) ?? sameDay.find(({ i }) => !used.has(i));
    if (!hit) continue;
    used.add(hit.i);
    if (hit.r.startTime === t.start) s.start.ok++;
    if (hit.r.endTime === t.end) s.end.ok++;
    s.role.of++;
    if (normRole(hit.r.roleName ?? '') === normRole(t.role)) s.role.ok++;
  }
  s.extraShifts = rows.length - used.size;

  const leaveKeys = new Set(leave.map((l) => `${norm(l.employeeName)}|${l.date}|${norm(l.leaveCode)}`));
  s.leave.ok = truth.leave.filter((l) => leaveKeys.has(`${norm(l.name)}|${l.date}|${norm(l.code)}`)).length;
  const flagKeys = new Set(anomalies.filter((a) => a.employeeName && a.date).map((a) => `${norm(a.employeeName!)}|${a.date}`));
  s.flagged.ok = truth.flagged.filter((f) => flagKeys.has(`${norm(f.name)}|${f.date}`)).length;
  return s;
}

export function totals(scores: Score[]): Score {
  const zero = (): Tally => ({ ok: 0, of: 0 });
  return scores.reduce<Score>(
    (acc, s) => ({
      name: add(acc.name, s.name),
      day: add(acc.day, s.day),
      start: add(acc.start, s.start),
      end: add(acc.end, s.end),
      role: add(acc.role, s.role),
      leave: add(acc.leave, s.leave),
      flagged: add(acc.flagged, s.flagged),
      extraShifts: acc.extraShifts + s.extraShifts,
    }),
    { name: zero(), day: zero(), start: zero(), end: zero(), role: zero(), leave: zero(), flagged: zero(), extraShifts: 0 },
  );
}

/** The truth as the vision model's JSON answer would be if it were perfect (for --vision=mock pipeline checks). */
export function truthAsVlmJson(truth: Truth): string {
  const byName = new Map<string, { role: string | null; cells: unknown[] }>();
  const emp = (name: string, role: string | null) => byName.get(name) ?? byName.set(name, { role, cells: [] }).get(name)!;
  for (const t of truth.shifts) {
    emp(t.name, t.role || null).cells.push({ date: t.date, rawText: `${t.start}-${t.end}`, period: null, interpretation: 'worked_shift', startTime: t.start, endTime: t.end, leaveCode: null, confidence: 0.95, needsReview: false, reviewReason: null });
  }
  for (const l of truth.leave) {
    emp(l.name, null).cells.push({ date: l.date, rawText: l.code, period: null, interpretation: l.code === 'OFF' ? 'day_off' : l.code === 'PH' ? 'public_holiday' : 'leave', startTime: null, endTime: null, leaveCode: l.code, confidence: 0.95, needsReview: false, reviewReason: null });
  }
  return JSON.stringify({
    venueTemplateNotes: '',
    legend: [],
    documentAnomalies: [],
    employees: [...byName].map(([rawName, e]) => ({ rawName, role: e.role, cells: e.cells })),
  });
}
