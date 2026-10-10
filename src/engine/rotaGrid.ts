/**
 * Rota builder v2 — pure grid logic shared by the week grid, its keyboard
 * map and its tests: cell addressing, what a cell holds, what a drop onto it
 * would do (Design board B2), the coverage row (A3), department grouping
 * (B1) and roving-focus movement (Spec §2). No React, no fetch: everything
 * here is a function of the week document.
 */
import {
  LEAVE_LABELS,
  formatRange,
  leaveBlocksShifts,
  weekDays,
  type CoverageDayDto,
  type DepartmentDto,
  type IsoDate,
  type LeaveTypeCode,
  type ShiftTint,
  type ShiftTypeDto,
  type WeekDocDto,
  type WeekLeaveDto,
  type WeekPersonDto,
  type WeekRequestDto,
  type WeekShiftDto,
} from '../../shared/rotaWeek';

/** The synthetic row id of the open-shifts row in a cell id. */
export const OPEN_ROW = 'open';

/** Droppable / focus id of a cell: `${date}|${userId}` or `${date}|open` (the scheme the old builder used). */
export function cellId(date: IsoDate, userId: string | null): string {
  return `${date}|${userId ?? OPEN_ROW}`;
}

export function parseCellId(id: string): { date: IsoDate; userId: string | null } | null {
  const bar = id.indexOf('|');
  if (bar < 0) return null;
  const date = id.slice(0, bar);
  const row = id.slice(bar + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !row) return null;
  return { date, userId: row === OPEN_ROW ? null : row };
}

// ---------------------------------------------------------------------------
// Dates and labels (calendar math on YYYY-MM-DD; never the device's zone)
// ---------------------------------------------------------------------------

const utc = (iso: IsoDate) => new Date(`${iso}T00:00:00.000Z`);
const fmt = (iso: IsoDate, opts: Intl.DateTimeFormatOptions) => utc(iso).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });

/** "Thu 8" — day headers, toasts. */
export function shortDay(iso: IsoDate): string {
  return `${fmt(iso, { weekday: 'short' })} ${Number(iso.slice(8, 10))}`;
}

/** "Thursday 8 October 2026" — confirm sheets never abbreviate the date (A2). Assembled by hand: ICU adds a comma after the weekday once a year is requested. */
export function fullDate(iso: IsoDate): string {
  return `${fmt(iso, { weekday: 'long' })} ${Number(iso.slice(8, 10))} ${fmt(iso, { month: 'long' })} ${iso.slice(0, 4)}`;
}

/** "Thursday 8 October" — live-region announcements (kept under 12 words). */
export function dayMonth(iso: IsoDate): string {
  return `${fmt(iso, { weekday: 'long' })} ${Number(iso.slice(8, 10))} ${fmt(iso, { month: 'long' })}`;
}

/** Saturday or Sunday. */
export function isWeekend(iso: IsoDate): boolean {
  const d = utc(iso).getUTCDay();
  return d === 0 || d === 6;
}

/** Today's calendar day in the venue's time zone ("2026-10-09"); UTC when the zone is unknown to this device. */
export function venueToday(timezone: string, now: Date = new Date()): IsoDate {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const iso = `${get('year')}-${get('month')}-${get('day')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  } catch {
    // An unknown IANA zone on an old WebView: fall through to UTC.
  }
  return now.toISOString().slice(0, 10);
}

/** First name, or first name + surname initial when two visible people share it ("Sam O.", "Sam K."). */
export function shortNames(people: Pick<WeekPersonDto, 'id' | 'fullName'>[]): Map<string, string> {
  const first = (n: string) => n.trim().split(/\s+/)[0] ?? n;
  const counts = new Map<string, number>();
  for (const p of people) counts.set(first(p.fullName).toLowerCase(), (counts.get(first(p.fullName).toLowerCase()) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of people) {
    const parts = p.fullName.trim().split(/\s+/);
    const f = parts[0] ?? p.fullName;
    const shared = (counts.get(f.toLowerCase()) ?? 0) > 1 && parts.length > 1;
    out.set(p.id, shared ? `${f} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.` : f);
  }
  return out;
}

export function typeName(shiftTypeId: string | null, types: ShiftTypeDto[]): string {
  return types.find((t) => t.id === shiftTypeId)?.name ?? 'Custom';
}

/** "Evening 16:00–01:00" or "Split 11:00–15:00 · 18:00–23:00". */
export function shiftLabel(shift: Pick<WeekShiftDto, 'shiftTypeId' | 'ranges'>, types: ShiftTypeDto[], clock: '12h' | '24h' = '24h'): string {
  return `${typeName(shift.shiftTypeId, types)} ${shift.ranges.map((r) => formatRange(r, clock)).join(' · ')}`;
}

export function leaveLabel(type: LeaveTypeCode): string {
  return LEAVE_LABELS[type];
}

/** Shift types a manager can place: not archived, in the venue's order. */
export function activeTypes(types: ShiftTypeDto[]): ShiftTypeDto[] {
  return types.filter((t) => !t.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// What a cell holds
// ---------------------------------------------------------------------------

export interface CellContents {
  date: IsoDate;
  userId: string | null;
  /** 0–1 for a person (one live shift per person-day); any number for the open row. */
  shifts: WeekShiftDto[];
  leave: WeekLeaveDto | null;
  /** A PENDING time-off request covering this person-day. */
  pendingRequest: WeekRequestDto | null;
}

export type WeekIndex = Map<string, CellContents>;

export function indexWeek(week: Pick<WeekDocDto, 'shifts' | 'leaves' | 'requests'>): WeekIndex {
  const idx: WeekIndex = new Map();
  const at = (date: IsoDate, userId: string | null) => {
    const id = cellId(date, userId);
    let c = idx.get(id);
    if (!c) {
      c = { date, userId, shifts: [], leave: null, pendingRequest: null };
      idx.set(id, c);
    }
    return c;
  };
  for (const s of week.shifts) at(s.date, s.userId).shifts.push(s);
  for (const l of week.leaves) at(l.date, l.userId).leave = l;
  for (const r of week.requests) {
    if (r.kind !== 'timeOff' || r.status !== 'pending') continue;
    for (const d of r.dates) at(d, r.userId).pendingRequest = r;
  }
  return idx;
}

export function cellOf(idx: WeekIndex, date: IsoDate, userId: string | null): CellContents {
  return idx.get(cellId(date, userId)) ?? { date, userId, shifts: [], leave: null, pendingRequest: null };
}

/** Leave that locks the cell against shifts: anything from an approved request, and Annual / Sick / Unpaid (B2 state 3a). */
export function leaveLocksShifts(leave: WeekLeaveDto): boolean {
  return leave.fromRequest || leaveBlocksShifts(leave.type);
}

// ---------------------------------------------------------------------------
// Drops (B2): what happens when a palette item or a chip lands on a cell
// ---------------------------------------------------------------------------

export type DragSource =
  | { kind: 'type'; shiftTypeId: string }
  | { kind: 'status'; leaveType: LeaveTypeCode }
  | { kind: 'shift'; shiftId: string; copy?: boolean };

export type DropVerdict =
  /** Place at once with an Undo toast. `replaces` names what was in the cell. */
  | { state: 'ok'; replaces: string | null }
  /** A pending time-off request: allowed after the confirm sheet, which declines it (B2 3b). */
  | { state: 'confirm'; request: WeekRequestDto; replaces: string | null }
  /** Approved leave: springs back with the explanation (B2 3a). */
  | { state: 'blocked'; message: string }
  /** Not a meaningful drop: danger ring and a one-line reason (B2 4). */
  | { state: 'invalid'; message: string }
  /** Dropped where it already is. */
  | { state: 'noop' };

/** The ring a hovered cell draws for a verdict (rota.css `data-drop`). */
export function dropRing(v: DropVerdict): 'ok' | 'conflict' | 'invalid' | undefined {
  if (v.state === 'ok') return 'ok';
  if (v.state === 'confirm' || v.state === 'blocked') return 'conflict';
  if (v.state === 'invalid') return 'invalid';
  return undefined;
}

export interface DropContext {
  week: WeekDocDto;
  idx: WeekIndex;
  /** Venue today: earlier days are closed to writes. */
  today: IsoDate;
}

const firstName = (p: WeekPersonDto | undefined) => (p ? (p.fullName.trim().split(/\s+/)[0] ?? p.fullName) : 'They');

export function classifyDrop(ctx: DropContext, source: DragSource, target: { date: IsoDate; userId: string | null }): DropVerdict {
  const { week, idx, today } = ctx;
  if (!weekDays(week.weekStart).includes(target.date)) return { state: 'invalid', message: 'That day is outside this week.' };
  if (target.date < today) return { state: 'invalid', message: 'That day has already passed.' };

  let moving: WeekShiftDto | undefined;
  if (source.kind === 'shift') {
    moving = week.shifts.find((s) => s.id === source.shiftId);
    if (!moving) return { state: 'noop' };
    if (moving.date < today && !source.copy) return { state: 'invalid', message: 'That shift is on a day that has passed.' };
    if (moving.date === target.date && moving.userId === target.userId) return { state: 'noop' };
  }
  if (source.kind === 'type' && !week.shiftTypes.some((t) => t.id === source.shiftTypeId && !t.archivedAt)) {
    return { state: 'invalid', message: 'That shift type is no longer in use.' };
  }

  const cell = cellOf(idx, target.date, target.userId);
  if (target.userId === null) {
    if (source.kind === 'status') return { state: 'invalid', message: "Not here. An open shift can't be a day off." };
    return { state: 'ok', replaces: null };
  }

  const person = week.people.find((p) => p.id === target.userId);
  if (!person) return { state: 'invalid', message: 'That person is not on this rota.' };
  if (!person.isActive) return { state: 'invalid', message: `${firstName(person)} is no longer active at this venue.` };

  const existing = cell.shifts.find((s) => s.id !== moving?.id);
  const leave = cell.leave;

  if (source.kind === 'status') {
    if (leave?.fromRequest) {
      return { state: 'blocked', message: `${firstName(person)} is on approved ${leaveLabel(leave.type).toLowerCase()} that day. Decline the leave in Requests first.` };
    }
    if (leave && leave.type === source.leaveType && cell.shifts.length === 0) return { state: 'noop' };
    const replaces = cell.shifts[0] ? shiftLabel(cell.shifts[0], week.shiftTypes, week.clock) : leave ? leaveLabel(leave.type) : null;
    return { state: 'ok', replaces };
  }

  if (leave?.fromRequest) {
    return {
      state: 'blocked',
      message: `Can't drop here. ${firstName(person)} is on approved ${leaveLabel(leave.type).toLowerCase()} that day. Decline the leave in Requests first.`,
    };
  }
  if (source.kind === 'type' && !person.roleId && !existing) {
    return { state: 'invalid', message: `${firstName(person)} has no role yet. Give them one in People first.` };
  }
  const replaces = existing ? shiftLabel(existing, week.shiftTypes, week.clock) : leave ? leaveLabel(leave.type) : null;
  if (cell.pendingRequest) return { state: 'confirm', request: cell.pendingRequest, replaces };
  return { state: 'ok', replaces };
}

// ---------------------------------------------------------------------------
// Coverage row (A3)
// ---------------------------------------------------------------------------

export interface CoverageView {
  /** "10 on · 4 off" */
  line: string;
  on: number;
  off: number;
  /** One pill per short department: "Bar −1". Empty means "Covered". */
  short: { departmentId: string; label: string; short: number }[];
}

export function coverageView(day: CoverageDayDto | undefined, departments: DepartmentDto[]): CoverageView {
  if (!day) return { line: '0 on · 0 off', on: 0, off: 0, short: [] };
  const name = (id: string) => departments.find((d) => d.id === id)?.name ?? 'Open';
  const short = day.uncovered
    .filter((u) => u.short > 0)
    .map((u) => ({ departmentId: u.departmentId, short: u.short, label: `${name(u.departmentId)} −${u.short}` }));
  return { line: `${day.on} on · ${day.off} off`, on: day.on, off: day.off, short };
}

// ---------------------------------------------------------------------------
// Department grouping (B1)
// ---------------------------------------------------------------------------

export interface PersonGroup {
  id: string;
  name: string;
  tint: ShiftTint;
  people: WeekPersonDto[];
}

export const NO_DEPARTMENT = '__none';

/**
 * People grouped under their primary department, departments in the venue's
 * order. Inactive people keep a row only while they still have something this
 * week (their history); otherwise the row disappears (Spec §4 "Person removed").
 */
export function groupPeople(week: Pick<WeekDocDto, 'people' | 'departments' | 'shifts' | 'leaves'>): PersonGroup[] {
  const busy = new Set<string>();
  for (const s of week.shifts) if (s.userId) busy.add(s.userId);
  for (const l of week.leaves) busy.add(l.userId);
  const visible = week.people.filter((p) => p.isActive || busy.has(p.id));
  const depts = [...week.departments].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const known = new Set(depts.map((d) => d.id));
  const groups: PersonGroup[] = depts
    .map((d) => ({ id: d.id, name: d.name, tint: d.tint, people: visible.filter((p) => p.departmentId === d.id) }))
    .filter((g) => g.people.length > 0);
  const rest = visible.filter((p) => !p.departmentId || !known.has(p.departmentId));
  if (rest.length > 0) groups.push({ id: NO_DEPARTMENT, name: groups.length ? 'Other' : 'Team', tint: 'cream', people: rest });
  return groups;
}

/** "Waiter · also Bar" */
export function roleLine(person: WeekPersonDto, departments: DepartmentDto[]): string {
  const also = person.alsoDepartmentIds.map((id) => departments.find((d) => d.id === id)?.name).filter(Boolean);
  const base = person.roleTitle ?? '';
  if (also.length === 0) return base;
  return `${base}${base ? ' · ' : ''}also ${also.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Roving focus (Spec §2 keyboard map)
// ---------------------------------------------------------------------------

export interface FocusPos {
  row: number;
  col: number;
}

export interface FocusLayout {
  rows: number;
  cols: number;
  /** Row index where each department group starts, ascending. */
  groupStarts: number[];
}

/** The next focused cell for a navigation key, or null when the key is not a navigation key. */
export function moveFocus(pos: FocusPos, key: string, layout: FocusLayout): FocusPos | null {
  const { rows, cols, groupStarts } = layout;
  if (rows <= 0 || cols <= 0) return null;
  const clampRow = (r: number) => Math.max(0, Math.min(rows - 1, r));
  const clampCol = (c: number) => Math.max(0, Math.min(cols - 1, c));
  const row = clampRow(pos.row);
  const col = clampCol(pos.col);
  const starts = groupStarts.length ? groupStarts : [0];
  let g = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i]! <= row) g = i;
  switch (key) {
    case 'ArrowUp':
      return { row: clampRow(row - 1), col };
    case 'ArrowDown':
      return { row: clampRow(row + 1), col };
    case 'ArrowLeft':
      return { row, col: clampCol(col - 1) };
    case 'ArrowRight':
      return { row, col: clampCol(col + 1) };
    case 'Home':
      return { row, col: 0 };
    case 'End':
      return { row, col: cols - 1 };
    case 'PageUp':
      return { row: clampRow(row > starts[g]! ? starts[g]! : (starts[g - 1] ?? starts[0]!)), col };
    case 'PageDown':
      return { row: clampRow(starts[g + 1] ?? starts[g]!), col };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Requests strip, status badge, stale-week diff
// ---------------------------------------------------------------------------

/** The cells a request is about, for the hover highlight. */
export function requestCells(week: Pick<WeekDocDto, 'shifts' | 'weekStart'>, req: WeekRequestDto): string[] {
  const days = new Set(weekDays(week.weekStart));
  if (req.kind === 'timeOff') return req.dates.filter((d) => days.has(d)).map((d) => cellId(d, req.userId));
  const out: string[] = [];
  for (const id of [req.shiftId, req.targetShiftId]) {
    const s = id ? week.shifts.find((x) => x.id === id) : undefined;
    if (s) out.push(cellId(s.date, s.userId));
  }
  if (out.length === 0) for (const d of req.dates) if (days.has(d)) out.push(cellId(d, req.userId));
  return out;
}

/** Shifts and leave changed since the last publish (gold dots) — the "N changes" in the status badge. */
export function unpublishedCount(week: Pick<WeekDocDto, 'shifts' | 'leaves'>): number {
  return week.shifts.filter((s) => s.status === 'draft' || s.editedSincePublish).length + week.leaves.filter((l) => l.status === 'draft').length;
}

/** What a person-day shows, as text, for the stale-week comparison. */
function cellText(c: CellContents, types: ShiftTypeDto[]): string {
  if (c.shifts.length > 1) return `${c.shifts.length} open`;
  if (c.shifts[0]) return shiftLabel(c.shifts[0], types);
  if (c.leave) return leaveLabel(c.leave.type);
  return 'Empty';
}

export interface WeekDiffRow {
  date: IsoDate;
  userId: string | null;
  mine: string;
  theirs: string;
}

/** Person-days that differ between the week on screen and the server's newer week (B8 stale dialog). */
export function diffWeeks(mine: WeekDocDto, theirs: WeekDocDto): WeekDiffRow[] {
  const a = indexWeek(mine);
  const b = indexWeek(theirs);
  const ids = new Set([...a.keys(), ...b.keys()]);
  const rows: WeekDiffRow[] = [];
  for (const id of ids) {
    const p = parseCellId(id);
    if (!p) continue;
    const ca = cellOf(a, p.date, p.userId);
    const cb = cellOf(b, p.date, p.userId);
    const ta = cellText(ca, mine.shiftTypes);
    const tb = cellText(cb, theirs.shiftTypes);
    if (ta !== tb) rows.push({ date: p.date, userId: p.userId, mine: ta, theirs: tb });
  }
  return rows.sort((x, y) => x.date.localeCompare(y.date) || String(x.userId).localeCompare(String(y.userId)));
}
