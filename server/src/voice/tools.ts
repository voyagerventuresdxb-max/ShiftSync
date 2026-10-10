import type { SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { formatVenueTime } from '../lib/venueTime.js';
import { isRealDate } from '../lib/shiftRules.js';
import {
  DECLINED_CATEGORIES,
  TOOL_ARG_NAMES,
  type ChoosableIntent,
  type DeclinedCategory,
  type DeclinedIntent,
  type ParsedIntent,
  type ToolArgName,
  type Unrecognized,
} from './intentSchema.js';
import { MAX_PEOPLE_CHOICES, normalizeName, resolvePerson, type PersonResolution, type StaffEntry } from './people.js';
import { periodSaid, resolveTerm, type Term } from './vocabulary.js';
import { parseSpokenTime, readOneTime, readShiftTimes, type ShiftTimes, type TimesReading } from './times.js';
import { coverage, mySchedule, pendingRequests, recentAnnouncements, whoInSection, whoIsOff, whoIsWorking } from './reads.js';
import type { VenueContext } from './context.js';
import { shiftRangesOf } from '../lib/actions/weekActions.js';
import { shiftTypeFor, typeTimes } from './shiftTiming.js';

/**
 * The model's answer under the tool contract: one tool and the arguments as heard (names, never
 * ids). This file turns it into the same ParsedIntent shapes the confirm sheet and /execute have
 * always used, by looking every name up in the caller's OWN venue: people (people.ts), sections
 * and roles (vocabulary.ts), shifts (person + day + optional time), swap requests (requester
 * and/or day), applicants (name among pending join requests) and templates (name). Anything
 * missing is asked for; anything matching more than one thing becomes a "which one?" choice;
 * nothing is guessed.
 */
export type ToolArgs = Partial<Record<Exclude<ToolArgName, 'unassign'>, string>> & { unassign?: boolean };
export interface ToolCall {
  tool: string;
  args: ToolArgs;
  confidence: number;
  summary: string;
}
export type Reading = ChoosableIntent;
export type Resolved =
  | { kind: 'reading'; reading: Reading }
  | { kind: 'choices'; readings: Reading[]; summary: string }
  | { kind: 'final'; intent: ParsedIntent };

export interface ToolCaller {
  id: string;
  systemRole: SystemRole;
  locationId: string;
}

/** A model reading's tool, arguments and confidence, narrowed; anything not a string is "not said". */
export function normalizeToolCall(raw: Record<string, unknown>): ToolCall | null {
  if (typeof raw.tool !== 'string' || raw.tool === 'UNRECOGNIZED') return null;
  const src = raw.args && typeof raw.args === 'object' ? (raw.args as Record<string, unknown>) : {};
  const args: ToolArgs = {};
  for (const key of TOOL_ARG_NAMES) {
    const v = src[key];
    if (key === 'unassign') {
      if (v === true) args.unassign = true;
    } else if (typeof v === 'string' && v.trim()) {
      args[key] = v.trim();
    }
  }
  if (args.period && args.period !== 'AM' && args.period !== 'PM') delete args.period;
  if (args.availability && args.availability !== 'UNAVAILABLE' && args.availability !== 'PREFERRED_OFF') delete args.availability;
  // A missing/non-numeric/out-of-range confidence fails CLOSED to 0: never "the model was certain".
  const c = raw.confidence;
  const confidence = typeof c === 'number' && c >= 0 && c <= 1 ? c : 0;
  return { tool: raw.tool, args, confidence, summary: typeof raw.summary === 'string' ? raw.summary : '' };
}

const clarify = (reason: string, summary: string): Unrecognized => ({ intent: 'UNRECOGNIZED', reason, summary });
const AGAIN = 'Say it again, or fix what I heard and try again.';
export const NOT_FOUND = (what: string) => clarify(AGAIN, `I couldn't find that ${what} at your venue.`);
const final = (intent: ParsedIntent): Resolved => ({ kind: 'final', intent });
const one = (reading: Reading): Resolved => ({ kind: 'reading', reading });
const MAX_CHOICES = 3;
const MAX_TIME_OFF_DAYS = 14;

/** "Sat 10 Oct" for a YYYY-MM-DD venue day. */
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/** The Monday of the week holding `iso`. */
export function mondayOf(iso: string): string {
  const dow = new Date(`${iso}T00:00:00.000Z`).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
}
const day = (v: string | undefined) => (v && isRealDate(v) ? v : undefined);

// ---------------------------------------------------------------------------
// Asking for what's missing
// ---------------------------------------------------------------------------

/** The field names `incomplete.missing` has always used, per argument. */
const FIELD: Record<string, string> = { day: 'date', role: 'roleId', section: 'sectionId', week: 'weekStart', template: 'templateName', message: 'content', availability: 'availabilityType' };
const ASK: Record<string, string> = {
  date: 'which day',
  shiftDate: 'which day',
  availabilityType: 'are you unavailable, or would you just prefer it off',
  roleId: 'which role',
  start: 'what time does it start',
  end: 'what time does it end',
  sectionId: 'which section',
  period: 'morning or evening',
  weekStart: 'which week',
  templateName: 'which template',
  content: 'what should it say',
  change: 'what should change',
  'second part': 'when the second part starts and ends',
};
const ASK_PERSON: Record<string, string> = { REQUEST_SWAP: 'who should cover it', ASSIGN_SECTION: 'who', POST_SHOUTOUT: 'who is it for' };
const WHAT: Record<string, string> = {
  MARK_AVAILABILITY: 'time off for you',
  REQUEST_TIME_OFF: 'a time-off request',
  REQUEST_SWAP: 'a swap request',
  CREATE_SHIFT: 'a new shift',
  EDIT_SHIFT: 'a shift change',
  CANCEL_SHIFT: 'a shift to cancel',
  ASSIGN_SECTION: 'a section move',
  PUBLISH_ROTA: 'the rota to publish',
  APPLY_ROTA_TEMPLATE: 'a rota template',
  POST_ANNOUNCEMENT: 'an announcement',
  POST_SHOUTOUT: 'a shout-out',
  WHO_IN_SECTION: 'a question about a section',
};

function joinAsks(asks: string[]): string {
  return asks.length < 2 ? (asks[0] ?? '') : `${asks.slice(0, -1).join(', ')}, and ${asks[asks.length - 1]}`;
}

/**
 * A recognised command missing something it needs: say what was understood and ask for exactly
 * what is missing. `missing` uses argument names; the question names the old field names so the
 * log and the sheet read as before.
 */
function askFor(tool: string, missing: string[], call: ToolCall, ctx: VenueContext, caller: ToolCaller, transcript: string): Unrecognized {
  const fields = missing.map((m) => (m === 'day' && tool === 'ASSIGN_SECTION' ? 'shiftDate' : (FIELD[m] ?? m)));
  const asks: string[] = [];
  const a = call.args;
  // Who it's about is still looked up: nobody by that name is said so; a shared name joins the question.
  let who = heardPerson(a);
  let personQuestion: Unrecognized['person'];
  if (who && PERSON_TOOLS.has(tool)) {
    const found = resolvePerson(who, null, staffEntries(ctx), transcript, caller.id);
    if (found.kind === 'missing') return missingPerson(found, caller, transcript, []);
    if (found.kind === 'one') who = found.person.fullName;
    if (found.kind === 'ambiguous') {
      personQuestion = { heard: found.heard, status: 'ambiguous' };
      asks.push(found.people.length <= MAX_PEOPLE_CHOICES ? `which ${found.heard} (${found.people.map((p) => p.fullName).join(' or ')})` : `which ${found.heard} (say their full name)`);
    }
  }
  asks.push(...fields.map((f) => (f === 'person' ? (ASK_PERSON[tool] ?? 'who') : (ASK[f] ?? `which ${f}`))));
  const bits = [
    a.role && tool === 'CREATE_SHIFT' ? ` ${a.role}` : '',
    who ? ` for ${who}` : '',
    a.section ? ` to ${a.section}` : '',
    day(a.day) ? ` on ${dayLabel(a.day!)}` : '',
    a.start && tool === 'CREATE_SHIFT' && !fields.includes('start') ? ` from ${a.start}` : '',
    a.end && tool === 'CREATE_SHIFT' && !fields.includes('end') ? ` until ${a.end}` : '',
    a.template ? ` (“${a.template}”)` : '',
    a.message && tool === 'POST_SHOUTOUT' ? ` saying “${a.message}”` : '',
  ].join('');
  return {
    intent: 'UNRECOGNIZED',
    summary: `I've got ${WHAT[tool] ?? 'that'}${bits} — ${joinAsks(asks)}?`,
    reason: 'Add it to what I heard and tap Try again, or say the whole thing again.',
    incomplete: { intent: tool, missing: fields },
    ...(personQuestion ? { person: personQuestion } : {}),
  };
}

/** Tools whose `person` is someone to look up on the team (not whose shift it is). */
const PERSON_TOOLS = new Set(['REQUEST_SWAP', 'POST_SHOUTOUT', 'ASSIGN_SECTION', 'CREATE_SHIFT']);

/** "Rana" appears in what the caller said (word for word, ignoring case and punctuation). */
function saidAloud(name: string, transcript: string): boolean {
  const n = normalizeName(name);
  return n.length > 0 && ` ${normalizeName(transcript)} `.includes(` ${n} `);
}

/** The transcript with the name as said swapped for a staff member's full name ("Give Alix…" → "Give Alex Morgan…"). */
function withName(transcript: string, heard: string, fullName: string): string {
  const escaped = heard.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return transcript.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu'), fullName);
}

/** "I couldn't find Rana on your team.", with any close names as choices and, for managers, where to add them. */
export function missingPerson(
  found: Extract<PersonResolution, { kind: 'missing' }>,
  caller: { systemRole: SystemRole },
  transcript: string,
  options: ChoosableIntent[],
): Unrecognized {
  const heard = saidAloud(found.heard, transcript) ? found.heard : '';
  const who = heard || 'that person';
  const canAddStaff = caller.systemRole !== 'STAFF';
  const addHint = canAddStaff ? `If ${heard || 'they'} ${heard ? 'is' : 'are'} new, add them in People first, then try again.` : 'Check the name and try again.';
  if (options.length) {
    const reason = `Did you mean ${options.length === 1 ? 'this person' : 'one of these'}? ${addHint}`;
    return { intent: 'UNRECOGNIZED', summary: `I couldn't find ${who} on your team.`, reason, person: { heard, status: 'missing' }, options };
  }
  // Close names, but no complete reading to offer (the command still lacks a part, e.g. the note):
  // name them, and offer the same words with the right name to read again.
  const near = found.near.map((p) => p.fullName);
  const reason = near.length ? `Did you mean ${near.join(' or ')}? ${addHint}` : addHint;
  const retry = heard ? near.map((person) => ({ person, text: withName(transcript, heard, person) })).filter((r) => r.text !== transcript) : [];
  return { intent: 'UNRECOGNIZED', summary: `I couldn't find ${who} on your team.`, reason, person: { heard, status: 'missing' }, ...(retry.length ? { retry } : {}) };
}

// ---------------------------------------------------------------------------
// Looking things up in the caller's venue
// ---------------------------------------------------------------------------

const staffEntries = (ctx: VenueContext): StaffEntry[] => ctx.staffDirectory;
const heardPerson = (a: ToolArgs) => a.personFull ?? a.person ?? '';

/** Venue shifts on one day (live, not cancelled), merged into the context so later checks see them. */
async function venueShiftsOn(ctx: VenueContext, caller: ToolCaller, iso: string) {
  const rows = await prisma.shift.findMany({
    where: { locationId: caller.locationId, date: new Date(`${iso}T00:00:00.000Z`), status: { not: 'CANCELLED' } },
    include: { role: { select: { name: true } }, assignee: { select: { fullName: true } } },
    orderBy: { startTime: 'asc' },
  });
  const shifts = rows.map((s) => ({
    id: s.id,
    roleName: s.role.name,
    roleId: s.roleId,
    date: iso,
    start: formatVenueTime(s.startTime, ctx.timezone),
    end: formatVenueTime(s.endTime, ctx.timezone),
    assigneeId: s.userId,
    assigneeName: s.assignee?.fullName ?? null,
    status: s.status,
    ranges: shiftRangesOf(s, ctx.timezone).ranges,
    shiftTypeId: s.shiftTypeId,
  }));
  const known = new Set((ctx.weekShifts ??= []).map((s) => s.id));
  for (const s of shifts) if (!known.has(s.id)) ctx.weekShifts.push(s);
  return shifts;
}

/** True when a time as said can be this HH:MM (either reading of a bare hour). */
function timeFits(heard: string | undefined, hhmm: string): boolean {
  if (!heard) return true;
  const t = parseSpokenTime(heard);
  if (!t) return true;
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  if (t.minute !== m) return false;
  if (t.meridiem) return (t.hour % 12) + (t.meridiem === 'pm' ? 12 : 0) === h;
  if (t.fixed) return t.hour === h;
  return t.hour % 12 === h % 12;
}

type ShiftRow = Awaited<ReturnType<typeof venueShiftsOn>>[number];
type ShiftLookup = { kind: 'shifts'; shifts: ShiftRow[]; heard?: string; ambiguous?: boolean } | { kind: 'final'; intent: ParsedIntent };

/** "Omar's Friday shift": the venue's shifts that day for the person named (or open ones), narrowed by a time if said. */
async function findShifts(call: ToolCall, ctx: VenueContext, caller: ToolCaller, transcript: string, at: string | undefined): Promise<ShiftLookup> {
  const iso = day(call.args.day)!;
  const shifts = await venueShiftsOn(ctx, caller, iso);
  const heard = heardPerson(call.args);
  let pool = shifts;
  let ambiguous = false;
  if (heard) {
    const found = resolvePerson(heard, null, staffEntries(ctx), transcript, caller.id);
    if (found.kind === 'one') pool = shifts.filter((s) => s.assigneeId === found.person.id);
    else if (found.kind === 'ambiguous') {
      ambiguous = true;
      const ids = new Set(found.people.map((p) => p.id));
      pool = shifts.filter((s) => s.assigneeId && ids.has(s.assigneeId));
    } else if (found.kind === 'missing') {
      const near = new Set(found.near.map((p) => p.id));
      pool = shifts.filter((s) => s.assigneeId && near.has(s.assigneeId));
      if (!pool.length) return { kind: 'final', intent: clarify(`Check the name and try again.`, `I couldn't find ${saidAloud(heard, transcript) ? heard : 'that person'} on your team.`) };
      ambiguous = true;
    }
  } else {
    const open = shifts.filter((s) => !s.assigneeId);
    pool = open.length ? open : shifts;
  }
  pool = pool.filter((s) => timeFits(at, s.start));
  if (!pool.length) {
    const who = heard && saidAloud(heard, transcript) ? `${heard}'s` : 'a';
    return { kind: 'final', intent: clarify(AGAIN, `I couldn't find ${who} shift on ${dayLabel(iso)}.`) };
  }
  return { kind: 'shifts', shifts: pool, heard, ambiguous };
}

/** "Which one?" for several shifts, or the one reading. */
function shiftChoice(readings: Reading[], lookup: { heard?: string; ambiguous?: boolean }): Resolved {
  if (readings.length === 1 && !lookup.ambiguous) return one(readings[0]!);
  return { kind: 'choices', readings: readings.slice(0, MAX_CHOICES + 1), summary: lookup.heard && lookup.ambiguous ? `Which ${lookup.heard} did you mean?` : 'Which shift did you mean?' };
}

function resolveRole(heard: string, ctx: VenueContext): { kind: 'ids'; ids: string[] } | { kind: 'none' } {
  const roles: Term[] = (ctx.roles ?? []).filter((r) => r.isActive !== false).map((r) => ({ id: r.id, label: r.name }));
  const found = resolveTerm(heard, roles);
  if (found.kind === 'one') return { kind: 'ids', ids: [found.item.id] };
  if (found.kind === 'choice') return { kind: 'ids', ids: found.items.map((i) => i.id) };
  return { kind: 'none' };
}

function resolveSection(heard: string, ctx: VenueContext): { kind: 'ids'; items: Term[] } | { kind: 'none' } {
  const found = resolveTerm(heard, ctx.floorSections ?? []);
  if (found.kind === 'one') return { kind: 'ids', items: [found.item] };
  if (found.kind === 'choice') return { kind: 'ids', items: found.items };
  return { kind: 'none' };
}

/** "Closing", "opening" and "double", from the venue's own templates and upcoming shifts; null when it has none. */
const PATTERN_WORD = /\b(closing|close|opening|double)\b/i;
function venuePattern(word: string, ctx: VenueContext, roleId: string | null): ShiftTimes[] | null {
  const fromTemplates = (ctx.rotaTemplates ?? []).flatMap((t) => (Array.isArray(t.entries) ? (t.entries as { roleId?: string; start?: string; end?: string }[]) : []));
  const all = [...fromTemplates.map((e) => ({ roleId: e.roleId ?? null, start: e.start ?? '', end: e.end ?? '' })), ...(ctx.weekShifts ?? []).map((s) => ({ roleId: s.roleId ?? null, start: s.start, end: s.end }))].filter(
    (p) => /^\d{2}:\d{2}$/.test(p.start) && /^\d{2}:\d{2}$/.test(p.end),
  );
  const pool = roleId && all.some((p) => p.roleId === roleId) ? all.filter((p) => p.roleId === roleId) : all;
  if (!pool.length) return null;
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const endOf = (p: ShiftTimes) => mins(p.end) + (p.end <= p.start ? 24 * 60 : 0);
  const mostCommon = (list: ShiftTimes[]) => {
    const counts = new Map<string, { p: ShiftTimes; n: number }>();
    for (const p of list) {
      const k = `${p.start}-${p.end}`;
      counts.set(k, { p, n: (counts.get(k)?.n ?? 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => b.n - a.n)[0]!.p;
  };
  const latest = Math.max(...pool.map(endOf));
  const earliest = Math.min(...pool.map((p) => mins(p.start)));
  const closing = mostCommon(pool.filter((p) => endOf(p) === latest));
  const opening = mostCommon(pool.filter((p) => mins(p.start) === earliest));
  const w = word.toLowerCase();
  if (w === 'double') {
    if (endOf(opening) > mins(closing.start) || opening.start === closing.start) return null;
    return [{ start: opening.start, end: opening.end }, { start: closing.start, end: closing.end }];
  }
  const p = w === 'opening' ? opening : closing;
  return [{ start: p.start, end: p.end }];
}

/** The new shift's times: as said, from a pattern word, or a question. */
type NewTimes = { kind: 'times'; options: { first: ShiftTimes; second?: ShiftTimes }[] } | { kind: 'missing'; fields: string[]; note?: string } | { kind: 'final'; intent: ParsedIntent };
function newShiftTimes(call: ToolCall, ctx: VenueContext, roleId: string | null, transcript: string): NewTimes {
  const a = call.args;
  const word = (s: string | undefined) => (s && PATTERN_WORD.test(s) ? s.match(PATTERN_WORD)![1]!.toLowerCase().replace(/^close$/, 'closing') : null);
  let start = a.start && !word(a.start) ? a.start : undefined;
  let end = a.end && !word(a.end) ? a.end : undefined;
  // "Closing", "until close", "opening", "a double": the venue's own times, never a guess.
  const said = word(a.start) ?? word(a.end) ?? (!a.start && !a.end ? word(transcript) : null);
  if (said) {
    const pattern = venuePattern(said, ctx, roleId);
    if (!pattern) return { kind: 'missing', fields: [...(start ? [] : ['start']), ...(end ? [] : ['end'])], note: `Your venue has no ${said} shift times saved yet` };
    if (said === 'double') {
      if (!start && !end) return { kind: 'times', options: [{ first: pattern[0]!, second: pattern[1] }] };
    } else {
      if (!start && !end) [start, end] = [pattern[0]!.start, pattern[0]!.end];
      else if (!end && word(a.end)) end = pattern[0]!.end;
      else if (!start && word(a.start)) start = pattern[0]!.start;
    }
  }
  const missing = [...(start ? [] : ['start']), ...(end ? [] : ['end'])];
  if (missing.length) return { kind: 'missing', fields: missing };
  const first = readShiftTimes(start, end, transcript);
  if (first.kind === 'none') return { kind: 'final', intent: clarify(AGAIN, `I didn't catch the times. Say them again, for example "6pm to 2am".`) };
  const firsts = first.kind === 'one' ? [first.times] : first.readings;
  if (!a.start2 && !a.end2) return { kind: 'times', options: firsts.map((f) => ({ first: f })) };
  // A split shift: the second part is later the same day than the first.
  // The second part's times are checked against what was said; a time-of-day word settles the first part only.
  const second = readShiftTimes(a.start2, a.end2, transcript, false);
  if (second.kind === 'none') return { kind: 'final', intent: clarify(AGAIN, `I didn't catch the second part of that split shift. Say both parts again, for example "11 to 3 and 6 to 11".`) };
  const seconds = second.kind === 'one' ? [second.times] : second.readings;
  const options: { first: ShiftTimes; second: ShiftTimes }[] = [];
  for (const f of firsts) for (const s of seconds) if (s.start >= f.end && f.end > f.start) options.push({ first: f, second: s });
  if (!options.length) return { kind: 'final', intent: clarify(AGAIN, `The two parts of that split shift overlap. Say the times again.`) };
  return { kind: 'times', options };
}

function missingOf(call: ToolCall, keys: string[]): string[] {
  return keys.filter((k) => (k === 'day' ? !day(call.args.day) : !call.args[k as ToolArgName]));
}

// ---------------------------------------------------------------------------
// Never by voice
// ---------------------------------------------------------------------------

const DECLINED_TEXT: Record<DeclinedCategory, { what: string; screen: { label: string; path: string } | null; staffScreen?: null }> = {
  people_deactivate_delete: { what: "Removing or deactivating someone isn't done by voice. Do it in People.", screen: { label: 'People', path: '/people' } },
  roles_permissions: { what: "Roles and permissions aren't changed by voice. Do it in People.", screen: { label: 'People', path: '/people' }, staffScreen: null },
  signin_phone: { what: "Sign-in phone numbers aren't changed by voice. Do it in People.", screen: { label: 'People', path: '/people' }, staffScreen: null },
  account_delete: { what: "Deleting an account isn't done by voice. You can delete your own account in Profile.", screen: { label: 'Profile', path: '/profile' } },
  kiosk_link: { what: "Kiosk links aren't managed by voice. Do it in People.", screen: { label: 'People', path: '/people' }, staffScreen: null },
  ai_settings: { what: "AI settings aren't changed by voice. Find them in Profile.", screen: { label: 'Profile', path: '/profile' } },
  payroll_wps: { what: "Payroll and WPS aren't handled by voice.", screen: null },
  floor_plan_pins: { what: "Floor-plan sections and pins aren't edited by voice. Do it on the Floor plan.", screen: { label: 'Floor plan', path: '/floor-plan' } },
  other_settings: { what: "Settings aren't changed by voice. Find them in Profile.", screen: { label: 'Profile', path: '/profile' } },
};

export function declined(category: string | undefined, systemRole: SystemRole, confidence: number): DeclinedIntent {
  const c = (DECLINED_CATEGORIES as readonly string[]).includes(category ?? '') ? (category as DeclinedCategory) : 'other_settings';
  const text = DECLINED_TEXT[c];
  const staffOnly = systemRole === 'STAFF' && text.staffScreen === null;
  const message = staffOnly ? `${text.what.replace(/ Do it in People\.$/, '')} Ask your manager.` : text.what;
  return { intent: 'DECLINED', category: c, message, screen: staffOnly ? null : text.screen, confidence, summary: message };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/**
 * One tool call → a reading with this venue's ids (still to be checked by parseIntent.ts
 * `checkAgainstContext`), several readings to choose from, or a final answer (a read, a decline,
 * a question).
 */
export async function resolveToolCall(call: ToolCall, ctx: VenueContext, caller: ToolCaller, transcript: string): Promise<Resolved> {
  const a = call.args;
  const { confidence, summary } = call;
  const base = { confidence, summary };
  const person = heardPerson(a);
  switch (call.tool) {
    case 'DECLINED':
      return final(declined(a.category, caller.systemRole, confidence));
    case 'WHO_IS_WORKING':
      return final(await whoIsWorking(caller, ctx, { day: day(a.day), period: (a.period as 'AM' | 'PM' | undefined) ?? periodSaid(transcript) }, confidence));
    case 'WHO_IS_OFF':
      return final(await whoIsOff(caller, ctx, { day: day(a.day) }, confidence));
    case 'COVERAGE':
      // "Are we short on bar Saturday?": the model may file "bar" as a section; a department is meant.
      return final(await coverage(caller, ctx, { day: day(a.day), department: a.department ?? a.section ?? null }, confidence));
    case 'QUERY_MY_SCHEDULE':
      return final(await mySchedule(caller, ctx, { day: day(a.day), week: day(a.week) }, confidence));
    case 'PENDING_REQUESTS':
      return final(await pendingRequests(caller, ctx, confidence));
    case 'RECENT_ANNOUNCEMENTS':
      return final(await recentAnnouncements(caller, ctx, confidence));
    case 'WHO_IN_SECTION': {
      if (!a.section) return final(askFor(call.tool, ['section'], call, ctx, caller, transcript));
      const found = resolveSection(a.section, ctx);
      if (found.kind === 'none') return final(NOT_FOUND('section'));
      if (found.items.length > 1) return final(clarify(AGAIN, `Which section: ${found.items.map((i) => i.label).join(' or ')}?`));
      return final(await whoInSection(caller, ctx, { section: found.items[0]!, day: day(a.day), period: (a.period as 'AM' | 'PM' | undefined) ?? periodSaid(transcript) }, confidence));
    }

    case 'MARK_AVAILABILITY': {
      const missing = missingOf(call, ['day', 'availability']);
      if (missing.length) return final(askFor(call.tool, missing, call, ctx, caller, transcript));
      return one({ intent: 'MARK_AVAILABILITY', date: a.day!, type: a.availability as 'UNAVAILABLE' | 'PREFERRED_OFF', ...base });
    }
    case 'REQUEST_TIME_OFF': {
      if (!day(a.day)) return final(askFor(call.tool, ['day'], call, ctx, caller, transcript));
      const startDate = a.day!;
      const endDate = day(a.endDay) ?? startDate;
      if (endDate < startDate) return final(clarify(AGAIN, `The last day comes before the first. Which days do you need off?`));
      if (daysBetween(startDate, endDate) + 1 > MAX_TIME_OFF_DAYS) {
        return final(clarify(`Ask for up to ${MAX_TIME_OFF_DAYS} days at a time, or talk to your manager.`, `That's more than ${MAX_TIME_OFF_DAYS} days off in one go.`));
      }
      return one({ intent: 'REQUEST_TIME_OFF', startDate, endDate, reason: a.reason ?? null, ...base });
    }
    case 'REQUEST_SWAP': {
      const missing = [...(person ? [] : ['person']), ...missingOf(call, ['day'])];
      if (missing.length) return final(askFor(call.tool, missing, call, ctx, caller, transcript));
      let own = ctx.callerShifts.filter((s) => s.date === a.day);
      if (!own.length) {
        const rows = await prisma.shift.findMany({ where: { userId: caller.id, locationId: caller.locationId, date: new Date(`${a.day}T00:00:00.000Z`), status: { not: 'CANCELLED' } } });
        own = rows.map((s) => ({ id: s.id, date: a.day!, startTime: formatVenueTime(s.startTime, ctx.timezone), endTime: formatVenueTime(s.endTime, ctx.timezone) }));
        ctx.callerShifts.push(...own);
      }
      own = own.filter((s) => timeFits(a.start, s.startTime));
      if (!own.length) return final(clarify(AGAIN, `I couldn't find a shift of yours on ${dayLabel(a.day!)}.`));
      const readings = own.map((s): Reading => ({ intent: 'REQUEST_SWAP', shiftId: s.id, targetUserId: '', targetUserName: person, reason: a.reason ?? null, ...base }));
      return readings.length === 1 ? one(readings[0]!) : { kind: 'choices', readings, summary: 'Which of your shifts?' };
    }
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP': {
      let pool = ctx.pendingSwapRequests ?? [];
      const requester = a.requester ?? a.person;
      let ambiguous = false;
      if (requester) {
        const people = [...new Map(pool.map((r) => [r.requesterId ?? r.requesterName, { id: r.requesterId ?? r.requesterName, fullName: r.requesterName }])).values()];
        const found = resolvePerson(requester, null, people, transcript, caller.id);
        const ids = new Set(found.kind === 'one' ? [found.person.id] : found.kind === 'ambiguous' ? found.people.map((p) => p.id) : found.kind === 'missing' ? found.near.map((p) => p.id) : []);
        ambiguous = found.kind !== 'one';
        pool = pool.filter((r) => ids.has(r.requesterId ?? r.requesterName));
      }
      if (day(a.day)) pool = pool.filter((r) => r.shift?.date === a.day);
      if (!pool.length) return final(NOT_FOUND('pending swap request'));
      const readings = pool.map((r): Reading => ({ intent: call.tool as 'APPROVE_SWAP', swapRequestId: r.id, ...base }));
      if (readings.length === 1 && !ambiguous) return one(readings[0]!);
      return { kind: 'choices', readings: readings.slice(0, MAX_CHOICES), summary: 'Which swap request did you mean?' };
    }
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN': {
      let pool = ctx.pendingJoinRequests ?? [];
      const applicant = a.applicant ?? a.person;
      let ambiguous = false;
      if (applicant) {
        const found = resolvePerson(applicant, null, pool, transcript, caller.id);
        const ids = new Set(found.kind === 'one' ? [found.person.id] : found.kind === 'ambiguous' ? found.people.map((p) => p.id) : found.kind === 'missing' ? found.near.map((p) => p.id) : []);
        ambiguous = found.kind !== 'one';
        pool = pool.filter((r) => ids.has(r.id));
      }
      if (!pool.length) return final(NOT_FOUND('pending join request'));
      const readings = pool.map((r): Reading => ({ intent: call.tool as 'APPROVE_JOIN', joinRequestId: r.id, ...base }));
      if (readings.length === 1 && !ambiguous) return one(readings[0]!);
      return { kind: 'choices', readings: readings.slice(0, MAX_CHOICES), summary: 'Whose request did you mean?' };
    }

    case 'CREATE_SHIFT': {
      // The role said, or else the person's own role at the venue (shown on the confirm sheet).
      let roleIds: string[] = [];
      if (a.role) {
        const found = resolveRole(a.role, ctx);
        if (found.kind === 'none') return final(clarify(AGAIN, `I couldn't find a ${a.role} role at your venue.`));
        roleIds = found.ids;
      } else if (person) {
        const p = resolvePerson(person, null, staffEntries(ctx), transcript, caller.id);
        const own = p.kind === 'one' ? ctx.staffDirectory.find((s) => s.id === p.person.id)?.roleId : null;
        if (own && (ctx.roles ?? []).some((r) => r.id === own && r.isActive !== false)) roleIds = [own];
      }
      const typed = shiftTypeFor(call, ctx, transcript, true);
      if (typed.kind === 'final') return typed;
      if (typed.kind === 'types') {
        const missingParts = [...missingOf(call, ['day']), ...(roleIds.length ? [] : ['role'])];
        if (missingParts.length) return final(askFor(call.tool, missingParts, call, ctx, caller, transcript));
        const readings: Reading[] = [];
        for (const roleId of roleIds) {
          for (const t of typed.types) {
            readings.push({ intent: 'CREATE_SHIFT', roleId, date: a.day!, ...typeTimes(t), shiftTypeId: t.id, userId: null, ...(person ? { targetUserName: person } : {}), ...base });
          }
        }
        if (readings.length === 1) return one(readings[0]!);
        return { kind: 'choices', readings: readings.slice(0, MAX_CHOICES + 1), summary: roleIds.length > 1 ? 'Which role did you mean?' : 'Which shift did you mean?' };
      }
      const times = newShiftTimes(call, ctx, roleIds.length === 1 ? roleIds[0]! : null, transcript);
      const missing = [...missingOf(call, ['day']), ...(times.kind === 'missing' ? times.fields : []), ...(roleIds.length ? [] : ['role'])];
      if (missing.length) {
        const ask = askFor(call.tool, missing, call, ctx, caller, transcript);
        return final(times.kind === 'missing' && times.note && ask.incomplete ? { ...ask, summary: `${times.note} — ${joinAsks(missing.map((m) => ASK[FIELD[m] ?? m] ?? m))}?` } : ask);
      }
      if (times.kind !== 'times') return times as Resolved;
      const readings: Reading[] = [];
      for (const roleId of roleIds) {
        for (const t of times.options) {
          readings.push({
            intent: 'CREATE_SHIFT',
            roleId,
            date: a.day!,
            start: t.first.start,
            end: t.first.end,
            ...(t.second ? { second: t.second } : {}),
            userId: null,
            ...(person ? { targetUserName: person } : {}),
            ...base,
          });
        }
      }
      if (readings.length === 1) return one(readings[0]!);
      return { kind: 'choices', readings: readings.slice(0, MAX_CHOICES + 1), summary: roleIds.length > 1 ? 'Which role did you mean?' : 'Which times did you mean?' };
    }

    case 'EDIT_SHIFT':
    case 'CANCEL_SHIFT': {
      if (!day(a.day)) return final(askFor(call.tool, ['day'], call, ctx, caller, transcript));
      const isEdit = call.tool === 'EDIT_SHIFT';
      const lookup = await findShifts(call, ctx, caller, transcript, isEdit ? a.at : (a.at ?? a.start));
      if (lookup.kind === 'final') return lookup;
      if (!isEdit) return shiftChoice(lookup.shifts.map((s): Reading => ({ intent: 'CANCEL_SHIFT', shiftId: s.id, ...base })), lookup);

      const changes = a.start || a.end || a.start2 || a.end2 || a.shiftType || day(a.newDay) || a.role || a.newPerson || a.unassign;
      if (!changes) return final(askFor(call.tool, ['change'], call, ctx, caller, transcript));
      let roleIds: (string | undefined)[] = [undefined];
      if (a.role) {
        const found = resolveRole(a.role, ctx);
        if (found.kind === 'none') return final(clarify(AGAIN, `I couldn't find a ${a.role} role at your venue.`));
        roleIds = found.ids;
      }
      const who = a.unassign ? { userId: null } : a.newPerson ? { userId: null, targetUserName: a.newPerson } : {};
      const moved = day(a.newDay) ? { date: a.newDay } : {};
      // "Make Priya's Friday a split" / "put her on evening instead": the venue type's own times.
      const typed = shiftTypeFor(call, ctx, transcript, false);
      if (typed.kind === 'final') return typed;
      if (typed.kind === 'types') {
        const readings: Reading[] = [];
        for (const s of lookup.shifts) {
          for (const roleId of roleIds) {
            for (const t of typed.types) {
              const times = typeTimes(t);
              // A split becoming a one-range type says so (`second: null`), so the second range goes.
              const second = times.second ?? ((s.ranges?.length ?? 1) > 1 ? null : undefined);
              readings.push({
                intent: 'EDIT_SHIFT',
                shiftId: s.id,
                ...(roleId ? { roleId } : {}),
                ...moved,
                start: times.start,
                end: times.end,
                ...(second !== undefined ? { second } : {}),
                shiftTypeId: t.id,
                ...who,
                ...base,
              });
            }
          }
        }
        return shiftChoice(readings, lookup);
      }
      // A split said with times: both parts, read like a new split shift's.
      if (a.start2 || a.end2) {
        if (!a.start || !a.end || !a.start2 || !a.end2) return final(askFor(call.tool, ['start', 'end'].filter((k) => !a[k as 'start' | 'end']).concat(a.start2 && a.end2 ? [] : ['second part']), call, ctx, caller, transcript));
        const times = newShiftTimes(call, ctx, null, transcript);
        if (times.kind === 'final') return times;
        if (times.kind !== 'times') return final(askFor(call.tool, times.fields, call, ctx, caller, transcript));
        const readings: Reading[] = [];
        for (const s of lookup.shifts) {
          for (const roleId of roleIds) {
            for (const t of times.options) {
              readings.push({ intent: 'EDIT_SHIFT', shiftId: s.id, ...(roleId ? { roleId } : {}), ...moved, start: t.first.start, end: t.first.end, ...(t.second ? { second: t.second } : {}), ...who, ...base });
            }
          }
        }
        return shiftChoice(readings, lookup);
      }
      const readings: Reading[] = [];
      for (const s of lookup.shifts) {
        let times: TimesReading = { kind: 'one', times: { start: s.start, end: s.end } };
        if (a.start && a.end) times = readShiftTimes(a.start, a.end, transcript);
        else if (a.start) times = readOneTime(a.start, 'start', s.end, transcript);
        else if (a.end) times = readOneTime(a.end, 'end', s.start, transcript);
        if (times.kind === 'none') return final(clarify(AGAIN, `I didn't catch the new time. Say it again, for example "to start at 7pm".`));
        const options = times.kind === 'one' ? [times.times] : times.readings;
        for (const roleId of roleIds) {
          for (const t of options) {
            readings.push({
              intent: 'EDIT_SHIFT',
              shiftId: s.id,
              ...(roleId ? { roleId } : {}),
              ...moved,
              ...(a.start ? { start: t.start } : {}),
              ...(a.end ? { end: t.end } : {}),
              ...who,
              ...base,
            });
          }
        }
      }
      return shiftChoice(readings, lookup);
    }

    case 'ASSIGN_SECTION': {
      const period = (a.period as 'AM' | 'PM' | undefined) ?? periodSaid(transcript) ?? undefined;
      const missing = [...(person ? [] : ['person']), ...missingOf(call, ['section', 'day']), ...(period ? [] : ['period'])];
      if (missing.length) return final(askFor(call.tool, missing, call, ctx, caller, transcript));
      const found = resolveSection(a.section!, ctx);
      if (found.kind === 'none') return final(NOT_FOUND('section'));
      const readings = found.items.map((sec): Reading => ({ intent: 'ASSIGN_SECTION', sectionId: sec.id, staffId: '', shiftDate: a.day!, period: period!, dutyLabel: a.duty ?? null, targetUserName: person, ...base }));
      return readings.length === 1 ? one(readings[0]!) : { kind: 'choices', readings, summary: 'Which section did you mean?' };
    }
    case 'PUBLISH_ROTA': {
      if (!day(a.week)) return final(askFor(call.tool, ['week'], call, ctx, caller, transcript));
      return one({ intent: 'PUBLISH_ROTA', weekStart: mondayOf(a.week!), ...base });
    }
    case 'APPLY_ROTA_TEMPLATE': {
      const missing = missingOf(call, ['template', 'week']);
      if (missing.length) return final(askFor(call.tool, missing, call, ctx, caller, transcript));
      return one({ intent: 'APPLY_ROTA_TEMPLATE', templateId: null, templateName: a.template!, weekStart: mondayOf(a.week!), ...base });
    }
    case 'POST_ANNOUNCEMENT': {
      if (!a.message) return final(askFor(call.tool, ['message'], call, ctx, caller, transcript));
      return one({ intent: 'POST_ANNOUNCEMENT', content: a.message, ...base });
    }
    case 'POST_SHOUTOUT': {
      const missing = [...(person ? [] : ['person']), ...missingOf(call, ['message'])];
      if (missing.length) return final(askFor(call.tool, missing, call, ctx, caller, transcript));
      return one({ intent: 'POST_SHOUTOUT', targetUserId: '', targetUserName: person, content: a.message!, ...base });
    }
    default:
      return final(clarify("Try again with who, what and when — for example \"Mark me unavailable on Friday\".", "I didn't catch what you'd like to do."));
  }
}

