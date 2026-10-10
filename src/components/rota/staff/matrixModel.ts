import { formatRange, weekDays, LEAVE_LABELS, type IsoDate, type ShiftTypeDto, type WeekDocDto, type WeekPersonDto, type WeekShiftDto } from '../../../../shared/rotaWeek';
import { codeOf, groupPeople, personDay, typeCodes, type DeptGroup } from './weekModel';

/**
 * Team Matrix cells: one short code per person-day, derived from the same
 * week document the grid edits, so the two can never disagree (Design board
 * E, "Team Matrix"). Codes come from the venue's shift types (M / D / E / S),
 * a double shows both codes, a day with no shift reads "Off", leave reads its
 * status word.
 */

export type MatrixKind = 'shift' | 'double' | 'off' | 'leave' | 'sick';

export interface MatrixCellModel {
  code: string;
  kind: MatrixKind;
  /** Tooltip and accessible detail: "Evening 16:00–01:00 +1". */
  detail: string;
}

function shiftDetail(shift: WeekShiftDto, types: ShiftTypeDto[], clock: '12h' | '24h'): string {
  const name = types.find((t) => t.id === shift.shiftTypeId)?.name ?? 'Custom';
  const times = shift.ranges.map((r) => formatRange(r, clock)).join(' · ');
  return `${name} ${times}${shift.endsNextDay ? ' +1' : ''}`;
}

export function matrixCell(
  week: Pick<WeekDocDto, 'shifts' | 'leaves' | 'requests' | 'shiftTypes' | 'clock'>,
  userId: string,
  date: IsoDate,
  codes: Map<string, string> = typeCodes(week.shiftTypes),
): MatrixCellModel {
  const day = personDay(week, userId, date);
  if (day.shifts.length > 1) {
    return {
      code: day.shifts.map((s) => codeOf(s, codes)).join('+'),
      kind: 'double',
      detail: day.shifts.map((s) => shiftDetail(s, week.shiftTypes, week.clock)).join(' and '),
    };
  }
  if (day.shifts.length === 1) {
    const s = day.shifts[0]!;
    return { code: codeOf(s, codes), kind: 'shift', detail: shiftDetail(s, week.shiftTypes, week.clock) };
  }
  if (day.leave) {
    switch (day.leave.type) {
      case 'DAY_OFF':
        return { code: 'Off', kind: 'off', detail: 'Day off' };
      case 'SICK_LEAVE':
        return { code: 'Sick', kind: 'sick', detail: 'Sick' };
      case 'ANNUAL_LEAVE':
        return { code: 'Leave', kind: 'leave', detail: LEAVE_LABELS.ANNUAL_LEAVE };
      case 'UNPAID_LEAVE':
        return { code: 'Unpaid', kind: 'leave', detail: 'Unpaid leave' };
      case 'HALF_DAY':
        return { code: 'Half', kind: 'leave', detail: LEAVE_LABELS.HALF_DAY };
    }
  }
  return { code: 'Off', kind: 'off', detail: 'Not scheduled' };
}

export interface MatrixGroup {
  group: DeptGroup;
  rows: { person: WeekPersonDto; cells: MatrixCellModel[] }[];
}

/** Every active person grouped by department, with a cell per day of the week. */
export function matrixGroups(week: WeekDocDto): MatrixGroup[] {
  const days = weekDays(week.weekStart);
  const codes = typeCodes(week.shiftTypes);
  return groupPeople(week).map((group) => ({
    group,
    rows: group.people.map((person) => ({ person, cells: days.map((d) => matrixCell(week, person.id, d, codes)) })),
  }));
}

/** The legend: each live type's code and name, in the venue's order. */
export function matrixLegend(types: ShiftTypeDto[]): { code: string; name: string }[] {
  const codes = typeCodes(types);
  return types
    .filter((t) => !t.archivedAt)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => ({ code: codes.get(t.id) ?? '?', name: t.name }));
}
