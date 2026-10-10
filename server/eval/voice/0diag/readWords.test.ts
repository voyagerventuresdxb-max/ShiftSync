// DIAGNOSTIC copy (removed next commit): listed first in the CI digest.
// Forces a visible failure line so the run shows these files ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CoverageDayDto, IsoDate, LeaveTypeCode, TimeRange, WeekDocDto, WeekLeaveDto, WeekPersonDto, WeekRequestDto, WeekShiftDto } from '../../../../shared/rotaWeek.js';
import { coverageWords, joinWords, longDay, myScheduleWords, spokenRanges, spokenTime, whoIsOffWords, whoIsWorkingWords, type Words } from '../../../src/voice/readWords.js';

/**
 * The spoken answers of the rota reads, word for word, on a small made-up week (no real names).
 * The week documents here are what `getWeekDoc` hands the reads: the manager's view (drafts too)
 * and a staff member's view (published shifts and leave only, and only their own requests).
 *
 * Week of Monday 2031-03-03. Floor (Server) and Bar (Bartender); shift types Mid 11–20, Evening
 * 16–01 (+1), Split 11–15 + 18–23; Bar needs two people on Saturdays.
 *   Mon  Fay  Bar Mid                    → Fay also works Bar this week
 *   Wed  Ava Mid · Ben Evening (DRAFT) · Cara Evening · Dev Split; Eli sick; Gus annual leave (DRAFT)
 *   Thu  Ava Mid · Dev Evening · Fay Mid; Eli annual leave; Fay has a pending time-off request
 *   Fri  Cara Evening (DRAFT)
 *   Sat  Ava Mid · Cara Evening          → Bar is one short
 */
const MON = '2031-03-03';
const TUE = '2031-03-04';
const WED = '2031-03-05';
const THU = '2031-03-06';
const FRI = '2031-03-07';
const SAT = '2031-03-08';
const DAYS = [MON, TUE, WED, THU, FRI, SAT, '2031-03-09'];
const MID: TimeRange[] = [{ start: '11:00', end: '20:00' }];
const EVENING: TimeRange[] = [{ start: '16:00', end: '01:00' }];
const SPLIT: TimeRange[] = [
  { start: '11:00', end: '15:00' },
  { start: '18:00', end: '23:00' },
];
const TYPES = { mid: MID, evening: EVENING, split: SPLIT } as const;
const ROLE_DEPT: Record<string, string> = { server: 'floor', bartender: 'bar' };
const roles = new Map([
  ['server', 'Server'],
  ['bartender', 'Bartender'],
]);

const PEOPLE: [id: string, fullName: string, roleId: string | null][] = [
  ['ava', 'Ava Example', 'server'],
  ['ben', 'Ben Sample', 'server'],
  ['cara', 'Cara Test', 'bartender'],
  ['dev', 'Dev Demo', 'bartender'],
  ['eli', 'Eli Mock', 'server'],
  ['fay', 'Fay Fixture', 'server'],
  ['gus', 'Gus Trial', 'bartender'],
  ['max', 'Max Manager', null],
];

let n = 0;
const shift = (userId: string | null, roleId: string, date: IsoDate, type: keyof typeof TYPES, status: 'draft' | 'published' = 'published'): WeekShiftDto => ({
  id: `s${++n}`,
  userId,
  roleId,
  departmentId: ROLE_DEPT[roleId]!,
  shiftTypeId: type,
  date,
  ranges: TYPES[type],
  endsNextDay: type === 'evening',
  note: null,
  status,
  editedSincePublish: false,
  pendingRequestId: null,
});
const leave = (userId: string, date: IsoDate, type: LeaveTypeCode, status: 'draft' | 'published' = 'published'): WeekLeaveDto => ({ id: `l${++n}`, userId, date, type, status, fromRequest: false });

const SHIFTS: WeekShiftDto[] = [
  { ...shift('fay', 'bartender', MON, 'mid') },
  shift('ava', 'server', WED, 'mid'),
  shift('ben', 'server', WED, 'evening', 'draft'),
  shift('cara', 'bartender', WED, 'evening'),
  shift('dev', 'bartender', WED, 'split'),
  shift('ava', 'server', THU, 'mid'),
  shift('dev', 'bartender', THU, 'evening'),
  shift('fay', 'server', THU, 'mid'),
  shift('cara', 'bartender', FRI, 'evening', 'draft'),
  shift('ava', 'server', SAT, 'mid'),
  shift('cara', 'bartender', SAT, 'evening'),
];
const LEAVES: WeekLeaveDto[] = [leave('eli', WED, 'SICK_LEAVE'), leave('eli', THU, 'ANNUAL_LEAVE'), leave('gus', WED, 'ANNUAL_LEAVE', 'draft')];
const REQUESTS: WeekRequestDto[] = [{ id: 'r1', kind: 'timeOff', status: 'pending', userId: 'fay', dates: [THU], reason: null, createdAt: '2031-03-01T08:00:00.000Z' }];
/** Department minimums, as weekday (0 = Sunday) → department → headcount. */
const MINIMUMS: Record<number, Record<string, number>> = { 6: { bar: 2 } };

/**
 * The week document as `getWeekDoc` builds it for a viewer: a manager (`viewer` null) sees drafts;
 * staff see published rows and only their own requests. Coverage is computed the same way:
 * people on, people on leave, and departments under their minimum or carrying open shifts.
 */
function weekFor(viewer: string | null): WeekDocDto {
  const shifts = SHIFTS.filter((s) => viewer === null || s.status === 'published');
  const leaves = LEAVES.filter((l) => viewer === null || l.status === 'published');
  const people: WeekPersonDto[] = PEOPLE.map(([id, fullName, roleId]) => {
    const own = roleId ? ROLE_DEPT[roleId]! : null;
    return {
      id,
      fullName,
      initials: '',
      roleId,
      roleTitle: roleId ? roles.get(roleId)! : null,
      departmentId: own,
      alsoDepartmentIds: [...new Set(shifts.filter((s) => s.userId === id && s.departmentId && s.departmentId !== own).map((s) => s.departmentId!))],
      isActive: true,
      hasDevice: true,
    };
  });
  const coverage: CoverageDayDto[] = DAYS.map((date) => {
    const day = shifts.filter((s) => s.date === date);
    const on = new Set(day.map((s) => s.userId).filter((u): u is string => u !== null));
    const onLeave = new Set(leaves.filter((l) => l.date === date && !on.has(l.userId)).map((l) => l.userId));
    const short = new Map<string, number>();
    for (const [dept, min] of Object.entries(MINIMUMS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? {})) {
      const working = new Set(day.filter((s) => s.userId && s.departmentId === dept).map((s) => s.userId)).size;
      if (working < min) short.set(dept, min - working);
    }
    for (const s of day) if (!s.userId) short.set(s.departmentId!, (short.get(s.departmentId!) ?? 0) + 1);
    return { date, on: on.size, off: people.length - on.size - onLeave.size, leave: onLeave.size, uncovered: [...short].map(([departmentId, n]) => ({ departmentId, short: n })) };
  });
  return {
    locationId: 'venue',
    weekStart: MON,
    timezone: 'Asia/Dubai',
    clock: '24h',
    version: 3,
    state: 'published',
    publishedAt: null,
    publishedVersion: 2,
    hasUnpublishedChanges: true,
    departments: [
      { id: 'floor', name: 'Floor', tint: 'sage', sortOrder: 0, roleIds: ['server'] },
      { id: 'bar', name: 'Bar', tint: 'gold', sortOrder: 1, roleIds: ['bartender'] },
    ],
    shiftTypes: [
      { id: 'mid', name: 'Mid', ranges: MID, endsNextDay: false, tint: 'sand', sortOrder: 0, archivedAt: null },
      { id: 'evening', name: 'Evening', ranges: EVENING, endsNextDay: true, tint: 'clay', sortOrder: 1, archivedAt: null },
      { id: 'split', name: 'Split', ranges: SPLIT, endsNextDay: false, tint: 'ochre', sortOrder: 2, archivedAt: null },
    ],
    people,
    shifts,
    leaves,
    requests: REQUESTS.filter((r) => viewer === null || r.userId === viewer),
    coverage,
  };
}
const manager = weekFor(null);
const staff = (id: string) => weekFor(id);
const rows = (w: Words) => w.answer.items.map((i) => [i.primary, i.secondary ?? '', i.tertiary ?? '']);
const words = (w: Words | { unknownDepartment: string }): Words => {
  assert.ok(!('unknownDepartment' in w), 'expected an answer');
  return w as Words;
};

test('spoken times: the 24-hour clock as people say it; both ranges of a split; past midnight as it is', () => {
  assert.equal(spokenTime('16:00'), '16');
  assert.equal(spokenTime('07:30'), '7:30');
  assert.equal(spokenRanges(SPLIT), '11 to 15 and 18 to 23');
  assert.equal(spokenRanges(EVENING), '16 to 1');
  assert.equal(joinWords(['A', 'B', 'C']), 'A, B and C');
});

test('"Who\'s working Wednesday?" (manager): departments in order, a shift type named with its times once, sick in its department, drafts counted, who is off', () => {
  const w = whoIsWorkingWords(manager, { day: WED, period: null, today: '2031-03-02', manager: true, roles });
  assert.equal(
    w.summary,
    'Wednesday 5 March: 4 people. Floor — Ava on Mid 11 to 20, Ben on Evening 16 to 1, Eli is off sick. Bar — Dev on Split 11 to 15 and 18 to 23, Cara on Evening. Off: Fay, Max and Gus (annual leave). One of these shifts is not published yet.',
  );
  assert.equal(w.answer.title, `Working — ${longDay(WED)}`);
  assert.deepEqual(rows(w), [
    ['Ava Example', '11:00–20:00 · Mid · Server', ''],
    ['Ben Sample', '16:00–01:00 (+1) · Evening · Server', 'Draft (not published yet)'],
    ['Dev Demo', '11:00–15:00 + 18:00–23:00 · Split · Bartender', ''],
    ['Cara Test', '16:00–01:00 (+1) · Evening · Bartender', ''],
    ['Eli Mock', 'Sick', ''],
    ['Gus Trial', 'Annual leave', 'Draft (not published yet)'],
  ]);
});

test('"Who\'s working Wednesday?" (staff): the published week only — Ben\'s draft shift and Gus\'s draft leave are not heard', () => {
  const w = whoIsWorkingWords(staff('fay'), { day: WED, period: null, today: '2031-03-02', manager: false, roles });
  assert.equal(
    w.summary,
    'Wednesday 5 March: 3 people. Floor — Ava on Mid 11 to 20, Eli is off sick. Bar — Dev on Split 11 to 15 and 18 to 23, Cara on Evening 16 to 1. Off: Ben, Fay, Gus and Max.',
  );
  assert.deepEqual(w.answer.items.map((i) => i.primary), ['Ava Example', 'Dev Demo', 'Cara Test', 'Eli Mock']);
});

test('who is working in a service period, open shifts, people sharing a first name, and an empty day', () => {
  const am = whoIsWorkingWords(manager, { day: WED, period: 'AM', today: '2031-03-02', manager: true, roles });
  assert.equal(am.summary, 'Wednesday 5 March, morning: 2 people. Floor — Ava on Mid 11 to 20, Eli is off sick. Bar — Dev on Split 11 to 15 and 18 to 23. Off: Fay, Max and Gus (annual leave).');
  const tonight = whoIsWorkingWords(manager, { day: WED, period: 'PM', today: WED, manager: true, roles });
  assert.equal(tonight.answer.title, `Working tonight — ${longDay(WED)}`);
  // A Mid (11–20) runs into the evening service, so it is heard "tonight" too.
  assert.match(tonight.summary, /^Wednesday 5 March, evening: 4 people\. Floor — Ava on Mid 11 to 20, Ben on Evening 16 to 1, Eli is off sick\. Bar — Dev on Split 11 to 15 and 18 to 23, Cara on Evening\./);
  // An open Bar shift on Friday, and a second "Cara": full names, so nobody is mistaken.
  const doc = manager;
  const busy: WeekDocDto = {
    ...doc,
    people: [...doc.people, { ...doc.people[2]!, id: 'cara2', fullName: 'Cara Other' }],
    shifts: [...doc.shifts, shift(null, 'bartender', FRI, 'evening', 'draft'), shift(null, 'bartender', FRI, 'evening', 'draft')],
  };
  const fri = whoIsWorkingWords(busy, { day: FRI, period: null, today: '2031-03-02', manager: true, roles });
  assert.match(fri.summary, /^Friday 7 March: 1 person\. Bar — Cara Test on Evening 16 to 1, two open shifts on Evening\. /);
  const tue = whoIsWorkingWords(staff('fay'), { day: TUE, period: null, today: '2031-03-02', manager: false, roles });
  assert.equal(tue.summary, `Nobody is on the published rota for ${longDay(TUE)}.`);
});

test('"Who\'s off Thursday?": off, leave by type, and a pending time-off request said as pending — staff hear only their own', () => {
  const m = whoIsOffWords(manager, { day: THU, callerId: 'max' });
  assert.equal(m.summary, 'Thursday 6 March: Ben, Cara, Gus and Max are off. Eli is on annual leave. Fay has asked for the day off — that request is still pending.');
  assert.deepEqual(rows(m), [
    ['Ben Sample', 'Off', ''],
    ['Cara Test', 'Off', ''],
    ['Gus Trial', 'Off', ''],
    ['Max Manager', 'Off', ''],
    ['Eli Mock', 'Annual leave', ''],
    ['Fay Fixture', 'Asked for the day off', 'Request pending'],
  ]);
  assert.equal(
    whoIsOffWords(staff('fay'), { day: THU, callerId: 'fay' }).summary,
    'Thursday 6 March: Ben, Cara, Gus and Max are off. Eli is on annual leave. You have asked for the day off — that request is still pending.',
  );
  assert.equal(whoIsOffWords(staff('ben'), { day: THU, callerId: 'ben' }).summary, 'Thursday 6 March: Ben, Cara, Gus and Max are off. Eli is on annual leave.');
  assert.equal(whoIsOffWords(staff('ben'), { day: WED, callerId: 'ben' }).summary, 'Wednesday 5 March: Ben, Fay, Gus and Max are off. Eli is off sick.');
  // Everyone on a shift: said so.
  const full: WeekDocDto = { ...manager, people: manager.people.filter((p) => ['ava', 'dev'].includes(p.id)), leaves: [], requests: [] };
  assert.equal(whoIsOffWords(full, { day: THU, callerId: 'max' }).summary, 'Nobody is off on Thursday 6 March: everyone has a shift.');
});

test('"Is Saturday covered?": the short department, who is on, who is off, who also works it and is free; a covered day says so', () => {
  const sat = words(coverageWords(manager, { day: SAT, department: null }));
  assert.equal(sat.summary, 'Not yet — Bar needs one more on Saturday 8 March. Cara is on; Dev and Gus are off. Fay also works Bar and is free that day.');
  assert.deepEqual(rows(sat), [['Bar needs 1 more', 'On: Cara Test', 'Free: Dev, Gus and Fay']]);
  assert.equal(words(coverageWords(staff('ava'), { day: SAT, department: 'the bar' })).summary, sat.summary, '"are we short on bar Saturday?"');
  assert.equal(words(coverageWords(manager, { day: SAT, department: 'floor' })).summary, 'Yes — Floor is covered on Saturday 8 March: Ava is on.');
  const wed = words(coverageWords(manager, { day: WED, department: null }));
  assert.equal(wed.summary, 'Yes — Wednesday 5 March is covered: 4 people are on and no shift is left open.');
  assert.deepEqual([wed.answer.items, wed.answer.emptyText], [[], wed.summary]);
  assert.deepEqual(coverageWords(manager, { day: SAT, department: 'kitchen' }), { unknownDepartment: 'kitchen' });
  // Two departments short, and an open shift.
  const open: WeekDocDto = {
    ...manager,
    coverage: manager.coverage.map((c) => (c.date === SAT ? { ...c, uncovered: [{ departmentId: 'floor', short: 1 }, ...c.uncovered] } : c)),
    shifts: [...manager.shifts, shift(null, 'server', SAT, 'mid', 'draft')],
  };
  assert.equal(
    words(coverageWords(open, { day: SAT, department: null })).summary,
    'Not yet — Floor needs one more and Bar needs one more on Saturday 8 March. In Floor, Ava is on; Ben, Eli and Fay are off. One Floor shift is still open. In Bar, Cara is on; Dev and Gus are off. Fay also works Bar and is free that day.',
  );
});

test('"What am I doing this week?": published shifts only, grouped by shift type, a split\'s two ranges, "next day" past midnight, the days off', () => {
  const week = (id: string) => myScheduleWords([staff(id)], { callerId: id, mode: 'week', from: MON, to: '2031-03-10', title: 't', empty: 'none', roles, horizonDays: 14 });
  const dev = week('dev');
  assert.equal(dev.summary, 'Split on Wednesday, 11 to 15 and 18 to 23. Evening on Thursday, 16 to 1 next day. Off Monday, Tuesday, Friday, Saturday and Sunday.');
  assert.deepEqual(rows(dev), [
    [longDay(WED), '11:00–15:00 + 18:00–23:00 · Split · Bartender', ''],
    [longDay(THU), '16:00–01:00 (+1) · Evening · Bartender', ''],
  ]);
  // Cara's Friday shift is still a draft: not her schedule yet.
  assert.equal(week('cara').summary, 'Evening on Wednesday and Saturday, 16 to 1 next day. Off Monday, Tuesday, Thursday, Friday and Sunday.');
  assert.equal(week('eli').summary, 'Annual leave on Thursday. Sick on Wednesday. Off Monday, Tuesday, Friday, Saturday and Sunday.');
  assert.equal(week('max').summary, 'none');
  const one = myScheduleWords([staff('dev')], { callerId: 'dev', mode: 'day', from: THU, to: FRI, title: 't', empty: 'none', roles, horizonDays: 14 });
  assert.equal(one.summary, 'Thursday 6 March: Evening, 16 to 1 next day.');
  const sick = myScheduleWords([staff('eli')], { callerId: 'eli', mode: 'day', from: WED, to: THU, title: 't', empty: 'none', roles, horizonDays: 14 });
  assert.equal(sick.summary, 'Wednesday 5 March: you are off sick.');
  const horizon = myScheduleWords([staff('ava')], { callerId: 'ava', mode: 'horizon', from: '2031-03-02', to: '2031-03-16', title: 't', empty: 'none', roles, horizonDays: 14 });
  assert.equal(horizon.summary, 'You have 3 shifts in the next 14 days. Mid on Wednesday 5 March, Thursday 6 March and Saturday 8 March, 11 to 20.');
});
