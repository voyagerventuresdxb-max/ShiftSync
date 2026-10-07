import type {
  AddedPerson,
  ConfirmPersonDecision,
  ConfirmRosterRequest,
  ConfirmResponse,
  PersonPreview,
  PreviewRow,
  RosterRowEdit,
  UnreadRow,
  UploadResponse,
  WeekDetection,
} from '../../api/schedules';

/**
 * The roster review's logic, shared by the onboarding Review step and the Scheduling page
 * import (RosterReview.tsx renders it). Pure and CSS-free so `node --test` can load it.
 *
 * The unit is the PERSON, not the row: the server sends `people` (one per person on the
 * roster); an older server that doesn't is handled by grouping the preview rows here.
 */

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(utc(value).getTime()) && utc(value).toISOString().slice(0, 10) === value;
}

export function addDays(iso: string, days: number): string {
  return new Date(utc(iso).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function mondayOf(iso: string): string {
  const day = utc(iso).getUTCDay();
  return addDays(iso, day === 0 ? -6 : 1 - day);
}

/** "Mon 24 Aug 2026". */
export function formatDay(iso: string, withYear = true): string {
  const d = utc(iso);
  const base = `${DAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
  return withYear ? `${base} ${d.getUTCFullYear()}` : base;
}

/** "Week of Mon 24 Aug 2026". */
export function formatWeekLabel(weekStart: string): string {
  return `Week of ${formatDay(weekStart)}`;
}

/** The same normalization the server's nameKey uses, for grouping when the server sent no people. */
export function clientNameKey(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The roster's people: the server's, or (older server) the preview rows grouped by person. */
export function reviewPeople(upload: Pick<UploadResponse, 'people' | 'preview'>): PersonPreview[] {
  if (upload.people) return upload.people;
  const groups = new Map<string, PreviewRow[]>();
  for (const row of upload.preview) {
    const key =
      row.personKey ?? (row.sourceRowIndex !== undefined ? `row:${row.sourceRowIndex}` : `name:${clientNameKey(row.employeeName) || `#${row.rowNumber}`}`);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([personKey, rows]) => {
    const first = rows[0]!;
    return {
      personKey,
      name: first.employeeName.trim() || `(unnamed row ${first.rowNumber})`,
      normalizedName: clientNameKey(first.employeeName),
      roleLabel: first.role || null,
      resolvedRoleId: null,
      section: first.section ?? null,
      status: rows.every((r) => r.status === 'matched') ? 'matched' : 'new',
      matchedUserId: null,
      flags: rows.some((r) => r.status === 'unmatched_role') ? [{ kind: 'role_unresolved' }] : [],
      shiftCount: rows.length,
      rowNumbers: rows.map((r) => r.rowNumber),
      sourceRows: [],
    };
  });
}

/** The week the shifts are dated in: the server's detection, or the Monday of the earliest row. */
export function reviewWeek(upload: Pick<UploadResponse, 'week' | 'preview'>): WeekDetection | null {
  if (upload.week) return upload.week;
  const dates = upload.preview.map((r) => r.date).filter(isIsoDate).sort();
  if (dates.length === 0) return null;
  const weekStart = mondayOf(dates[0]!);
  return { weekStart, weekEnd: addDays(weekStart, 6), source: 'printed_dates', printedLabel: null, needsConfirmation: false, reason: null };
}

export function unreadRowsOf(upload: Pick<UploadResponse, 'unreadRows'>): UnreadRow[] {
  return upload.unreadRows ?? [];
}

/** "Found 12 people · 2 rows couldn't be read". */
export function headerLine(peopleCount: number, unreadCount: number): string {
  const people = `Found ${peopleCount} ${peopleCount === 1 ? 'person' : 'people'}`;
  if (unreadCount === 0) return people;
  return `${people} · ${unreadCount} ${unreadCount === 1 ? "row couldn't" : "rows couldn't"} be read`;
}

/** What the manager has decided for one person on the review screen. */
export interface PersonChoice {
  action: 'create' | 'link' | 'skip';
  /** With 'link'. */
  userId: string | null;
  /** With 'create': the name the new staff member gets. */
  name: string;
  /** Assigned on the review screen (one person or in bulk); null = keep what the roster said. */
  roleName: string | null;
  /** A close name ("same person as …?") the manager hasn't answered yet: blocks Confirm. */
  undecided?: boolean;
}

/**
 * The preselection: the server's suggestion, else an exact match links and everyone else is
 * new. A close name is never preselected either way: it stays undecided until answered.
 */
export function initialChoice(person: PersonPreview): PersonChoice {
  const userId = person.suggestedAction ? (person.suggestedAction === 'link' ? (person.suggestedUserId ?? null) : null) : person.matchedUserId;
  const undecided = !userId && person.flags.some((f) => f.kind === 'possible_match');
  return { action: userId ? 'link' : 'create', userId, name: person.name, roleName: null, ...(undecided ? { undecided: true } : {}) };
}

/** personKey -> every personKey sharing its name (listed twice / in two sections). */
export function duplicateGroups(people: PersonPreview[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const person of people) {
    const flag = person.flags.find((f) => f.kind === 'duplicate_name');
    if (flag && flag.kind === 'duplicate_name') groups.set(person.personKey, flag.personKeys);
  }
  return groups;
}

export interface PersonNote {
  key: string;
  /** 'check': the manager should look; 'info': context only. */
  tone: 'check' | 'info';
  text: string;
}

function shiftLabel(row: PreviewRow): string {
  return `${formatDay(row.date, false)} ${row.startTime}–${row.endTime}`;
}

/** The person's flags and their shifts' flags, in plain words. Questions (same person? which time?) are separate. */
export function personNotes(person: PersonPreview, rows: PreviewRow[]): PersonNote[] {
  const notes: PersonNote[] = [];
  for (const flag of person.flags) {
    if (flag.kind === 'ai_only') notes.push({ key: 'ai_only', tone: 'check', text: 'Found by the AI reader only — check it' });
    if (flag.kind === 'table_only') notes.push({ key: 'table_only', tone: 'info', text: 'Found by the table reader only' });
    if (flag.kind === 'two_sections') notes.push({ key: 'two_sections', tone: 'check', text: `Listed in two sections: ${flag.sections.join(' and ')}` });
    if (flag.kind === 'name_differs') {
      notes.push({ key: 'name_differs', tone: 'check', text: `The name was read two ways: ${flag.spellings.map((s) => `“${s}”`).join(' or ')} — check the spelling` });
    }
    if (flag.kind === 'duplicate_name' && !person.flags.some((f) => f.kind === 'two_sections')) {
      notes.push({ key: 'duplicate_name', tone: 'check', text: flag.personKeys.length > 2 ? `Listed ${flag.personKeys.length} times` : 'Listed twice' });
    }
  }
  for (const row of rows) {
    const flags = row.flags ?? [];
    if (flags.includes('ai_only') && !person.flags.some((f) => f.kind === 'ai_only')) {
      notes.push({ key: `row-ai-${row.rowNumber}`, tone: 'check', text: `${shiftLabel(row)}: found by the AI reader only — check it` });
    }
    if (flags.includes('table_only') && !person.flags.some((f) => f.kind === 'table_only')) {
      notes.push({ key: `row-table-${row.rowNumber}`, tone: 'info', text: `${shiftLabel(row)}: found by the table reader only` });
    }
    if (flags.includes('low_confidence')) notes.push({ key: `row-low-${row.rowNumber}`, tone: 'check', text: `${shiftLabel(row)}: the reader wasn't sure — check it` });
  }
  return notes;
}

/** "Possibly the same person as Maria Lopez — same person?" (null when there is no such question). */
export function possibleMatchQuestion(person: PersonPreview): { text: string; candidates: { userId: string; fullName: string }[] } | null {
  const flag = person.flags.find((f) => f.kind === 'possible_match');
  if (!flag || flag.kind !== 'possible_match' || flag.candidates.length === 0) return null;
  const names = flag.candidates.map((c) => c.fullName);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return { text: `Possibly the same person as ${who} — same person?`, candidates: flag.candidates };
}

export interface TimeOption {
  startTime: string;
  endTime: string;
  overnight: boolean;
  label: string;
}

export interface TimeQuestion {
  rowNumber: number;
  text: string;
  options: TimeOption[];
}

/** One question per shift whose two readers read different times: "Times differ: 18:00–02:00 or 18:30–02:00?" */
export function timeQuestions(rows: PreviewRow[]): TimeQuestion[] {
  return rows.flatMap((row) => {
    if (!row.flags?.includes('times_differ') || !row.alternatives?.length) return [];
    const seen = new Map<string, TimeOption>();
    for (const alt of [{ startTime: row.startTime, endTime: row.endTime, overnight: row.overnight }, ...row.alternatives]) {
      const label = `${alt.startTime}–${alt.endTime}`;
      if (!seen.has(label)) seen.set(label, { startTime: alt.startTime, endTime: alt.endTime, overnight: alt.overnight, label });
    }
    const options = [...seen.values()];
    if (options.length < 2) return [];
    return [{ rowNumber: row.rowNumber, text: `${formatDay(row.date, false)} — times differ: ${options.map((o) => o.label).join(' or ')}?`, options }];
  });
}

/** The person's shifts, compact: "Mon–Sat · 5 shifts". */
export function shiftSummary(rows: PreviewRow[]): string {
  if (rows.length === 0) return 'No shifts this week';
  const dates = [...new Set(rows.map((r) => r.date))].filter(isIsoDate).sort();
  const count = `${rows.length} ${rows.length === 1 ? 'shift' : 'shifts'}`;
  if (dates.length === 0) return count;
  const first = DAY_SHORT[utc(dates[0]!).getUTCDay()];
  const last = DAY_SHORT[utc(dates[dates.length - 1]!).getUTCDay()];
  return `${dates.length === 1 || first === last ? first : `${first}–${last}`} · ${count}`;
}

/** Everything the manager can change on the review screen. Serializable (sessionStorage). */
export interface ReviewState {
  choices: Record<string, PersonChoice>;
  /** Entries of a duplicate group the manager marked "Two people". */
  separate: string[];
  weekStart: string | null;
  weekConfirmed: boolean;
  added: AddedPerson[];
  /** rowNumber -> index into that row's TimeQuestion options. */
  timePicks: Record<number, number>;
  rememberRoles: boolean;
}

export function initialReviewState(people: PersonPreview[], week: WeekDetection | null): ReviewState {
  return {
    choices: Object.fromEntries(people.map((p) => [p.personKey, initialChoice(p)])),
    separate: [],
    weekStart: week?.weekStart ?? null,
    weekConfirmed: !week?.needsConfirmation,
    added: [],
    timePicks: {},
    rememberRoles: true,
  };
}

/** Reasons the Confirm button is disabled, in plain words (empty = ready). */
export function reviewBlockers(people: PersonPreview[], week: WeekDetection | null, state: ReviewState, extra: { anomaliesOutstanding?: number } = {}): string[] {
  const blockers: string[] = [];
  if (week?.needsConfirmation && !state.weekConfirmed) blockers.push('Confirm the week first');
  const unanswered = people.filter((p) => state.choices[p.personKey]?.undecided && state.choices[p.personKey]?.action !== 'skip').length;
  if (unanswered > 0) blockers.push(`Answer “same person?” for ${unanswered} ${unanswered === 1 ? 'person' : 'people'}`);
  const groups = duplicateGroups(people);
  const nameOf = (key: string) => {
    const choice = state.choices[key];
    const person = people.find((p) => p.personKey === key);
    return clientNameKey(choice?.action === 'create' ? choice.name : (person?.name ?? ''));
  };
  for (const key of state.separate) {
    const group = groups.get(key) ?? [];
    const mine = nameOf(key);
    if (group.some((other) => other !== key && state.choices[other]?.action !== 'skip' && nameOf(other) === mine)) {
      const person = people.find((p) => p.personKey === key);
      blockers.push(`Give the other "${person?.name ?? ''}" a different name`);
    }
  }
  if (people.some((p) => state.choices[p.personKey]?.action === 'create' && !state.choices[p.personKey]!.name.trim())) blockers.push('Every new person needs a name');
  if ((extra.anomaliesOutstanding ?? 0) > 0) {
    const n = extra.anomaliesOutstanding!;
    blockers.push(`${n} unclear ${n === 1 ? 'cell' : 'cells'} to look at first`);
  }
  if (people.length === 0 && state.added.length === 0) blockers.push('Nobody to import yet — add someone below, or upload another file');
  else if (people.every((p) => state.choices[p.personKey]?.action === 'skip') && state.added.length === 0) blockers.push('Nothing to import — everyone is skipped');
  return [...new Set(blockers)];
}

/** The confirm request for the current review state. */
export function buildConfirmRequest(
  people: PersonPreview[],
  rows: PreviewRow[],
  state: ReviewState,
  options: { createdById?: string | null } = {},
): ConfirmRosterRequest {
  const decisions: ConfirmPersonDecision[] = people.map((person) => {
    const choice = state.choices[person.personKey] ?? initialChoice(person);
    const role = choice.roleName?.trim() ? { roleName: choice.roleName.trim() } : {};
    if (choice.action === 'skip') return { personKey: person.personKey, action: 'skip' };
    if (choice.action === 'link' && choice.userId) return { personKey: person.personKey, action: 'link', userId: choice.userId, ...role };
    return { personKey: person.personKey, action: 'create', name: choice.name.trim() || person.name, ...role };
  });
  const edits: RosterRowEdit[] = [];
  for (const question of timeQuestions(rows)) {
    const pick = state.timePicks[question.rowNumber];
    if (pick === undefined || pick === 0) continue; // option 0 is what the row already says
    const option = question.options[pick];
    if (option) edits.push({ rowNumber: question.rowNumber, startTime: option.startTime, endTime: option.endTime, overnight: option.overnight });
  }
  return {
    createdById: options.createdById ?? null,
    ...(state.weekStart ? { weekStart: state.weekStart } : {}),
    people: decisions,
    ...(state.added.length > 0 ? { addedPeople: state.added } : {}),
    rememberRoleMappings: state.rememberRoles,
    ...(edits.length > 0 ? { edits } : {}),
  };
}

/** The post-confirm summary lines. */
export function importResultLines(result: Pick<ConfirmResponse, 'createdPeople' | 'linkedPeople' | 'skippedPeople' | 'createdShifts' | 'skippedDuplicates' | 'overlaps'>): string[] {
  const lines = [
    `${result.createdPeople} new ${result.createdPeople === 1 ? 'person' : 'people'} added to your staff`,
    `${result.linkedPeople} matched to people already on your staff`,
    `${result.createdShifts} ${result.createdShifts === 1 ? 'shift' : 'shifts'} added`,
  ];
  if (result.skippedDuplicates > 0) lines.push(`${result.skippedDuplicates} ${result.skippedDuplicates === 1 ? 'shift was' : 'shifts were'} already on the rota — not added twice`);
  if (result.overlaps.length > 0) lines.push(`${result.overlaps.length} ${result.overlaps.length === 1 ? 'shift overlaps' : 'shifts overlap'} one already on the rota — not added`);
  if (result.skippedPeople > 0) lines.push(`${result.skippedPeople} ${result.skippedPeople === 1 ? 'person' : 'people'} not imported, as you chose`);
  return lines;
}
