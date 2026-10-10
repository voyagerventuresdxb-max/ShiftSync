import {
  LEAVE_LABELS,
  formatRange,
  type IsoDate,
  type LeaveTypeCode,
  type TimeRange,
  type WeekDocDto,
  type WeekLeaveDto,
  type WeekPersonDto,
  type WeekShiftDto,
} from '../../../shared/rotaWeek.js';
import type { ReadAnswer } from './intentSchema.js';
import { resolveTerm } from './vocabulary.js';

/**
 * The words of the rota reads (reads.ts): from a week document — already scoped to what the
 * caller may see by `getWeekDoc` — to the rows the app shows (`answer`) and the sentence voice
 * says (`summary`), in the style of Design board E's "Voice reads". Pure: no database, no clock,
 * so every phrasing is tested word for word on a made-up week (readWords.test.ts).
 */

/** The synthetic department of roles nobody has grouped yet (weekActions' OTHER_DEPARTMENT_ID). */
export const OTHER_DEPARTMENT = 'other';

export interface Words {
  answer: ReadAnswer;
  summary: string;
}

/** "Thursday 8 October 2026". */
export function longDay(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
/** "Thursday 8 October": how a day is said in a spoken answer. */
export function spokenDay(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
/** "Thursday". */
export function weekdayOf(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}
/** "Thu 8 Oct". */
export function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Spoken wording
// ---------------------------------------------------------------------------

/** "16:00" → "16", "11:30" → "11:30": the venue's 24-hour clock the way people say it. */
export function spokenTime(t: string): string {
  const [h, m] = t.split(':');
  return m === '00' ? String(Number(h)) : `${Number(h)}:${m}`;
}
/** "11 to 15 and 18 to 23". A cross-midnight range is said as it is ("16 to 1"). */
export function spokenRanges(ranges: TimeRange[]): string {
  return ranges.map((r) => `${spokenTime(r.start)} to ${spokenTime(r.end)}`).join(' and ');
}
/** "Priya", "Priya and Omar", "Priya, Omar and Lina". */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
export const countWord = (n: number) => COUNT_WORDS[n] ?? String(n);
const isAre = (n: number) => (n === 1 ? 'is' : 'are');
const hasHave = (n: number) => (n === 1 ? 'has' : 'have');
/** "one more", "two more". */
const more = (n: number) => `${(COUNT_WORDS[n] ?? String(n)).toLowerCase()} more`;
/** A long list of names is cut short when spoken: the rest are counted. */
const MAX_SPOKEN_NAMES = 12;
function nameList(names: string[]): string {
  if (names.length <= MAX_SPOKEN_NAMES) return joinWords(names);
  const rest = names.length - MAX_SPOKEN_NAMES + 1;
  return joinWords([...names.slice(0, MAX_SPOKEN_NAMES - 1), `${rest} others`]);
}
/** How a leave is said after a name: "is on annual leave", "is off sick". */
const LEAVE_SPOKEN: Record<LeaveTypeCode, { one: string; many: string }> = {
  DAY_OFF: { one: 'has a day off', many: 'have a day off' },
  ANNUAL_LEAVE: { one: 'is on annual leave', many: 'are on annual leave' },
  SICK_LEAVE: { one: 'is off sick', many: 'are off sick' },
  UNPAID_LEAVE: { one: 'is on unpaid leave', many: 'are on unpaid leave' },
  HALF_DAY: { one: 'has a half day', many: 'have a half day' },
};
/** The leave in brackets after a name in an "Off:" list. */
const LEAVE_NOTE: Record<LeaveTypeCode, string> = {
  DAY_OFF: 'day off',
  ANNUAL_LEAVE: 'annual leave',
  SICK_LEAVE: 'sick',
  UNPAID_LEAVE: 'unpaid leave',
  HALF_DAY: 'half day',
};

/** The times as the app's chips show them: "16:00–01:00 (+1)", "11:00–15:00 + 18:00–23:00". */
function chipTimes(s: { ranges: TimeRange[]; endsNextDay: boolean }): string {
  return `${s.ranges.map((r) => formatRange(r, '24h')).join(' + ')}${s.endsNextDay ? ' (+1)' : ''}`;
}

// ---------------------------------------------------------------------------
// The week, looked up
// ---------------------------------------------------------------------------

/** Lookups over one week document, with the spoken name of each person. */
function viewOf(doc: WeekDocDto) {
  const people = new Map(doc.people.map((p) => [p.id, p]));
  const types = new Map(doc.shiftTypes.map((t) => [t.id, t]));
  const departments = new Map(doc.departments.map((d) => [d.id, d]));
  const roleDept = new Map(doc.departments.flatMap((d) => d.roleIds.map((r) => [r, d.id] as const)));
  // First names when nobody else at the venue shares one ("Priya"), the full name otherwise.
  const firstCount = new Map<string, number>();
  const first = (p: WeekPersonDto) => p.fullName.trim().split(/\s+/)[0] ?? p.fullName;
  for (const p of doc.people) firstCount.set(first(p).toLowerCase(), (firstCount.get(first(p).toLowerCase()) ?? 0) + 1);
  const said = (userId: string) => {
    const p = people.get(userId);
    if (!p) return 'a former staff member';
    return firstCount.get(first(p).toLowerCase()) === 1 ? first(p) : p.fullName;
  };
  const fullName = (userId: string | null) => (userId ? (people.get(userId)?.fullName ?? 'Former staff member') : 'Open shift');
  const deptOfShift = (s: WeekShiftDto) => {
    const id = s.departmentId ?? roleDept.get(s.roleId) ?? OTHER_DEPARTMENT;
    return departments.has(id) ? id : OTHER_DEPARTMENT;
  };
  const deptOfPerson = (userId: string) => {
    const id = people.get(userId)?.departmentId ?? OTHER_DEPARTMENT;
    return departments.has(id) ? id : OTHER_DEPARTMENT;
  };
  const deptName = (id: string) => departments.get(id)?.name ?? 'Other';
  const typeName = (s: WeekShiftDto) => (s.shiftTypeId ? (types.get(s.shiftTypeId)?.name ?? null) : null);
  // Leave rows in the grid's row order (people by name), whatever order the database returned them in.
  const rowOf = new Map(doc.people.map((p, i) => [p.id, i]));
  const leavesOn = (day: IsoDate) => doc.leaves.filter((l) => l.date === day).sort((a, b) => (rowOf.get(a.userId) ?? 0) - (rowOf.get(b.userId) ?? 0));
  return { people, said, fullName, deptOfShift, deptOfPerson, deptName, typeName, leavesOn };
}
type View = ReturnType<typeof viewOf>;

/** Minutes after the shift day's midnight; a range that crosses midnight ends after 24:00. */
function minutesOf(r: TimeRange): { from: number; to: number } {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const from = m(r.start);
  const to = m(r.end);
  return { from, to: to <= from ? to + 24 * 60 : to };
}
const startMinutes = (s: WeekShiftDto) => (s.ranges[0] ? minutesOf(s.ranges[0]).from : 0);

/**
 * The service periods a shift is in, by overlap: morning service 05:00–14:00, evening service
 * 17:00 to 04:00 the next morning (the same windows the instant-based read used).
 */
function inPeriod(s: WeekShiftDto, period: 'AM' | 'PM'): boolean {
  const [from, to] = period === 'AM' ? [5 * 60, 14 * 60] : [17 * 60, 28 * 60];
  return s.ranges.some((r) => {
    const m = minutesOf(r);
    return m.from < to && m.to > from;
  });
}

/** One row per shift for the app: who, then times · type · role, then draft. */
function shiftItem(s: WeekShiftDto, v: View, roles: Map<string, string>, primary = v.fullName(s.userId)) {
  const type = v.typeName(s);
  return {
    primary,
    secondary: `${chipTimes(s)}${type ? ` · ${type}` : ''} · ${roles.get(s.roleId) ?? 'Shift'}`,
    ...(s.status === 'draft' ? { tertiary: 'Draft (not published yet)' } : {}),
  };
}
function leaveItem(l: WeekLeaveDto, primary: string) {
  return { primary, secondary: LEAVE_LABELS[l.type], ...(l.status === 'draft' ? { tertiary: 'Draft (not published yet)' } : {}) };
}

/**
 * How a shift's timing is said: "Mid 11 to 20" the first time a shift type comes up in an
 * answer, plain "Mid" after that; custom times as times.
 */
function labeller(v: View) {
  const said = new Set<string>();
  return (s: WeekShiftDto): { key: string; label: string } => {
    const type = v.typeName(s);
    const times = spokenRanges(s.ranges);
    const key = `${type ?? ''}|${times}`;
    if (!type) return { key, label: times };
    const label = said.has(key) ? type : `${type} ${times}`;
    said.add(key);
    return { key, label };
  };
}

/** Who has no shift and no leave on `day`, in the document's order. */
function offOn(doc: WeekDocDto, day: IsoDate): WeekPersonDto[] {
  const busy = new Set<string>([
    ...doc.shifts.filter((s) => s.date === day && s.userId).map((s) => s.userId as string),
    ...doc.leaves.filter((l) => l.date === day).map((l) => l.userId),
  ]);
  return doc.people.filter((p) => !busy.has(p.id));
}

// ---------------------------------------------------------------------------
// WHO_IS_WORKING
// ---------------------------------------------------------------------------

const PERIOD_WORD = { AM: 'in the morning', PM: 'in the evening' } as const;

/**
 * "Wednesday 7 October: 8 people. Floor — Priya on Mid 11 to 20, Karim on Evening 16 to 1, Lina
 * is off sick. Bar — Elena and Mei on Evening. Off: Omar, Mateo (annual leave), Tariq."
 */
export function whoIsWorkingWords(
  doc: WeekDocDto,
  o: { day: IsoDate; period: 'AM' | 'PM' | null; today: IsoDate; manager: boolean; roles: Map<string, string> },
): Words {
  const { day, period, roles } = o;
  const v = viewOf(doc);
  const deptOrder = new Map(doc.departments.map((d, i) => [d.id, i]));
  const order = (id: string) => deptOrder.get(id) ?? doc.departments.length;
  const shifts = doc.shifts
    .filter((s) => s.date === day && (!period || inPeriod(s, period)))
    .sort((a, b) => order(v.deptOfShift(a)) - order(v.deptOfShift(b)) || startMinutes(a) - startMinutes(b));
  const leaves = v.leavesOn(day);

  const when = period === 'PM' && day === o.today ? 'tonight' : period ? PERIOD_WORD[period] : day === o.today ? 'today' : '';
  const title = `Working${when ? ` ${when}` : ''} — ${longDay(day)}`;
  const emptyText = o.manager ? `Nobody is on the rota${when ? ` ${when}` : ''} for ${longDay(day)}.` : `Nobody is on the published rota${when ? ` ${when}` : ''} for ${longDay(day)}.`;
  const items = [...shifts.map((s) => shiftItem(s, v, roles)), ...leaves.map((l) => leaveItem(l, v.fullName(l.userId)))];

  // The spoken answer: departments in the grid's order, people grouped by the shift they are on.
  const label = labeller(v);
  const lines: string[] = [];
  const departmentIds = [...new Set([...shifts.map((s) => v.deptOfShift(s)), ...leaves.filter((l) => l.type === 'SICK_LEAVE').map((l) => v.deptOfPerson(l.userId))])].sort(
    (a, b) => order(a) - order(b),
  );
  for (const dept of departmentIds) {
    const groups = new Map<string, { label: string; again: string; names: string[]; open: number }>();
    for (const s of shifts.filter((x) => v.deptOfShift(x) === dept)) {
      const l = label(s);
      const g = groups.get(l.key) ?? { label: l.label, again: v.typeName(s) ?? l.label, names: [], open: 0 };
      if (s.userId) g.names.push(v.said(s.userId));
      else g.open++;
      groups.set(l.key, g);
    }
    const parts: string[] = [];
    for (const g of groups.values()) {
      if (g.names.length) parts.push(`${joinWords(g.names)} on ${g.label}`);
      // Said right after the people on the same shift: its times once is enough.
      if (g.open) parts.push(`${g.open === 1 ? 'one open shift' : `${countWord(g.open).toLowerCase()} open shifts`} on ${g.names.length ? g.again : g.label}`);
    }
    for (const l of leaves.filter((x) => x.type === 'SICK_LEAVE' && v.deptOfPerson(x.userId) === dept)) parts.push(`${v.said(l.userId)} is off sick`);
    lines.push(`${v.deptName(dept)} — ${parts.join(', ')}.`);
  }
  const working = new Set(shifts.map((s) => s.userId).filter((id): id is string => id !== null)).size;
  // Off: nobody on a shift that day (whatever the period) and not sick; other leave in brackets.
  const off = [
    ...offOn(doc, day).map((p) => v.said(p.id)),
    ...leaves.filter((l) => l.type !== 'SICK_LEAVE').map((l) => (l.type === 'DAY_OFF' ? v.said(l.userId) : `${v.said(l.userId)} (${LEAVE_NOTE[l.type]})`)),
  ];
  const drafts = shifts.filter((s) => s.status === 'draft').length;
  const head = `${spokenDay(day)}${period ? (period === 'AM' ? ', morning' : ', evening') : ''}: ${working === 0 ? 'nobody yet' : `${working} ${working === 1 ? 'person' : 'people'}`}.`;
  const summary =
    !shifts.length && !leaves.length
      ? emptyText
      : [
          head,
          ...lines,
          ...(off.length ? [`Off: ${nameList(off)}.`] : []),
          ...(drafts ? [`${countWord(drafts)} of these shifts ${drafts === 1 ? 'is' : 'are'} not published yet.`] : []),
        ].join(' ');
  return { answer: { title, items, emptyText }, summary };
}

// ---------------------------------------------------------------------------
// WHO_IS_OFF
// ---------------------------------------------------------------------------

/**
 * "Thursday 8 October: Omar, Tariq and Hana are off. Mateo is on annual leave. Priya has asked for
 * the day off — that request is still pending." `callerId`'s own request is said as "You".
 */
export function whoIsOffWords(doc: WeekDocDto, o: { day: IsoDate; callerId: string }): Words {
  const { day } = o;
  const v = viewOf(doc);
  const off = offOn(doc, day);
  const leaves = v.leavesOn(day);
  // A day off is simply off; every other kind of leave is named.
  const dayOff = leaves.filter((l) => l.type === 'DAY_OFF');
  const named = leaves.filter((l) => l.type !== 'DAY_OFF');
  // Pending time off covering the day (staff: only their own — getWeekDoc already scopes them).
  const pending = doc.requests.filter((r) => r.kind === 'timeOff' && r.status === 'pending' && r.dates.includes(day));

  const items = [
    ...off.map((p) => ({ primary: p.fullName, secondary: 'Off' })),
    ...leaves.map((l) => leaveItem(l, v.fullName(l.userId))),
    ...pending.map((r) => ({ primary: v.fullName(r.userId), secondary: 'Asked for the day off', tertiary: 'Request pending' })),
  ];
  const title = `Off — ${longDay(day)}`;
  const emptyText = `Nobody is off on ${spokenDay(day)}: everyone has a shift.`;

  const sentences: string[] = [];
  const offNames = [...off.map((p) => v.said(p.id)), ...dayOff.map((l) => v.said(l.userId))];
  if (offNames.length) sentences.push(`${nameList(offNames)} ${isAre(offNames.length)} off.`);
  for (const type of ['ANNUAL_LEAVE', 'SICK_LEAVE', 'UNPAID_LEAVE', 'HALF_DAY'] as const) {
    const names = named.filter((l) => l.type === type).map((l) => v.said(l.userId));
    if (names.length) sentences.push(`${nameList(names)} ${names.length === 1 ? LEAVE_SPOKEN[type].one : LEAVE_SPOKEN[type].many}.`);
  }
  if (pending.length) {
    const names = [...new Set(pending.map((r) => (r.userId === o.callerId ? 'You' : v.said(r.userId))))];
    const you = names.length === 1 && names[0] === 'You';
    sentences.push(
      `${joinWords(names)} ${you ? 'have' : hasHave(names.length)} asked for the day off — ${pending.length === 1 ? 'that request is' : 'those requests are'} still pending.`,
    );
  }
  const summary = sentences.length ? `${spokenDay(day)}: ${sentences.join(' ')}` : emptyText;
  return { answer: { title, items, emptyText }, summary };
}

// ---------------------------------------------------------------------------
// COVERAGE
// ---------------------------------------------------------------------------

/**
 * "Not yet — Bar needs one more on Saturday 10 October. Elena and Tariq are on; Mei is off. Karim
 * also works Bar and is free that day." Department minimums and open shifts from the week
 * document's coverage row (the grid's own), for the department asked about (all by default).
 */
export function coverageWords(doc: WeekDocDto, o: { day: IsoDate; department: string | null }): Words | { unknownDepartment: string } {
  const { day } = o;
  const v = viewOf(doc);
  let departments = doc.departments.map((d) => d.id);
  if (o.department?.trim()) {
    const found = resolveTerm(o.department, doc.departments.map((d) => ({ id: d.id, label: d.name })));
    if (found.kind === 'none') return { unknownDepartment: found.heard };
    departments = found.kind === 'one' ? [found.item.id] : found.items.map((i) => i.id);
  }
  const asked = new Set(departments);
  const row = doc.coverage.find((c) => c.date === day);
  const short = (row?.uncovered ?? []).filter((u) => asked.has(u.departmentId));
  const dayShifts = doc.shifts.filter((s) => s.date === day);
  const free = offOn(doc, day);
  const onIn = (dept: string) => [...new Set(dayShifts.filter((s) => s.userId && v.deptOfShift(s) === dept).map((s) => s.userId as string))];

  const title = `Coverage — ${longDay(day)}`;
  const deptLabel = departments.length === 1 && o.department?.trim() ? v.deptName(departments[0]!) : null;
  let covered: string;
  if (deptLabel) {
    const on = onIn(departments[0]!).map((id) => v.said(id));
    covered = `Yes — ${deptLabel} is covered on ${spokenDay(day)}${on.length ? `: ${nameList(on)} ${isAre(on.length)} on` : ''}.`;
  } else {
    const n = row?.on ?? 0;
    covered = `Yes — ${spokenDay(day)} is covered: ${n} ${n === 1 ? 'person is' : 'people are'} on and no shift is left open.`;
  }
  if (!short.length) return { answer: { title, items: [], emptyText: covered }, summary: covered };

  const sentences = [`Not yet — ${joinWords(short.map((u) => `${v.deptName(u.departmentId)} needs ${more(u.short)}`))} on ${spokenDay(day)}.`];
  const items: ReadAnswer['items'] = [];
  for (const u of short) {
    const dept = u.departmentId;
    const on = onIn(dept).map((id) => v.said(id));
    const offHere = free.filter((p) => (p.departmentId ?? OTHER_DEPARTMENT) === dept).map((p) => v.said(p.id));
    const open = dayShifts.filter((s) => !s.userId && v.deptOfShift(s) === dept).length;
    // Someone free that day who also works this department this week ("Karim is Bar-trained"), as the requests strip suggests.
    const crossTrained = free.filter((p) => p.departmentId !== dept && p.alsoDepartmentIds.includes(dept)).map((p) => v.said(p.id));
    const facts = [
      on.length ? `${nameList(on)} ${isAre(on.length)} on` : `nobody is on in ${v.deptName(dept)} yet`,
      ...(offHere.length ? [`${nameList(offHere)} ${isAre(offHere.length)} off`] : []),
    ].join('; ');
    sentences.push(short.length > 1 ? `In ${v.deptName(dept)}, ${facts}.` : `${facts.charAt(0).toUpperCase()}${facts.slice(1)}.`);
    if (open) sentences.push(`${open === 1 ? `One ${v.deptName(dept)} shift is` : `${countWord(open)} ${v.deptName(dept)} shifts are`} still open.`);
    if (crossTrained.length) sentences.push(`${nameList(crossTrained.slice(0, 3))} also ${crossTrained.length === 1 ? 'works' : 'work'} ${v.deptName(dept)} and ${isAre(Math.min(3, crossTrained.length))} free that day.`);
    items.push({
      primary: `${v.deptName(dept)} needs ${u.short} more`,
      secondary: on.length ? `On: ${joinWords(onIn(dept).map((id) => v.fullName(id)))}` : 'Nobody on yet',
      ...(crossTrained.length || offHere.length ? { tertiary: `Free: ${joinWords([...offHere, ...crossTrained])}` } : {}),
    });
  }
  return { answer: { title, items, emptyText: covered }, summary: sentences.join(' ') };
}

// ---------------------------------------------------------------------------
// QUERY_MY_SCHEDULE
// ---------------------------------------------------------------------------

/**
 * The caller's own shifts and leave in `from`..`to` (exclusive) from the staff view of each week
 * touched. "Mid on Monday, Wednesday and Friday, 11 to 20. Evening on Saturday, 16 to 1 next day.
 * Off Tuesday and Sunday."
 */
export function myScheduleWords(
  docs: WeekDocDto[],
  o: { callerId: string; mode: 'day' | 'week' | 'horizon'; from: IsoDate; to: IsoDate; title: string; empty: string; roles: Map<string, string>; horizonDays: number },
): Words {
  const { mode, from, to, title, empty, roles } = o;
  const days: IsoDate[] = [];
  for (let d = from; d < to; d = nextDay(d)) days.push(d);
  const inRange = (date: string) => date >= from && date < to;
  const shifts = docs.flatMap((doc) => {
    const v = viewOf(doc);
    return doc.shifts.filter((s) => s.userId === o.callerId && inRange(s.date)).map((s) => ({ s, v }));
  });
  const leaves = docs.flatMap((doc) => doc.leaves.filter((l) => l.userId === o.callerId && inRange(l.date)));
  shifts.sort((a, b) => a.s.date.localeCompare(b.s.date) || startMinutes(a.s) - startMinutes(b.s));

  const items = [
    ...shifts.map(({ s, v }) => ({ date: s.date, item: shiftItem(s, v, roles, longDay(s.date)) })),
    ...leaves.map((l) => ({ date: l.date, item: leaveItem(l, longDay(l.date)) })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => row.item);

  const times = (s: WeekShiftDto) => `${spokenRanges(s.ranges)}${s.endsNextDay ? ' next day' : ''}`;
  const dayWord = (d: string) => (mode === 'week' ? weekdayOf(d) : spokenDay(d));
  let summary: string;
  if (!shifts.length && !leaves.length) {
    summary = empty;
  } else if (mode === 'day') {
    const parts = [
      ...shifts.map(({ s, v }) => {
        const type = v.typeName(s);
        return type ? `${type}, ${times(s)}` : times(s);
      }),
      ...leaves.map((l) => `you ${LEAVE_SPOKEN[l.type].many}`),
    ];
    summary = `${spokenDay(from)}: ${parts.join('; ')}.`;
  } else {
    // One sentence per kind of shift, in the order the week runs: "Mid on Monday and Friday, 11 to 20."
    const groups = new Map<string, { type: string | null; time: string; days: string[] }>();
    for (const { s, v } of shifts) {
      const type = v.typeName(s);
      const key = `${type ?? ''}|${times(s)}`;
      const g = groups.get(key) ?? { type, time: times(s), days: [] };
      g.days.push(dayWord(s.date));
      groups.set(key, g);
    }
    const sentences = [...groups.values()].map((g) => (g.type ? `${g.type} on ${joinWords(g.days)}, ${g.time}.` : `${joinWords(g.days)}, ${g.time}.`));
    for (const type of Object.keys(LEAVE_LABELS) as LeaveTypeCode[]) {
      const on = leaves.filter((l) => l.type === type).map((l) => dayWord(l.date));
      if (on.length) sentences.push(`${LEAVE_LABELS[type]} on ${joinWords(on)}.`);
    }
    if (mode === 'week') {
      const busy = new Set([...shifts.map(({ s }) => s.date), ...leaves.map((l) => l.date)]);
      const offDays = days.filter((d) => !busy.has(d)).map(weekdayOf);
      if (offDays.length) sentences.push(`Off ${joinWords(offDays)}.`);
    } else {
      sentences.unshift(`You have ${shifts.length} shift${shifts.length === 1 ? '' : 's'} in the next ${o.horizonDays} days.`);
    }
    summary = sentences.join(' ');
  }
  return { answer: { title, items, emptyText: empty }, summary };
}

const nextDay = (iso: IsoDate): IsoDate => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
