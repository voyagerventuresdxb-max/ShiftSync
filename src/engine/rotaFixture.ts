/**
 * A small, generic week document for the rota engine's unit tests ("Person
 * A"…, "Demo Venue" types). Not used by the app.
 */
import { weekDays, type WeekDocDto, type WeekLeaveDto, type WeekPersonDto, type WeekRequestDto, type WeekShiftDto } from '../../shared/rotaWeek';

export const WEEK = '2026-10-12';
export const DAYS = weekDays(WEEK);

export function person(id: string, fullName: string, departmentId: string | null = 'floor', extra: Partial<WeekPersonDto> = {}): WeekPersonDto {
  return {
    id,
    fullName,
    initials: fullName
      .split(' ')
      .map((p) => p[0])
      .join('')
      .slice(0, 2),
    roleId: departmentId === 'bar' ? 'role-bar' : 'role-floor',
    roleTitle: departmentId === 'bar' ? 'Bartender' : 'Waiter',
    departmentId,
    alsoDepartmentIds: [],
    isActive: true,
    hasDevice: true,
    ...extra,
  };
}

export function shift(id: string, userId: string | null, date: string, extra: Partial<WeekShiftDto> = {}): WeekShiftDto {
  return {
    id,
    userId,
    roleId: 'role-floor',
    departmentId: 'floor',
    shiftTypeId: 'morning',
    date,
    ranges: [{ start: '07:00', end: '16:00' }],
    endsNextDay: false,
    note: null,
    status: 'draft',
    editedSincePublish: false,
    pendingRequestId: null,
    ...extra,
  };
}

export function leave(userId: string, date: string, type: WeekLeaveDto['type'], fromRequest = false): WeekLeaveDto {
  return { id: `leave-${userId}-${date}`, userId, date, type, status: 'draft', fromRequest };
}

export function timeOff(id: string, userId: string, dates: string[]): WeekRequestDto {
  return { id, kind: 'timeOff', status: 'pending', userId, dates, reason: null, createdAt: '2026-10-01T09:00:00.000Z' };
}

export function week(extra: Partial<WeekDocDto> = {}): WeekDocDto {
  return {
    locationId: 'loc-1',
    weekStart: WEEK,
    timezone: 'Asia/Dubai',
    clock: '24h',
    version: 7,
    state: 'draft',
    publishedAt: null,
    publishedVersion: null,
    hasUnpublishedChanges: true,
    departments: [
      { id: 'floor', name: 'Floor', tint: 'clay', sortOrder: 1, roleIds: ['role-floor'] },
      { id: 'bar', name: 'Bar', tint: 'gold', sortOrder: 2, roleIds: ['role-bar'] },
    ],
    shiftTypes: [
      { id: 'morning', name: 'Morning', ranges: [{ start: '07:00', end: '16:00' }], endsNextDay: false, tint: 'gold', sortOrder: 1, archivedAt: null },
      { id: 'evening', name: 'Evening', ranges: [{ start: '16:00', end: '01:00' }], endsNextDay: true, tint: 'clay', sortOrder: 2, archivedAt: null },
      {
        id: 'split',
        name: 'Split',
        ranges: [
          { start: '11:00', end: '15:00' },
          { start: '18:00', end: '23:00' },
        ],
        endsNextDay: false,
        tint: 'ochre',
        sortOrder: 3,
        archivedAt: null,
      },
    ],
    people: [person('a', 'Person A'), person('b', 'Person B'), person('c', 'Person C', 'bar')],
    shifts: [],
    leaves: [],
    requests: [],
    coverage: DAYS.map((date) => ({ date, on: 0, off: 3, leave: 0, uncovered: [] })),
    ...extra,
  };
}
