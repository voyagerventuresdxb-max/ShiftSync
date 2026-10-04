/**
 * The roster-eval corpus, declared once. Every roster is a week starting Monday 2026-08-17; every
 * name is made up. Ground truth comes from `truthOfCell` below — an interpreter independent of
 * the parsers under test — so the eval can never grade the parser against itself.
 */
export const WEEK_START = '2026-08-17';
export const DATES = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'];

export type Layout = 'grid' | 'title-column' | 'long-format' | 'am-pm-merged' | 'csv' | 'pdf-text' | 'multi-sheet' | 'multi-sheet-notes-first';
export type DayHeaderStyle =
  | 'date' // 17-Aug
  | 'weekday' // Monday
  | 'weekday-date' // Mon 17/08
  | 'short-weekday' // Mon
  | 'weekday-upper-dash' // MON 17-08
  | 'weekday-day-month' // Mon 17 Aug
  | 'date-weekday' // 17/08 Mon
  | 'weekday-date-mismatch'; // Mon 17/08, but the third column says Thu 19/08 (19/08 is a Wednesday)

/** The column whose printed weekday is wrong in 'weekday-date-mismatch'. */
export const MISMATCH_DAY = 2;

export interface StaffSpec {
  name: string;
  /** Section/role. In 'grid' layouts it becomes a section-header row; in 'title-column' each row's title. */
  role: string;
  /** One cell per day (Mon..Sun). For 'am-pm-merged': `AM|PM` pairs like '9-13|14-18'. */
  cells: string[];
}

export interface CorpusSpec {
  id: string;
  /** What the variant exercises (for the report): layout, name style, codes… */
  tags: string[];
  layout: Layout;
  dayHeader: DayHeaderStyle;
  /** Header text over the name column ('' = none). */
  nameHeader: string;
  /** false: no section headers at all (every role is unknown to the parser). */
  sectionHeaders: boolean;
  staff: StaffSpec[];
  /** The escalation the rules in parsing/escalation.ts should pick, or null. */
  expectEscalation: string | null;
}

export interface TruthShift { name: string; role: string; date: string; start: string; end: string }
export interface TruthLeave { name: string; date: string; code: string }
export interface TruthFlag { name: string; date: string }
export interface Truth { id: string; weekStart: string; shifts: TruthShift[]; leave: TruthLeave[]; flagged: TruthFlag[] }

const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
const LEAVE = new Set(['AL', 'SL', 'UL', 'PH', 'OFF']);

/** What one cell means. Independent of the production parsers on purpose. */
export function truthOfCell(cell: string): { shifts: [string, string][] } | { leave: string } | { flagged: true } | null {
  const c = cell.trim();
  if (!c) return null;
  if (LEAVE.has(c.toUpperCase())) return { leave: c.toUpperCase() };
  if (/^(\d{1,2}(CL|IN)|IN)$/i.test(c)) return { flagged: true };
  let m = c.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) return { shifts: [[hh(+m[1]!), hh(+m[2]!)]] };
  m = c.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,2})$/);
  if (m) return { shifts: [[hh(+m[1]!), hh(+m[2]!)], [hh(+m[3]!), hh(+m[4]!)]] };
  m = c.match(/^(\d{1,2})-(\d{1,2})\/(\d{1,2})-(\d{1,2})$/);
  if (m) return { shifts: [[hh(+m[1]!), hh(+m[2]!)], [hh(+m[3]!), hh(+m[4]!)]] };
  throw new Error(`corpus cell "${c}" has no defined meaning — add it to truthOfCell`);
}

export function truthOf(spec: CorpusSpec): Truth {
  const truth: Truth = { id: spec.id, weekStart: WEEK_START, shifts: [], leave: [], flagged: [] };
  for (const s of spec.staff) {
    s.cells.forEach((cell, day) => {
      const parts = spec.layout === 'am-pm-merged' ? cell.split('|') : [cell];
      for (const part of parts) {
        const t = truthOfCell(part);
        if (!t) continue;
        // Roles are only knowable when the file prints them (section headers / titles / role column).
        const role = spec.sectionHeaders || spec.layout === 'title-column' || spec.layout === 'long-format' ? s.role : '';
        if ('shifts' in t) for (const [start, end] of t.shifts) truth.shifts.push({ name: s.name, role, date: DATES[day]!, start, end });
        else if ('leave' in t) truth.leave.push({ name: s.name, date: DATES[day]!, code: t.leave });
        else truth.flagged.push({ name: s.name, date: DATES[day]! });
        // A header whose weekday disagrees with its date: everything under it needs a look.
        if (spec.dayHeader === 'weekday-date-mismatch' && day === MISMATCH_DAY && !('flagged' in t)) truth.flagged.push({ name: s.name, date: DATES[day]! });
      }
    });
  }
  return truth;
}

const W = ['Emily Carter', 'Lucas Brennan', 'Hannah Whitlow', 'Oliver Grant'];
const A = ['Omar Al Haddad', 'Layla Al Nuaimi', 'Yousef Bin Saleh', 'Mariam Al Kaabi'];
const F = ['Maricel Dela Cruz', 'Jomar Santos', 'Liezel Bautista', 'Rommel Pascual'];
const I = ['Priya Raghunathan', 'Arjun Nair', 'Sneha Kulkarni', 'Vikram Desai'];

const week = (...cells: string[]) => cells;
const BASE = [
  week('9-17', '9-17', 'OFF', '9-17', '9-17', '', ''),
  week('', '14-22', '14-22', '14-22', 'OFF', '14-22', '14-22'),
  week('11 17 18 25', '', '11 17 18 25', '11 17 18 25', '', 'AL', 'AL'),
  week('16-24', '16-24', '', '', '16-24', '16-24', 'SL'),
];
const staffOf = (names: string[], roles: string[], cells = BASE): StaffSpec[] =>
  names.map((name, i) => ({ name, role: roles[i]!, cells: cells[i]! }));

export const CORPUS: CorpusSpec[] = [
  { id: 'grid-western', tags: ['day grid', 'Western names', 'section headers'], layout: 'grid', dayHeader: 'date', nameHeader: '', sectionHeaders: true,
    staff: staffOf(W, ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS']), expectEscalation: null },
  { id: 'grid-arabic-caps', tags: ['day grid', 'ALL-CAPS names', 'Arabic names'], layout: 'grid', dayHeader: 'date', nameHeader: '', sectionHeaders: true,
    staff: staffOf(A.map((n) => n.toUpperCase()), ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS']), expectEscalation: 'all_caps_venue' },
  { id: 'title-column-filipino', tags: ['per-row title column', 'Filipino names'], layout: 'title-column', dayHeader: 'weekday', nameHeader: 'Name', sectionHeaders: false,
    staff: staffOf(F, ['Supervisor', 'Head Waiter', 'Waiter', 'Runner']), expectEscalation: null },
  { id: 'long-format-indian', tags: ['long-format template', 'Indian names'], layout: 'long-format', dayHeader: 'date', nameHeader: 'Employee Name', sectionHeaders: false,
    staff: staffOf(I, ['Bartender', 'Host', 'Chef', 'Runner'], [
      week('9-17', '9-17', '', '9-17', '9-17', '', ''),
      week('', '14-22', '14-22', '14-22', '', '14-22', '14-22'),
      week('10-18', '', '10-18', '10-18', '', '', ''),
      week('16-24', '16-24', '', '', '16-24', '16-24', ''),
    ]), expectEscalation: null },
  { id: 'am-pm-merged', tags: ['merged day headers', 'AM/PM sub-columns', 'split shifts'], layout: 'am-pm-merged', dayHeader: 'weekday', nameHeader: '', sectionHeaders: true,
    staff: staffOf(W, ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS'], [
      week('9-13|14-18', '9-13|14-18', '|', '9-13|', '|14-18', '|', '|'),
      week('|17-23', '10-14|17-23', '10-14|17-23', '|', '|', '10-14|17-23', '|17-23'),
      week('9-13|', '|', '9-13|14-18', '9-13|14-18', '|', '|', '|'),
      week('|', '|18-24', '|18-24', '|', '|18-24', '|18-24', '|'),
    ]), expectEscalation: null },
  { id: 'split-shifts-slash', tags: ['split shifts in one cell', 'Indian names'], layout: 'grid', dayHeader: 'date', nameHeader: '', sectionHeaders: true,
    staff: staffOf(I, ['WAITERS', 'WAITERS', 'RUNNERS', 'RUNNERS'], [
      week('10-14/18-23', '10-14/18-23', '', '10-14/18-23', '', '', ''),
      week('', '11-15/18-22', '11-15/18-22', '', '11-15/18-22', '', ''),
      week('9-17', '', '9-17', '', '9-17', '', ''),
      week('', '12-16/19-23', '', '12-16/19-23', '', '12-16/19-23', ''),
    ]), expectEscalation: null },
  { id: 'leave-codes', tags: ['leave codes UL/IN/CL/PH', 'Filipino names'], layout: 'title-column', dayHeader: 'weekday', nameHeader: 'Name', sectionHeaders: false,
    staff: staffOf(F, ['Supervisor', 'Head Waiter', 'Waiter', 'Runner'], [
      week('UL', '12CL', '10IN', 'OFF', 'IN', '4CL', 'UL'),
      week('9-17', 'UL', 'UL', '9-17', 'PH', '9-17', 'OFF'),
      week('OFF', '14-22', '14-22', 'SL', '14-22', 'UL', '14-22'),
      week('10-18', '10-18', 'AL', 'AL', 'AL', '10-18', 'OFF'),
    ]), expectEscalation: null },
  { id: 'header-vocab-short-days', tags: ['"Team member" header', 'Mon/Tue day headers'], layout: 'grid', dayHeader: 'short-weekday', nameHeader: 'Team member', sectionHeaders: true,
    staff: staffOf(W, ['BARTENDERS', 'BARTENDERS', 'HOSTS', 'HOSTS']), expectEscalation: null },
  { id: 'header-vocab-weekday-date', tags: ['"Mon 17/08" day headers', 'Arabic names'], layout: 'grid', dayHeader: 'weekday-date', nameHeader: 'Staff', sectionHeaders: true,
    staff: staffOf(A, ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS']), expectEscalation: null },
  { id: 'header-vocab-weekday-upper-dash', tags: ['"MON 17-08" day headers', 'Filipino names'], layout: 'grid', dayHeader: 'weekday-upper-dash', nameHeader: 'Staff', sectionHeaders: true,
    staff: staffOf(F, ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS']), expectEscalation: null },
  { id: 'header-vocab-weekday-day-month', tags: ['"Mon 17 Aug" day headers', 'Indian names'], layout: 'grid', dayHeader: 'weekday-day-month', nameHeader: 'Name', sectionHeaders: true,
    staff: staffOf(I, ['BARTENDERS', 'BARTENDERS', 'HOSTS', 'HOSTS']), expectEscalation: null },
  { id: 'header-vocab-date-weekday', tags: ['"17/08 Mon" day headers', 'Western names'], layout: 'grid', dayHeader: 'date-weekday', nameHeader: 'Team member', sectionHeaders: true,
    staff: staffOf(W, ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS']), expectEscalation: null },
  { id: 'header-weekday-mismatch', tags: ['"Thu 19/08" printed over a Wednesday', 'Arabic names'], layout: 'grid', dayHeader: 'weekday-date-mismatch', nameHeader: 'Staff', sectionHeaders: true,
    staff: staffOf(A, ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS']), expectEscalation: null },
  { id: 'no-section-headers', tags: ['no roles printed', 'Western names'], layout: 'grid', dayHeader: 'date', nameHeader: '', sectionHeaders: false,
    staff: staffOf(W, ['', '', '', '']), expectEscalation: 'empty_roles' },
  { id: 'csv-grid', tags: ['CSV', 'day grid', 'Filipino names'], layout: 'csv', dayHeader: 'date', nameHeader: '', sectionHeaders: true,
    staff: staffOf(F, ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS']), expectEscalation: null },
  { id: 'pdf-text-grid', tags: ['text-layer PDF', 'day grid', 'Indian names'], layout: 'pdf-text', dayHeader: 'date', nameHeader: '', sectionHeaders: true,
    staff: staffOf(I, ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS']), expectEscalation: null },
  { id: 'multi-sheet', tags: ['multi-sheet workbook (roster first)', 'Western names'], layout: 'multi-sheet', dayHeader: 'date', nameHeader: '', sectionHeaders: true,
    staff: staffOf(W, ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS']), expectEscalation: null },
  { id: 'multi-sheet-notes-first', tags: ['multi-sheet workbook (notes sheet first)', 'Arabic names'], layout: 'multi-sheet-notes-first', dayHeader: 'date', nameHeader: '', sectionHeaders: true,
    staff: staffOf(A, ['SUPERVISORS', 'SUPERVISORS', 'RUNNERS', 'RUNNERS']), expectEscalation: 'unrecognized_layout' },
];
