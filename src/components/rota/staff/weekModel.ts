import {
  leaveBlocksShifts,
  type DepartmentDto,
  type IsoDate,
  type ShiftTint,
  type ShiftTypeDto,
  type TimeRange,
  type WeekDocDto,
  type WeekLeaveDto,
  type WeekPersonDto,
  type WeekRequestDto,
  type WeekShiftDto,
} from '../../../../shared/rotaWeek';

/**
 * Small, dependency-free derivations from the week document shared by the
 * staff week, the Team Matrix and the manager phone views. Kept apart from
 * the components so they stay in the light staff bundle and are unit-tested
 * under node:test.
 */

// ---------------------------------------------------------------------------
// Dates and the venue clock
// ---------------------------------------------------------------------------

/** Calendar days since 1970-01-01 for a YYYY-MM-DD, pure calendar math. */
export function dayNumber(iso: IsoDate): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

/** "HH:MM" → minutes after midnight. */
export function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * The venue's wall clock: its calendar day and minutes after midnight. Rota
 * days are venue days, so "today", "on shift now" and "has this day passed"
 * all ask the venue's timezone, never the device's. An unknown timezone falls
 * back to UTC rather than throwing.
 */
export function venueNow(timezone: string, now: Date = new Date()): { date: IsoDate; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return { date: now.toISOString().slice(0, 10), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() };
  }
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = Number(get('hour')) % 24;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: hour * 60 + Number(get('minute')) };
}

const utc = (iso: IsoDate) => new Date(`${iso}T00:00:00.000Z`);

/** "Friday 9 October" (`withYear`: "Friday 9 October 2026"). The confirm sheet never abbreviates a date. */
export function longDate(iso: IsoDate, withYear = false): string {
  return utc(iso).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  }).replace(/,/g, '');
}

/** "Fri" */
export function shortWeekday(iso: IsoDate): string {
  return utc(iso).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

/** Day of the month as a number. */
export function dayOfMonth(iso: IsoDate): number {
  return Number(iso.slice(8, 10));
}

/** Saturday or Sunday (the weekend tint in strips and grids). */
export function isWeekend(iso: IsoDate): boolean {
  const d = utc(iso).getUTCDay();
  return d === 0 || d === 6;
}

/** "5 – 11 Oct", or "28 Sep – 4 Oct" across a month boundary. */
export function weekRangeLabel(weekStart: IsoDate, weekEnd: IsoDate): string {
  const month = (iso: IsoDate) => utc(iso).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  const a = dayOfMonth(weekStart);
  const b = dayOfMonth(weekEnd);
  return month(weekStart) === month(weekEnd) ? `${a} – ${b} ${month(weekEnd)}` : `${a} ${month(weekStart)} – ${b} ${month(weekEnd)}`;
}

/** "Tue 6 Oct · 18:40" in the venue's timezone, for "Published …" footnotes. */
export function formatStamp(isoInstant: string, timezone: string): string {
  const d = new Date(isoInstant);
  if (Number.isNaN(d.getTime())) return '';
  const opts = (o: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions => ({ ...o, timeZone: timezone });
  try {
    const day = d.toLocaleDateString('en-GB', opts({ weekday: 'short', day: 'numeric', month: 'short' })).replace(',', '');
    const time = d.toLocaleTimeString('en-GB', opts({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    return `${day} · ${time}`;
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' · ');
  }
}

/** "07–16" for a tile, "11·18" for a split (both starts); minutes only when not on the hour. */
export function shortTimes(ranges: TimeRange[]): string {
  const hh = (t: string) => (t.endsWith(':00') ? t.slice(0, 2) : t);
  if (ranges.length === 0) return '';
  if (ranges.length > 1) return ranges.map((r) => hh(r.start)).join('·');
  return `${hh(ranges[0]!.start)}–${hh(ranges[0]!.end)}`;
}

// ---------------------------------------------------------------------------
// Shift-type codes for dense views
// ---------------------------------------------------------------------------

/**
 * One letter per venue shift type for the Team Matrix and paint tiles,
 * unique within the venue: the name's initial, else its next unused
 * consonant, else its next unused letter ("Morning" M, "Mid" D, "Evening" E,
 * "Split" S — the design's codes). Live types claim letters before archived
 * ones, in the venue's order, so a code never changes because an old type
 * was retired.
 */
export function typeCodes(types: Pick<ShiftTypeDto, 'id' | 'name' | 'sortOrder' | 'archivedAt'>[]): Map<string, string> {
  const ordered = types
    .slice()
    .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const t of ordered) {
    const letters = [...t.name.toUpperCase()].filter((c) => /[A-Z0-9]/.test(c));
    const consonants = letters.slice(1).filter((c) => !'AEIOU'.includes(c));
    const pick = [letters[0], ...consonants, ...letters.slice(1)].find((c) => c && !used.has(c)) ?? letters[0] ?? '?';
    used.add(pick);
    out.set(t.id, pick);
  }
  return out;
}

/** A shift's code: its type's code, "S" for an untyped split, "C" for custom times. */
export function codeOf(shift: Pick<WeekShiftDto, 'shiftTypeId' | 'ranges'>, codes: Map<string, string>): string {
  const code = shift.shiftTypeId ? codes.get(shift.shiftTypeId) : undefined;
  if (code) return code;
  return shift.ranges.length > 1 ? 'S' : 'C';
}

// ---------------------------------------------------------------------------
// People and departments
// ---------------------------------------------------------------------------

export interface DeptGroup {
  id: string;
  name: string;
  tint: ShiftTint;
  people: WeekPersonDto[];
}

/** The server's pseudo-department for roles nobody has grouped (weekActions OTHER_DEPARTMENT_ID). */
export const OTHER_DEPARTMENT = 'other';

/**
 * Active people grouped under their primary department, in the venue's
 * department order. Someone with no department (no role, or an ungrouped one)
 * lands in "Other". Empty departments are dropped.
 */
export function groupPeople(week: Pick<WeekDocDto, 'departments' | 'people'>): DeptGroup[] {
  const groups: DeptGroup[] = week.departments.map((d: DepartmentDto) => ({ id: d.id, name: d.name, tint: d.tint, people: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const p of week.people) {
    if (!p.isActive) continue;
    let g = (p.departmentId && byId.get(p.departmentId)) || byId.get(OTHER_DEPARTMENT);
    if (!g) {
      g = { id: OTHER_DEPARTMENT, name: 'Other', tint: 'cream', people: [] };
      groups.push(g);
      byId.set(g.id, g);
    }
    g.people.push(p);
  }
  return groups.filter((g) => g.people.length > 0);
}

/**
 * The short name used where space is tight (paint grid, toasts): the first
 * name, "Sam O." when two people share it, the full name when even that
 * collides (Spec §4, duplicate names).
 */
export function displayNames(people: Pick<WeekPersonDto, 'id' | 'fullName'>[]): Map<string, string> {
  const words = (n: string) => n.trim().split(/\s+/).filter(Boolean);
  const first = (n: string) => words(n)[0] ?? n;
  const initialForm = (n: string) => {
    const w = words(n);
    return w.length > 1 ? `${w[0]} ${w[w.length - 1]![0]!.toUpperCase()}.` : n;
  };
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const firstCounts = count(people.map((p) => first(p.fullName)));
  const initialCounts = count(people.map((p) => initialForm(p.fullName)));
  const out = new Map<string, string>();
  for (const p of people) {
    const f = first(p.fullName);
    if ((firstCounts.get(f) ?? 0) < 2) out.set(p.id, f);
    else if ((initialCounts.get(initialForm(p.fullName)) ?? 0) < 2) out.set(p.id, initialForm(p.fullName));
    else out.set(p.id, p.fullName);
  }
  return out;
}

/** "Floor · Waiter" (+ " · also Bar") for sheets and the person header. */
export function roleLine(person: WeekPersonDto, departments: DepartmentDto[]): string {
  const name = (id: string | null) => departments.find((d) => d.id === id)?.name ?? null;
  const parts = [name(person.departmentId), person.roleTitle].filter((x): x is string => !!x);
  const also = person.alsoDepartmentIds.map(name).filter((x): x is string => !!x);
  if (also.length) parts.push(`also ${also.join(', ')}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// One person-day
// ---------------------------------------------------------------------------

export interface PersonDay {
  userId: string;
  date: IsoDate;
  /** Live shifts that day (one by the v2 rule; two only for legacy doubles). */
  shifts: WeekShiftDto[];
  leave: WeekLeaveDto | null;
  /** A pending time-off request covering this day. */
  pendingRequest: WeekRequestDto | null;
  /** Approved time off: the day is locked for tap, paint and drag (B2 state 3a). */
  locked: boolean;
}

export function personDay(week: Pick<WeekDocDto, 'shifts' | 'leaves' | 'requests'>, userId: string, date: IsoDate): PersonDay {
  const shifts = week.shifts
    .filter((s) => s.userId === userId && s.date === date)
    .sort((a, b) => (a.ranges[0]?.start ?? '').localeCompare(b.ranges[0]?.start ?? ''));
  const leave = week.leaves.find((l) => l.userId === userId && l.date === date) ?? null;
  const pendingRequest =
    week.requests.find((r) => r.kind === 'timeOff' && r.status === 'pending' && r.userId === userId && r.dates.includes(date)) ?? null;
  return { userId, date, shifts, leave, pendingRequest, locked: isLockedLeave(leave) };
}

/**
 * Leave created by an approved time-off request locks the day: the manager
 * reverses the approval first (a separate, deliberate action). Leave a
 * manager marked by hand is just a status and can be painted over.
 */
export function isLockedLeave(leave: WeekLeaveDto | null): boolean {
  return !!leave && leave.fromRequest;
}

/** Leave that a shift may not simply replace (the server refuses `person_on_leave`): it has to be cleared first. */
export function leaveNeedsClearing(leave: WeekLeaveDto | null): boolean {
  return !!leave && leaveBlocksShifts(leave.type);
}
