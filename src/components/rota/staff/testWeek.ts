import type { WeekDocDto, WeekLeaveDto, WeekPersonDto, WeekShiftDto } from '../../../../shared/rotaWeek';

/**
 * A small demo week for the unit tests (generic names only — the repo is
 * public). Week of Monday 5 October 2026 at "Demo Venue".
 */
export const WEEK_START = '2026-10-05';

export function person(id: string, fullName: string, departmentId: string | null, extra: Partial<WeekPersonDto> = {}): WeekPersonDto {
  const words = fullName.split(' ');
  return {
    id,
    fullName,
    initials: (words[0]![0]! + (words.length > 1 ? words[words.length - 1]![0]! : '')).toUpperCase(),
    roleId: 'role-1',
    roleTitle: 'Waiter',
    departmentId,
    alsoDepartmentIds: [],
    isActive: true,
    hasDevice: true,
    ...extra,
  };
}

let seq = 0;
export function shift(userId: string | null, date: string, shiftTypeId: string | null, ranges: { start: string; end: string }[], extra: Partial<WeekShiftDto> = {}): WeekShiftDto {
  seq += 1;
  return {
    id: `s${seq}`,
    userId,
    roleId: 'role-1',
    departmentId: 'floor',
    shiftTypeId,
    date,
    ranges,
    endsNextDay: ranges.length > 0 && ranges[ranges.length - 1]!.end <= ranges[ranges.length - 1]!.start,
    note: null,
    status: 'published',
    editedSincePublish: false,
    pendingRequestId: null,
    ...extra,
  };
}

export function leave(userId: string, date: string, type: WeekLeaveDto['type'], extra: Partial<WeekLeaveDto> = {}): WeekLeaveDto {
  return { id: `l-${userId}-${date}`, userId, date, type, status: 'published', fromRequest: false, ...extra };
}

export function demoWeek(over: Partial<WeekDocDto> = {}): WeekDocDto {
  return {
    locationId: 'demo-venue',
    weekStart: WEEK_START,
    timezone: 'Asia/Dubai',
    clock: '24h',
    version: 7,
    state: 'published',
    publishedAt: '2026-10-06T14:40:00.000Z',
    publishedVersion: 6,
    hasUnpublishedChanges: true,
    departments: [
      { id: 'floor', name: 'Floor', tint: 'clay', sortOrder: 0, roleIds: ['role-1'] },
      { id: 'bar', name: 'Bar', tint: 'gold', sortOrder: 1, roleIds: ['role-2'] },
    ],
    shiftTypes: [
      { id: 'm', name: 'Morning', ranges: [{ start: '07:00', end: '16:00' }], endsNextDay: false, tint: 'gold', sortOrder: 0, archivedAt: null },
      { id: 'd', name: 'Mid', ranges: [{ start: '11:00', end: '20:00' }], endsNextDay: false, tint: 'sand', sortOrder: 1, archivedAt: null },
      { id: 'e', name: 'Evening', ranges: [{ start: '16:00', end: '01:00' }], endsNextDay: true, tint: 'clay', sortOrder: 2, archivedAt: null },
      { id: 'sp', name: 'Split', ranges: [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '23:00' }], endsNextDay: false, tint: 'ochre', sortOrder: 3, archivedAt: null },
    ],
    people: [person('a', 'Person Alpha', 'floor'), person('b', 'Person Bravo', 'floor'), person('c', 'Person Charlie', 'bar'), person('d', 'Person Delta', null)],
    shifts: [],
    leaves: [],
    requests: [],
    coverage: [],
    ...over,
  };
}
