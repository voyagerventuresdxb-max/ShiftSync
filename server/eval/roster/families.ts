/**
 * Synthetic rosters in the two layout families seen in real uploads. Every name is made up.
 *
 *  - Family A: a spreadsheet grid (often exported to a text-layer PDF): a date row and a weekday
 *    row over an AM | PM sub-header, four numeric sub-columns per day (AM start, AM end, PM start,
 *    PM end) in decimal hours (9.5 = 09:30, 26 = 02:00 next day), a COVERS caption row, full-width
 *    section banners (the first group has none), a headcount row after every group, leave shown
 *    only by cell colour with a colour legend to the right, and people with no times all week.
 *  - Family B: a title banner, a DATE row and a DAY OF THE WEEK row, an Events row, then a
 *    title/role column + a name column + one free-text cell per day ("OFF", "UL", "4CL",
 *    "10am/3pm-7pm/12am", "4pm to 2am", ...), with coloured section banners.
 *
 * `buildRoster` turns a variant (data) into the semantic roster — the truth, independent of
 * every parser under test — and `printedSheet` into the sheet a manager would actually upload.
 * The printed text is DERIVED from the semantic values, never the other way round, so the eval
 * can never grade a parser against itself.
 */

export type Family = 'A' | 'B';
export type OutputFormat = 'pdf-text' | 'png' | 'pdf-image' | 'xlsx' | 'csv';
export type HeaderStyle =
  /** "17-Aug" row above a "MONDAY" row (Family A as exported). */
  | 'date-above-weekday'
  /** "MONDAY" row above a "17-Aug" row. */
  | 'weekday-above-date'
  /** One row: "Mon 17/08". */
  | 'weekday-date-slash'
  /** One row: "MONDAY 17 AUGUST". */
  | 'weekday-long-date'
  /** One row: "Aug 17". */
  | 'month-day'
  /** One row: "17th Aug". */
  | 'ordinal'
  /** Weekday names only, plus a title "Rota 17 - 23 Aug". */
  | 'weekday-only-title'
  /** One row: "Mon 17" (no month), plus a title naming the month. */
  | 'weekday-day-title';
export type TimeNotation =
  /** Family A sub-cells: 9.5, 15.5, 18, 26. */
  | 'decimal'
  /** Family A sub-cells: 09:30, 15:30, 18:00, 02:00. */
  | 'colon-cells'
  /** Family B as seen: "4pm to 2am", "10am/3pm-7pm/12am", "10:30-4:00-8:00-12". */
  | 'text12'
  /** Family B: "16:00-02:00", "10:00-15:00 / 19:00-00:00". */
  | 'colon24'
  /** Family B: "16.00-02.00", "18.30-01.00". */
  | 'dot24'
  /** Family B: "4 PM - 2 AM", "10AM-3PM / 7PM-12AM", "6.30pm-1am". */
  | 'mixed12';

export interface VariantSpec {
  id: string;
  family: Family;
  format: OutputFormat;
  tags: string[];
  /** Monday of the printed week. */
  weekStart: string;
  people: number;
  header: HeaderStyle;
  notation: TimeNotation;
  /** Pages the roster is printed on (PDF / image formats). */
  pages: number;
  /** The day header is printed again at the top of page 2+. */
  repeatHeader: boolean;
  /** The text layer is emitted in a scrambled order (positions stay right). */
  shuffleText: boolean;
  /** Weekday header cells printed rotated 90°. */
  rotateWeekdays: boolean;
  /** A "Prepared by … / Page 1 of N" footer under the grid. */
  footer: boolean;
  /** Family B: the name column comes before the title column. */
  nameFirst: boolean;
  /** Section order reversed (groups appear in a different order). */
  reverseSections: boolean;
  /** Names printed in capitals. */
  upperNames: boolean;
  /** Family B: short title abbreviations (Sup, HW 1, Wtr 2, Rnr 3). */
  abbreviations: boolean;
  /** Family B: the header row prints NAME / TITLE over the two leading columns. */
  leadHeaders?: boolean;
  /** A "Total staff on rota" line with per-day counts under the grid. */
  totalsFooter?: boolean;
  /** Text-layer PDF whose ff / fi / fl ligatures come out as separate text items (names chosen to contain them). */
  ligatures?: boolean;
  /** Family B: the leading columns and their order (default title, name — or name, title with nameFirst). */
  lead?: ('no' | 'name' | 'title')[];
  /** Family B: the heading printed over each leading column ('' = none). */
  leadLabels?: Partial<Record<'no' | 'name' | 'title', string>>;
  /** Family B: the column headings sit on a row of their own, under the day header rows. */
  labelsRow?: boolean;
  /** Family B: leading cells left-aligned in tight columns (a long name ends close to the next column). */
  tightLead?: boolean;
  /** Family B: section banners printed in the name column only (not merged across the row). */
  bannerInName?: boolean;
  /** Family B: departments with one-word banners and position titles ("AGM", "Senior Server"). */
  departments?: boolean;
  /** Family B: like departments, but the banners name areas of the venue ("TERRACE", "POOL DECK"). */
  areas?: boolean;
  /** Free-text lines printed under the grid (footers, sign-offs): never people. */
  footerLines?: string[];
  /** A dense, hard-to-read photo: the two AI readings disagree on many cells (mock). */
  hardToRead?: boolean;
  /** A faint scan: the two AI readings spell one name differently (mock). */
  faintNames?: boolean;
  seed: number;
}

/** What one person's day means. Minutes are from midnight of that day; an end past 1440 is the next day. */
export type CellTruth =
  | { kind: 'shift'; segs: [number, number][] }
  | { kind: 'leave'; code: string }
  /** Family A: an empty cell whose fill colour carries the meaning (legend label). Not a shift. */
  | { kind: 'colour'; meaning: string }
  /** Open-ended shorthand ("4CL", "10IN", "IN"): must be flagged for review, never guessed. */
  | { kind: 'open'; text: string }
  | { kind: 'blank' }
  /** A black / illegible cell. */
  | { kind: 'unreadable' };

export interface RosterPerson {
  name: string;
  /** Family B per-row title as printed; null for Family A. */
  title: string | null;
  /** Section banner text the person is listed under; null when the group has no banner. */
  section: string | null;
  /** 1-based page the person is printed on. */
  page: number;
  /** Index of the group (banner block) the person is listed in. */
  group: number;
  cells: CellTruth[];
  /** Family A only: per-day fill colour of a shift cell (outlet / closing duty), or null. */
  shiftFills: (string | null)[];
}

export interface SemanticRoster {
  spec: VariantSpec;
  venue: string;
  dates: string[];
  /** Title line as printed, or null. */
  title: string | null;
  people: RosterPerson[];
  /** Family A colour legend: fill → label. */
  legend: { fill: string; label: string }[];
  /** Family A COVERS caption: day index → note. */
  covers: Record<number, string>;
  /** Family B events row: day index → note. */
  events: Record<number, string>;
}

export interface TruthPerson {
  name: string;
  /** Role as the roster shows it: the title column (Family B) or the section banner (Family A); '' when none. */
  role: string;
  section: string | null;
  page: number;
  /** 1-based printed row on its page (counting every row of the page, headers included). */
  row: number;
  /** Each day cell as a careful reader would transcribe it (sub-cells joined; "[Label]" colour only; "[?]" illegible). */
  cells?: string[];
  /** Per day: the colour key's meaning of a coloured cell that holds times (a duty colour), else null. */
  fills?: (string | null)[];
}
export interface FamilyTruthShift { name: string; role: string; date: string; start: string; end: string }
export interface FamilyTruth {
  id: string;
  family: Family;
  format: OutputFormat;
  file: string;
  tags: string[];
  week: { weekStart: string; dates: string[] };
  /** What the sheet prints above the grid: for mock AI answers, which read dates as printed. */
  printed: {
    title: string | null;
    dayLabels: string[];
    /** Totals lines under the grid (never people), label and per-day cells as printed. */
    totals?: { label: string; cells: string[] }[];
    /** The name column is printed before the title column. */
    nameFirst?: boolean;
    /** Free-text lines under the grid (footers, sign-offs). */
    footers?: string[];
    /** A dense, hard-to-read photo (the mock's two readings disagree on many cells). */
    hardToRead?: boolean;
    /** A faint scan (the mock's two readings spell one name differently). */
    faintNames?: boolean;
  };
  pageCount: number;
  people: TruthPerson[];
  shifts: FamilyTruthShift[];
  leave: { name: string; date: string; code: string }[];
  flagged: { name: string; date: string }[];
}

// --- deterministic randomness --------------------------------------------------------------

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

// --- made-up names (no real person intended): many regions, romanizations and spellings --------

const FIRST = [
  'Yazan', 'Noor', 'Hamdan', 'Rasha', 'Faisal', 'Lubna', 'Khalid', 'Dalia', 'Tariq', 'Huda',
  'Jericho', 'Mylene', 'Rodel', 'Analyn', 'Jayvee', 'Marites', 'Ronaldo', 'Kristine',
  'Bikash', 'Sabina', 'Pemba', 'Anjali', 'Suman', 'Dipesh', 'Kamala', 'Nirmala',
  'Rohit', 'Lakshmi', 'Venkat', 'Deepa', 'Arvind', 'Meenakshi', 'Sanjay', 'Kavya',
  'Chidi', 'Amara', 'Tendai', 'Kwabena', 'Zanele', 'Oluwaseun', 'Wanjiru', 'Kofi',
  'Bogdan', 'Ionut', 'Milena', 'Dragan', 'Agnieszka', 'Vasyl', 'Oksana', 'Radu',
  'Thandiwe', 'Sizwe', 'Mbali', 'Ngozi', 'Ifeoma', 'Kipchoge',
] as const;
const LAST = [
  'Al Marri', 'Haddadin', 'Bin Rashed', 'El Khoury', 'Nasrallah', 'Al Zaabi',
  'Manalastas', 'Dimaculangan', 'Villanueva', 'Macaraeg', 'Tolentino',
  'Gurung', 'Thapa', 'Tamang', 'Adhikari', 'Bhattarai',
  'Menon', 'Iyer', 'Chatterjee', 'Rajagopal', 'Venkataraman', 'Rodrigues',
  'Okafor', 'Mensah', 'Moyo', 'Kone', 'Adeyemi', 'Mwangi', 'Dlamini',
  'Kovalenko', 'Popescu', 'Nowakowska', 'Petrovic', 'Horvat', 'Shevchenko',
  'van der Berg', 'McAllister', 'de la Paz',
] as const;
const SINGLE = ['Jojo', 'Sunny', 'Babu', 'Lulu', 'Kiki', 'Bongani'] as const;

function makeNames(r: () => number, n: number, upper: boolean): string[] {
  const out = new Set<string>();
  while (out.size < n) {
    const name = r() < 0.08 ? pick(r, SINGLE) : `${pick(r, FIRST)} ${pick(r, LAST)}`;
    out.add(upper ? name.toUpperCase() : name);
  }
  return [...out];
}

// --- calendar ------------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

export function weekDates(weekStart: string): string[] {
  const base = Date.parse(`${weekStart}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => new Date(base + i * 86_400_000).toISOString().slice(0, 10));
}
const dm = (iso: string) => ({ d: Number(iso.slice(8, 10)), m: Number(iso.slice(5, 7)) });
const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** Header text for one day column: the rows printed above that column, top to bottom. */
export function dayHeaderLines(spec: VariantSpec, iso: string, day: number): string[] {
  const { d, m } = dm(iso);
  const mon = MONTHS[m - 1]!;
  const short = mon.slice(0, 3);
  const wd = WEEKDAYS[day]!;
  switch (spec.header) {
    case 'date-above-weekday':
      return [`${d}-${short}`, spec.family === 'A' ? wd : titleCase(wd)];
    case 'weekday-above-date':
      return [spec.family === 'A' ? wd : titleCase(wd), `${d}-${short}`];
    case 'weekday-date-slash':
      return [`${titleCase(wd).slice(0, 3)} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`];
    case 'weekday-long-date':
      return [`${wd} ${d} ${mon.toUpperCase()}`];
    case 'month-day':
      return [`${short} ${d}`];
    case 'ordinal':
      return [`${ordinal(d)} ${short}`];
    case 'weekday-only-title':
      return [spec.family === 'A' ? wd : titleCase(wd)];
    case 'weekday-day-title':
      return [`${titleCase(wd).slice(0, 3)} ${d}`];
  }
}

export function titleLine(spec: VariantSpec, venue: string, dates: string[]): string | null {
  const first = dm(dates[0]!);
  const last = dm(dates[6]!);
  const short = (m: number) => MONTHS[m - 1]!.slice(0, 3);
  if (spec.header === 'weekday-only-title') {
    return first.m === last.m ? `Rota ${first.d} - ${last.d} ${short(last.m)}` : `Rota ${first.d} ${short(first.m)} - ${last.d} ${short(last.m)}`;
  }
  if (spec.header === 'weekday-day-title') return `${venue} - Week of ${ordinal(first.d)} ${MONTHS[first.m - 1]}`;
  return spec.family === 'B' ? `${venue} - FOH` : null;
}

// --- time notation (semantic minutes → printed text) ----------------------------------------

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
function decimalHours(min: number): string {
  const h = min / 60;
  return Number.isInteger(h) ? String(h) : String(Math.round(h * 100) / 100);
}
function twelve(min: number, style: 'lower' | 'upper-space' | 'compact-lower'): string {
  const h24 = Math.floor(min / 60) % 24;
  const mm = min % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'am' : 'pm';
  const minutes = mm ? (style === 'compact-lower' ? `.${String(mm).padStart(2, '0')}` : `:${String(mm).padStart(2, '0')}`) : '';
  if (style === 'upper-space') return `${h12}${minutes} ${ap.toUpperCase()}`;
  return `${h12}${minutes}${ap}`;
}
/** 12-hour clock without am/pm, as some rotas chain split shifts ("10:30-4:00-8:00-12"). */
function bare12(min: number, withMinutes: boolean): string {
  const h24 = Math.floor(min / 60) % 24;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return withMinutes ? `${h12}:${String(min % 60).padStart(2, '0')}` : String(h12);
}

/** Family B: one day cell's printed text for a shift. */
export function shiftText(notation: TimeNotation, segs: [number, number][], r: () => number): string {
  const [a, b] = segs;
  switch (notation) {
    case 'text12':
      if (!b) return `${twelve(a![0], 'lower')} to ${twelve(a![1], 'lower')}`;
      // Real rotas print splits two ways: a bridged slash form and a hyphen chain without am/pm.
      if (r() < 0.5) return `${twelve(a![0], 'lower')}/${twelve(a![1], 'lower')}-${twelve(b[0], 'lower')}/${twelve(b[1], 'lower')}`;
      return `${bare12(a![0], true)}-${bare12(a![1], true)}-${bare12(b[0], true)}-${bare12(b[1], false)}`;
    case 'colon24':
      return segs.map(([s, e]) => `${hhmm(s)}-${hhmm(e)}`).join(' / ');
    case 'dot24':
      return segs.map(([s, e]) => `${hhmm(s).replace(':', '.')}-${hhmm(e).replace(':', '.')}`).join('/');
    case 'mixed12':
      if (!b) return r() < 0.5 ? `${twelve(a![0], 'upper-space')} - ${twelve(a![1], 'upper-space')}` : `${twelve(a![0], 'compact-lower')}-${twelve(a![1], 'compact-lower')}`;
      return segs.map(([s, e]) => `${twelve(s, 'lower').toUpperCase()}-${twelve(e, 'lower').toUpperCase()}`).join(' / ');
    default:
      throw new Error(`notation ${notation} is not a Family B notation`);
  }
}

/** Family A: the four sub-cells (AM start, AM end, PM start, PM end) of one day. */
export function subCells(notation: TimeNotation, segs: [number, number][]): string[] {
  const fmt = notation === 'colon-cells' ? hhmm : decimalHours;
  const cells = ['', '', '', ''];
  // Two segments fill AM then PM; a single one goes under AM when it starts before 14:00.
  segs.forEach(([s, e], i) => {
    const slot = segs.length === 2 ? i * 2 : s < 14 * 60 ? 0 : 2;
    cells[slot] = fmt(s);
    cells[slot + 1] = fmt(e);
  });
  return cells;
}

// --- shift patterns --------------------------------------------------------------------------

const A_DAYS: [number, number][][] = [
  [[660, 1020], [1080, 1500]], // 11-17, 18-25
  [[570, 930], [1080, 1380]], // 9.5-15.5, 18-23
  [[960, 1080], [1110, 1560]], // 16-18, 18.5-26
  [[720, 960], [1110, 1440]], // 12-16, 18.5-24
  [[780, 960], [1080, 1500]], // 13-16, 18-25
  [[960, 1230], [1260, 1560]], // 16-20.5, 21-26
  [[690, 1020], [1080, 1440]], // 11.5-17, 18-24
  [[960, 1080], [1110, 1620]], // 16-18, 18.5-27
  [[1080, 1560]], // PM only 18-26
  [[600, 960]], // AM only 10-16
];
const A_LEGEND = [
  { fill: '#ffff00', label: 'Holiday' },
  { fill: '#c0c0c0', label: 'Unpaid' },
  { fill: '#00b0f0', label: 'PH' },
  { fill: '#ff66cc', label: 'Sick' },
  { fill: '#2e7d32', label: 'Request' },
  { fill: '#92d050', label: 'Day off' },
  { fill: '#ff0000', label: 'Closing' },
  { fill: '#ffc000', label: 'Terrace' },
  { fill: '#f4b183', label: 'Garden Bar' },
];
const A_LEAVE_FILLS = A_LEGEND.slice(0, 6);
const A_SHIFT_FILLS = A_LEGEND.slice(6);

const B_SHIFTS: [number, number][][] = [
  [[960, 1560]], // 4pm-2am
  [[780, 1380]], // 1pm-11pm
  [[600, 900], [1140, 1440]], // 10am-3pm, 7pm-12am
  [[630, 960], [1200, 1440]], // 10:30-16:00, 20:00-00:00
  [[1110, 1500]], // 18:30-01:00
  [[660, 1140]], // 11am-7pm
];
const B_OPEN = ['4CL', '12CL', '2CL', '10IN', 'IN'];

const A_SECTIONS = ['SUPERVISORS', 'HEAD WAITERS', 'WAITERS', 'RUNNERS', 'BARTENDERS', 'HOSTS'];
const B_GROUPS: { banner: string | null; titles: string[]; abbr: string[] }[] = [
  { banner: null, titles: ['RM', 'AM', 'JAM', 'Supervisor'], abbr: ['RM', 'AM', 'JAM', 'Sup'] },
  { banner: '', titles: ['Head waiter'], abbr: ['HW'] },
  { banner: 'WAITER', titles: ['Waiter'], abbr: ['Wtr'] },
  { banner: 'RUNNER', titles: ['Chef de pass', 'Runner'], abbr: ['CDP', 'Rnr'] },
  { banner: 'BAR', titles: ['Bartender'], abbr: ['Btdr'] },
  { banner: 'HOST', titles: ['Hostess'], abbr: ['Hst'] },
];

/** Made-up names with ff / fi / fl / ffi (ligature glyphs in many fonts). */
const LIGATURE_NAMES = ['Saffiya Okonkwo', 'Griffin Oduya', 'Fiifi Asante', 'Tiffany Moffat', 'Wilfrid Kofler', 'Flavia Duffy', 'Effie Laflamme', 'Joffrey Fielding'];

/** Department-style groups: one-word banners, position titles and abbreviations. */
const B_DEPARTMENTS: { banner: string | null; titles: string[]; abbr: string[] }[] = [
  { banner: 'MANAGEMENT', titles: ['GM', 'AGM', 'HOD', 'Ops Manager'], abbr: ['GM', 'AGM', 'HOD', 'Ops Manager'] },
  { banner: 'BAR', titles: ['Senior Bartender', 'Bartender'], abbr: ['Senior Bartender', 'Bartender'] },
  { banner: 'HOSTS', titles: ['Host'], abbr: ['Host'] },
  { banner: 'FLOOR', titles: ['Senior Server', 'Server'], abbr: ['Senior Server', 'Server'] },
  { banner: 'RUNNERS', titles: ['Runner'], abbr: ['Runner'] },
];

/** Area-style groups: banners naming parts of the venue, some no vocabulary knows ("POOL DECK"). */
const B_AREAS: { banner: string | null; titles: string[]; abbr: string[] }[] = [
  { banner: 'MANAGEMENT', titles: ['Outlet Manager', 'AGM'], abbr: ['Outlet Manager', 'AGM'] },
  { banner: 'TERRACE', titles: ['Captain', 'Server'], abbr: ['Captain', 'Server'] },
  { banner: 'POOL DECK', titles: ['Server', 'Runner'], abbr: ['Server', 'Runner'] },
  { banner: 'LOUNGE', titles: ['Bartender', 'Host'], abbr: ['Bartender', 'Host'] },
];

const VENUES = ['Le Petit Comptoir', 'Casa Lumiere', 'The Copper Fig', 'Saffron Terrace', 'Maison Verte'];

/** Splits `n` people into group sizes, first group small (management). */
function groupSizes(r: () => number, n: number, groups: number): number[] {
  const sizes = Array(groups).fill(0) as number[];
  sizes[0] = Math.min(n, 3 + Math.floor(r() * 2));
  let left = n - sizes[0]!;
  for (let g = 1; g < groups && left > 0; g++) {
    const share = g === groups - 1 ? left : Math.max(1, Math.round(left / (groups - g) + (r() - 0.5) * 2));
    sizes[g] = Math.min(left, share);
    left -= sizes[g]!;
  }
  return sizes.filter((s) => s > 0);
}

export function buildRoster(spec: VariantSpec): SemanticRoster {
  const r = rng(spec.seed);
  const dates = weekDates(spec.weekStart);
  const venue = pick(r, VENUES);
  const names = makeNames(r, spec.people, spec.upperNames);
  if (spec.ligatures) LIGATURE_NAMES.forEach((n, i) => i * 2 < names.length && (names[i * 2] = spec.upperNames ? n.toUpperCase() : n));
  const people: RosterPerson[] = [];
  const pageBreakAt = spec.pages > 1 ? Math.ceil(spec.people * 0.55) : Infinity;

  if (spec.family === 'A') {
    const groupCount = spec.people >= 35 ? 7 : 5;
    let sections: (string | null)[] = [null, ...A_SECTIONS.slice(0, groupCount - 1)];
    if (spec.reverseSections) sections = [null, ...sections.slice(1).reverse()];
    const sizes = groupSizes(r, spec.people, sections.length);
    let i = 0;
    sizes.forEach((size, g) => {
      for (let k = 0; k < size; k++, i++) {
        const blankWeek = r() < 0.15;
        const cells: CellTruth[] = [];
        const shiftFills: (string | null)[] = [];
        for (let d = 0; d < 7; d++) {
          if (blankWeek) {
            cells.push(r() < 0.85 ? { kind: 'colour', meaning: pick(r, A_LEAVE_FILLS).label } : { kind: 'blank' });
            shiftFills.push(null);
          } else if (r() < 0.62) {
            cells.push({ kind: 'shift', segs: pick(r, A_DAYS) });
            shiftFills.push(r() < 0.25 ? pick(r, A_SHIFT_FILLS).fill : null);
          } else {
            cells.push(r() < 0.9 ? { kind: 'colour', meaning: pick(r, A_LEAVE_FILLS).label } : { kind: 'blank' });
            shiftFills.push(null);
          }
        }
        people.push({ name: names[i]!, title: null, section: sections[g]!, page: i < pageBreakAt ? 1 : 2, group: g, cells, shiftFills });
      }
    });
    return {
      spec,
      venue,
      dates,
      title: titleLine(spec, venue, dates),
      people,
      legend: A_LEGEND,
      covers: { [Math.floor(r() * 7)]: `Party - ${10 + Math.floor(r() * 30)}pax`, [4]: `Rest - ${8 + Math.floor(r() * 10)} pax` },
      events: {},
    };
  }

  const groups = spec.areas ? B_AREAS : spec.departments ? B_DEPARTMENTS : spec.people >= 35 ? B_GROUPS : B_GROUPS.slice(0, 4);
  const ordered = spec.reverseSections ? [groups[0]!, ...groups.slice(1).reverse()] : groups;
  const sizes = groupSizes(r, spec.people, ordered.length);
  let i = 0;
  sizes.forEach((size, g) => {
    const group = ordered[g]!;
    const titles = spec.abbreviations ? group.abbr : group.titles;
    for (let k = 0; k < size; k++, i++) {
      let title: string;
      if (g === 0 || spec.departments || spec.areas) title = titles[Math.min(k, titles.length - 1)]!;
      else if (titles.length > 1 && k === 0) title = titles[0]!;
      else title = `${titles[titles.length - 1]} ${titles.length > 1 ? k : k + 1}`;
      const allLeave = r() < 0.12;
      const cells: CellTruth[] = [];
      for (let d = 0; d < 7; d++) {
        const x = r();
        if (allLeave) cells.push({ kind: 'leave', code: 'UL' });
        else if (x < 0.45) cells.push({ kind: 'shift', segs: pick(r, B_SHIFTS) });
        else if (x < 0.68) cells.push({ kind: 'leave', code: 'OFF' });
        else if (x < 0.84) cells.push({ kind: 'leave', code: pick(r, ['UL', 'UL', 'AL', 'SL', 'PH']) });
        else if (x < 0.92) cells.push({ kind: 'open', text: pick(r, B_OPEN) });
        else if (x < 0.97) cells.push({ kind: 'blank' });
        else cells.push({ kind: 'unreadable' });
      }
      people.push({ name: names[i]!, title, section: group.banner || null, page: i < pageBreakAt ? 1 : 2, group: g, cells, shiftFills: [] });
    }
  });
  return {
    spec,
    venue,
    dates,
    title: titleLine(spec, venue, dates),
    people,
    legend: [],
    covers: {},
    events: { 6: 'SUNDAY LUNCH', [Math.floor(r() * 5)]: 'Private dinner 40pax' },
  };
}

/** The truth for scoring, straight from the semantic roster. */
export function familyTruth(roster: SemanticRoster, file: string, printedRows: { row: number; cells: string[]; fills?: (string | null)[] }[]): FamilyTruth {
  const { spec, dates } = roster;
  const truth: FamilyTruth = {
    id: spec.id,
    family: spec.family,
    format: spec.format,
    file,
    tags: spec.tags,
    week: { weekStart: spec.weekStart, dates },
    printed: { title: roster.title, dayLabels: dates.map((iso, d) => dayHeaderLines(spec, iso, d).join(' ')) },
    pageCount: spec.format === 'xlsx' || spec.format === 'csv' ? 1 : spec.pages,
    people: [],
    shifts: [],
    leave: [],
    flagged: [],
  };
  roster.people.forEach((p, i) => {
    const role = p.title ?? p.section ?? '';
    truth.people.push({ name: p.name, role, section: p.section, page: truth.pageCount === 1 ? 1 : p.page, row: printedRows[i]!.row, cells: printedRows[i]!.cells, ...(printedRows[i]!.fills?.some(Boolean) ? { fills: printedRows[i]!.fills } : {}) });
    p.cells.forEach((cell, d) => {
      const date = dates[d]!;
      if (cell.kind === 'shift') for (const [s, e] of cell.segs) truth.shifts.push({ name: p.name, role, date, start: hhmm(s), end: hhmm(e) });
      else if (cell.kind === 'leave') truth.leave.push({ name: p.name, date, code: cell.code });
      else if (cell.kind === 'open') truth.flagged.push({ name: p.name, date });
    });
  });
  return truth;
}

// --- the variants ----------------------------------------------------------------------------

const AUG17 = '2026-08-17';
const AUG24 = '2026-08-24';
const APR13 = '2026-04-13';
const APR20 = '2026-04-20';

const base = (family: Family): Omit<VariantSpec, 'id' | 'format' | 'tags' | 'seed'> => ({
  family,
  weekStart: family === 'A' ? AUG17 : APR13,
  people: family === 'A' ? 22 : 20,
  header: 'date-above-weekday',
  notation: family === 'A' ? 'decimal' : 'text12',
  pages: 1,
  repeatHeader: false,
  shuffleText: false,
  rotateWeekdays: false,
  footer: false,
  nameFirst: false,
  reverseSections: false,
  upperNames: false,
  abbreviations: false,
});

type V = Partial<VariantSpec> & Pick<VariantSpec, 'id' | 'format' | 'tags'>;
const A = (v: V, seed: number): VariantSpec => ({ ...base('A'), ...v, seed });
const B = (v: V, seed: number): VariantSpec => ({ ...base('B'), ...v, seed });

export const FAMILY_VARIANTS: VariantSpec[] = [
  A({ id: 'A01-classic-pdf', format: 'pdf-text', tags: ['as exported', 'date row above weekday row', 'decimal hours'] }, 101),
  A({ id: 'A02-weekday-above-date', format: 'pdf-text', header: 'weekday-above-date', tags: ['weekday row above date row'] }, 102),
  A({ id: 'A03-long-date-header', format: 'pdf-text', header: 'weekday-long-date', tags: ['"MONDAY 17 AUGUST" header'] }, 103),
  A({ id: 'A04-two-pages-repeated-header', format: 'pdf-text', people: 46, pages: 2, repeatHeader: true, tags: ['46 people', '2 pages', 'header repeated'] }, 104),
  A({ id: 'A05-two-pages-header-once', format: 'pdf-text', people: 44, pages: 2, tags: ['44 people', '2 pages', 'header on page 1 only'] }, 105),
  A({ id: 'A06-colon-cells', format: 'pdf-text', notation: 'colon-cells', tags: ['24h colon sub-cells'] }, 106),
  A({ id: 'A07-scrambled-text-rotated', format: 'pdf-text', shuffleText: true, rotateWeekdays: true, tags: ['text layer out of order', 'rotated weekday headers'] }, 107),
  A({ id: 'A08-xlsx-merged', format: 'xlsx', tags: ['xlsx', 'merged day headers and banners', 'four sub-columns per day'] }, 108),
  A({ id: 'A09-csv', format: 'csv', tags: ['csv', 'merges lost'] }, 109),
  A({ id: 'A10-png', format: 'png', tags: ['photo/screenshot', 'colour-coded'] }, 110),
  A({ id: 'A11-scan-two-pages', format: 'pdf-image', people: 42, pages: 2, repeatHeader: true, tags: ['image-only PDF', '2 pages', '42 people'] }, 111),
  A({ id: 'A12-weekday-only-title', format: 'pdf-text', header: 'weekday-only-title', tags: ['weekday-only header', 'title "Rota 17 - 23 Aug"'] }, 112),
  A({ id: 'A13-month-day-footer', format: 'pdf-text', header: 'month-day', footer: true, tags: ['"Aug 17" header', 'footer'] }, 113),
  A({ id: 'A14-ordinal-reordered-caps', format: 'pdf-text', header: 'ordinal', reverseSections: true, upperNames: true, tags: ['"17th Aug" header', 'sections reordered', 'names in capitals'] }, 114),
  A({ id: 'A15-second-week-xlsx', format: 'xlsx', weekStart: AUG24, header: 'weekday-only-title', tags: ['second roster, next week', 'weekday-only + title', 'xlsx'] }, 115),
  A({ id: 'A16-second-week-pdf', format: 'pdf-text', weekStart: AUG24, tags: ['second roster, next week', 'same format as A01'] }, 116),
  A({ id: 'A17-weekday-slash', format: 'pdf-text', header: 'weekday-date-slash', tags: ['"Mon 17/08" header'] }, 117),
  A({ id: 'A18-png-second-week', format: 'png', weekStart: AUG24, header: 'weekday-day-title', tags: ['photo', '"Mon 24" header + "Week of 24th August" title'] }, 118),

  B({ id: 'B01-scan', format: 'pdf-image', tags: ['image-only PDF', 'as seen'] }, 201),
  B({ id: 'B02-png', format: 'png', tags: ['photo/screenshot'] }, 202),
  B({ id: 'B03-text-pdf', format: 'pdf-text', tags: ['text-layer PDF'] }, 203),
  B({ id: 'B04-xlsx-merged', format: 'xlsx', tags: ['xlsx', 'merged title and banners'] }, 204),
  B({ id: 'B05-csv', format: 'csv', tags: ['csv'] }, 205),
  B({ id: 'B06-name-first', format: 'pdf-text', nameFirst: true, tags: ['name column before title column'] }, 206),
  B({ id: 'B07-24h', format: 'pdf-text', notation: 'colon24', tags: ['24h "16:00-02:00"'] }, 207),
  B({ id: 'B08-dot-separators', format: 'pdf-text', notation: 'dot24', tags: ['dot separators "18.30-01.00"'] }, 208),
  B({ id: 'B09-two-pages-text', format: 'pdf-text', people: 44, pages: 2, repeatHeader: true, tags: ['44 people', '2 pages'] }, 209),
  B({ id: 'B10-scan-two-pages', format: 'pdf-image', people: 42, pages: 2, tags: ['image-only PDF', '2 pages, header once'] }, 210),
  B({ id: 'B11-weekday-slash', format: 'pdf-text', header: 'weekday-date-slash', tags: ['"Mon 13/04" one-row header'] }, 211),
  B({ id: 'B12-weekday-only-title', format: 'pdf-text', header: 'weekday-only-title', tags: ['weekday-only header', 'title "Rota 13 - 19 Apr"'] }, 212),
  B({ id: 'B13-ordinal-xlsx-footer', format: 'xlsx', header: 'ordinal', footer: true, tags: ['"13th Apr" header', 'footer', 'xlsx'] }, 213),
  B({ id: 'B14-month-day-png-mixed12', format: 'png', header: 'month-day', notation: 'mixed12', tags: ['"Apr 13" header', '"4 PM - 2 AM" style', 'photo'] }, 214),
  B({ id: 'B15-scrambled-reordered', format: 'pdf-text', shuffleText: true, reverseSections: true, tags: ['text layer out of order', 'sections reordered'] }, 215),
  B({ id: 'B16-abbreviations', format: 'pdf-text', abbreviations: true, header: 'weekday-long-date', tags: ['title abbreviations', '"MONDAY 13 APRIL" header'] }, 216),
  B({ id: 'B17-second-week-scan', format: 'pdf-image', weekStart: APR20, tags: ['second roster, next week', 'image-only PDF'] }, 217),
  B({ id: 'B18-weekday-above-date-caps', format: 'pdf-text', header: 'weekday-above-date', upperNames: true, notation: 'mixed12', tags: ['weekday row above date row', 'names in capitals', 'mixed 12h'] }, 218),

  // Round 2: one variant per structural failure found by the holdout grade.
  A({ id: 'A19-totals-footer-pdf', format: 'pdf-text', totalsFooter: true, footer: true, tags: ['"Total staff on rota" line with per-day counts', 'printed-by footer'] }, 119),
  A({ id: 'A20-scan-coloured-shifts', format: 'pdf-image', tags: ['image-only PDF', 'coloured cells that hold times', 'PM-only days'] }, 120),
  A({ id: 'A21-png-coloured-shifts', format: 'png', weekStart: AUG24, tags: ['photo', 'coloured cells that hold times', 'PM-only days', 'second week'] }, 121),
  B({ id: 'B19-name-first-headed', format: 'pdf-text', nameFirst: true, leadHeaders: true, tags: ['name column before title column', 'NAME / TITLE header labels'] }, 219),
  B({ id: 'B20-ligatures-totals', format: 'pdf-text', ligatures: true, totalsFooter: true, tags: ['ff / fi / fl split in the text layer', '"Total staff on rota" line'] }, 220),
  B({ id: 'B21-name-first-headed-xlsx', format: 'xlsx', nameFirst: true, leadHeaders: true, tags: ['name column before title column', 'NAME / TITLE header labels', 'xlsx'] }, 221),
  B({ id: 'B22-png-last-row', format: 'png', people: 16, tags: ['photo', 'last row at the page edge'] }, 222),

  // Round 3: new forms of the same failure classes (a fresh holdout found them).
  B({ id: 'B23-staffname-position-tight', format: 'pdf-text', lead: ['name', 'title'], leadLabels: { name: 'STAFF NAME', title: 'POSITION' }, tightLead: true, footerLines: ['Rota issued 10/04/2026 by Operations', 'Signature: ____________'], tags: ['name column right before a position column, tight', 'STAFF NAME / POSITION headings', 'issued-by and signature lines'] }, 223),
  B({ id: 'B24-labels-own-row', format: 'pdf-text', lead: ['no', 'name', 'title'], leadLabels: { no: '#', name: 'EMPLOYEE', title: 'ROLE' }, labelsRow: true, tightLead: true, footerLines: ['Generated by RotaPlanner 3.2 - confidential'], tags: ['# / EMPLOYEE / ROLE on a row of their own', 'index column', 'generated-by footer'] }, 224),
  B({ id: 'B25-no-name-position-xlsx', format: 'xlsx', lead: ['no', 'name', 'title'], leadLabels: { no: 'No.', name: 'NAME', title: 'POSITION' }, departments: true, bannerInName: true, tags: ['No. / NAME / POSITION', 'one-word banners in the name column', 'AGM / HOD / Senior Server titles'] }, 225),
  B({ id: 'B26-position-no-name-csv', format: 'csv', lead: ['title', 'no', 'name'], leadLabels: { title: 'Position', no: 'S/N', name: 'Staff' }, departments: true, bannerInName: true, footerLines: ['Total on duty this week 21'], tags: ['Position / S/N / Staff order', 'one-word banners', 'csv'] }, 226),
  B({ id: 'B27-faint-scan', format: 'pdf-image', faintNames: true, weekStart: APR20, tags: ['image-only PDF', 'a name the two readings spell differently'] }, 227),
  B({ id: 'B28-area-banners-name-id-designation-xlsx', format: 'xlsx', lead: ['name', 'no', 'title'], leadLabels: { name: 'Employee Full Name', no: 'Emp ID', title: 'Designation' }, areas: true, bannerInName: true, footerLines: ['Approved: Outlet Manager'], tags: ['Employee Full Name / Emp ID / Designation', 'area banners, one no vocabulary knows (POOL DECK)', 'xlsx'] }, 228),
  B({ id: 'B29-title-first-tight-unlabelled-pdf', format: 'pdf-text', lead: ['title', 'name'], tightLead: true, footerLines: ['Any changes must be agreed with the duty manager'], tags: ['title column right before the name, tight, no headings', 'free-text footer'] }, 229),
  A({ id: 'A22-dense-photo', format: 'png', people: 42, hardToRead: true, tags: ['42-person photo', 'many PM-only and half days', 'the two readings disagree on many cells'] }, 122),
  A({ id: 'A23-angled-scan-half-days', format: 'pdf-image', hardToRead: true, weekStart: AUG24, tags: ['scan', 'half days', 'the two readings disagree on many cells'] }, 123),
];

export const FILE_EXT: Record<OutputFormat, string> = { 'pdf-text': 'pdf', 'pdf-image': 'pdf', png: 'png', xlsx: 'xlsx', csv: 'csv' };
