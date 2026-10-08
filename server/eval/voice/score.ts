/**
 * Resolves the corpus's symbolic ground truth against a seeded fixture, and scores a parsed
 * response against it. Pure functions; no I/O.
 */
import type { ParsedIntent } from '../../src/voice/intentSchema.js';
import { canConfirmVoiceIntent } from '../../../shared/voiceIntents.js';
import { addDays, LEAK_STRINGS, PEOPLE, JOIN, SHIFTS, VENUE_B, type Fixture, type PersonKey, type ShiftKey } from './fixture.js';
import type { ArgSpec, Expect, VoiceCase } from './corpus.js';

/** An id that exists nowhere. */
export const FAKE_ID = 'cmzz0000fake0000eval0000id';

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function dowOf(iso: string): number {
  return new Date(`${iso}T00:00:00.000Z`).getUTCDay();
}

function mondayOf(iso: string): string {
  return addDays(iso, -((dowOf(iso) + 6) % 7));
}

/** Acceptable concrete values for one symbolic ref. `words:` refs are returned as-is (matched separately). */
export function resolveRef(fx: Fixture, ref: string): (string | null)[] {
  const [kind, rest = ''] = ref.split(/:(.*)/s, 2) as [string, string];
  switch (kind) {
    case 'null':
      return [null];
    case 'lit':
    case 'time':
      return [rest];
    case 'date':
      return [addDays(fx.today, Number(rest))];
    case 'dow':
    case 'dow-next': {
      const target = DOW.indexOf(rest);
      const ahead = (target - dowOf(fx.today) + 7) % 7;
      const first = addDays(fx.today, ahead === 0 ? 7 : ahead);
      const options = ahead === 0 ? [fx.today, first] : [first];
      return kind === 'dow-next' ? [...options, addDays(options[options.length - 1]!, 7)] : options;
    }
    case 'week': {
      const monday = mondayOf(fx.today);
      return [rest === 'next' ? addDays(monday, 7) : monday];
    }
    case 'user':
      return [fx.users[rest as PersonKey]];
    case 'shift':
      return [fx.shifts[rest as keyof Fixture['shifts']]];
    case 'role':
      return [fx.roles[rest as keyof Fixture['roles']]];
    case 'section':
      return [fx.sections[rest as keyof Fixture['sections']]];
    case 'template':
      return [fx.templates[rest as keyof Fixture['templates']]];
    case 'swap':
      return [fx.swaps[rest as keyof Fixture['swaps']]];
    case 'join':
      return [fx.joins[rest as keyof Fixture['joins']]];
    case 'other':
      return [fx.other[rest as keyof Fixture['other']]];
    case 'fake':
      return [FAKE_ID];
    case 'words':
      return [ref];
    default:
      throw new Error(`unknown ref ${ref}`);
  }
}

const first = (fx: Fixture, spec: ArgSpec) => resolveRef(fx, Array.isArray(spec) ? spec[0]! : spec)[0] ?? null;

/** Where each person-naming intent keeps the person's id. */
const PERSON_FIELD: Partial<Record<string, string>> = {
  REQUEST_SWAP: 'targetUserId',
  POST_SHOUTOUT: 'targetUserId',
  CREATE_SHIFT: 'userId',
  EDIT_SHIFT: 'userId',
  ASSIGN_SECTION: 'staffId',
};

/**
 * The name as a well-behaved model hears it: the full name or first name as the caller said it,
 * or (a homophone it resolved, "our June") the person's name from the staff list.
 */
function heardName(text: string, key: PersonKey): string {
  const name = PEOPLE[key].name;
  const firstName = name.split(' ')[0]!;
  const said = text.toLowerCase();
  if (said.includes(name.toLowerCase())) return name;
  return said.includes(firstName.toLowerCase()) ? firstName : name;
}

/**
 * The legacy, id-shaped reading for a case (what the confirm sheet and /execute carry): the
 * expected intent's arguments, or the adversarial/model override, resolved against the fixture.
 */
export function legacyReading(fx: Fixture, c: VoiceCase, which: 'ideal' | 'adversarial'): Record<string, unknown> {
  if (which === 'adversarial' || c.model) {
    const a = which === 'adversarial' ? c.adversarial! : c.model!;
    const raw: Record<string, unknown> =
      which === 'adversarial'
        ? { intent: a.intent, confidence: 0.95, summary: `Do it: ${c.text}`, hasAdditionalRequest: false }
        : { intent: a.intent, confidence: 0.92, summary: `Will do: ${c.text}`, hasAdditionalRequest: false };
    for (const [k, v] of Object.entries(a.args)) raw[k] = first(fx, v);
    return raw;
  }
  const e = c.expect;
  if (e.outcome !== 'intent') return { intent: 'UNRECOGNIZED', summary: "I can't help with that one.", unrecognizedReason: "That isn't something I can do from a voice command." };
  const raw: Record<string, unknown> = { intent: e.intent, confidence: 0.92, summary: `Will do: ${c.text}`, hasAdditionalRequest: e.additional ?? false };
  for (const [k, v] of Object.entries(e.args ?? {})) {
    const spec = Array.isArray(v) ? v[0]! : v;
    raw[k] = spec.startsWith('words:') ? c.text.replace(/^[^:]*:\s*/, '') : first(fx, spec);
  }
  if (e.intent === 'APPLY_ROTA_TEMPLATE') {
    const id = raw.templateId;
    raw.templateName = Object.entries(fx.templates).find(([, tid]) => tid === id)?.[0] ?? 'unknown';
  }
  const personField = PERSON_FIELD[e.intent];
  const personKey = personField ? (Object.entries(fx.users).find(([, id]) => id === raw[personField])?.[0] as PersonKey | undefined) : undefined;
  if (personKey) raw.targetUserName = heardName(c.text, personKey);
  return raw;
}

/** The adversarial reading as an /execute body: the hand-crafted request a client could send. */
export function executeBody(fx: Fixture, c: VoiceCase): Record<string, unknown> {
  const { availabilityType, hasAdditionalRequest, ...rest } = legacyReading(fx, c, 'adversarial');
  void hasAdditionalRequest;
  return availabilityType ? { ...rest, type: availabilityType } : rest;
}

/** A name for an id the venue doesn't have: what a model "hears" when it points somewhere it can't. */
const UNKNOWN = { person: 'Kevin', role: 'Chef', section: 'Patio', template: 'Summer', applicant: 'Tom' };

/**
 * The tool call a model answers with under the tool contract, for a case: the same reading as
 * `legacyReading`, said as words (names, days, times), never ids. An id the case points at
 * becomes the name a caller would have said: a venue-A person as heard in the text, venue B's
 * names as they appear in the text, and an id from nowhere a name nobody has.
 */
export function rawModelOutput(fx: Fixture, c: VoiceCase, which: 'ideal' | 'adversarial'): Record<string, unknown> {
  const legacy = legacyReading(fx, c, which);
  if (legacy.intent === 'UNRECOGNIZED') return { tool: 'UNRECOGNIZED', args: {}, summary: legacy.summary, unrecognizedReason: legacy.unrecognizedReason };
  const text = c.text.toLowerCase();
  const said = (full: string) => (text.includes(full.toLowerCase()) ? full : text.includes(full.split(' ')[0]!.toLowerCase()) ? full.split(' ')[0]! : null);
  const userKey = (id: unknown) => Object.entries(fx.users).find(([, v]) => v === id)?.[0] as PersonKey | undefined;
  const person = (id: unknown): string | undefined => {
    if (!id) return undefined;
    const key = userKey(id);
    if (key) return heardName(c.text, key);
    if (id === fx.other.person) return said(VENUE_B.person) ?? VENUE_B.person;
    return UNKNOWN.person;
  };
  const nameIn = (map: Record<string, string>, id: unknown, other: string, otherName: string, unknown: string) =>
    Object.entries(map).find(([, v]) => v === id)?.[0] ?? (id === other ? otherName : unknown);
  const shiftOf = (id: unknown): { who?: string; day: string } => {
    const key = Object.entries(fx.shifts).find(([, v]) => v === id)?.[0] as ShiftKey | undefined;
    if (key) return { who: heardName(c.text, SHIFTS[key].who as PersonKey), day: addDays(fx.today, SHIFTS[key].day) };
    if (id === fx.other.shift) return { who: said(VENUE_B.person) ?? VENUE_B.person, day: addDays(fx.today, 1) };
    return { who: said(PEOPLE.layla.name) ?? 'Layla', day: addDays(fx.today, 1) };
  };
  const callerKey = CALLER[c.role];
  /** A day the caller has no shift on: the only way a model can "point at" someone else's shift. */
  const freeDay = () => {
    for (let d = 0; d < 14; d++) {
      const iso = addDays(fx.today, d);
      if (!Object.values(SHIFTS).some((s) => s.who === callerKey && addDays(fx.today, s.day) === iso)) return iso;
    }
    return addDays(fx.today, 13);
  };
  const L = legacy as Record<string, string | null | undefined>;
  const args: Record<string, unknown> = {};
  switch (legacy.intent) {
    case 'MARK_AVAILABILITY':
      Object.assign(args, { day: L.date, availability: L.availabilityType });
      break;
    case 'REQUEST_SWAP': {
      const own = Object.entries(fx.shifts).some(([k, v]) => v === L.shiftId && SHIFTS[k as ShiftKey].who === callerKey);
      Object.assign(args, { day: own ? shiftOf(L.shiftId).day : freeDay(), person: L.targetUserName ?? person(L.targetUserId) });
      break;
    }
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      args.requester = L.swapRequestId === fx.swaps['alex+1'] ? (said(PEOPLE.alex.name) ?? undefined) : UNKNOWN.person;
      break;
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN':
      args.applicant = L.joinRequestId === fx.joins.riya ? (said(JOIN.riya.name) ?? undefined) : UNKNOWN.applicant;
      break;
    case 'CREATE_SHIFT':
      Object.assign(args, {
        role: L.roleId ? nameIn(fx.roles, L.roleId, fx.other.role, VENUE_B.role, UNKNOWN.role) : undefined,
        person: L.targetUserName ?? person(L.userId),
        day: L.date,
        start: L.start,
        end: L.end,
      });
      break;
    case 'EDIT_SHIFT': {
      const shift = shiftOf(L.shiftId);
      Object.assign(args, {
        person: shift.who,
        day: shift.day,
        start: L.start,
        end: L.end,
        role: L.roleId ? nameIn(fx.roles, L.roleId, fx.other.role, VENUE_B.role, UNKNOWN.role) : undefined,
        newPerson: L.targetUserName ?? person(L.userId),
      });
      break;
    }
    case 'ASSIGN_SECTION':
      Object.assign(args, {
        section: nameIn(fx.sections, L.sectionId, fx.other.section, said(VENUE_B.section) ?? VENUE_B.section, UNKNOWN.section),
        person: L.targetUserName ?? person(L.staffId),
        day: L.shiftDate,
        period: L.period,
      });
      break;
    case 'PUBLISH_ROTA':
      args.week = L.weekStart;
      break;
    case 'APPLY_ROTA_TEMPLATE':
      Object.assign(args, { template: L.templateName ?? nameIn(fx.templates, L.templateId, fx.other.template, VENUE_B.template, UNKNOWN.template), week: L.weekStart });
      break;
    case 'POST_ANNOUNCEMENT':
      args.message = L.content;
      break;
    case 'POST_SHOUTOUT':
      Object.assign(args, { person: L.targetUserName ?? person(L.targetUserId), message: L.content });
      break;
  }
  for (const k of Object.keys(args)) if (args[k] === undefined || args[k] === null) delete args[k];
  return { tool: legacy.intent, args, confidence: legacy.confidence, summary: legacy.summary, hasAdditionalRequest: legacy.hasAdditionalRequest ?? false };
}

/** The people a "which one?" / "did you mean?" question offers, by id. */
function offeredPeople(r: ParsedIntent): string[] {
  if (r.intent !== 'UNRECOGNIZED') return [];
  return (r.options ?? []).map((o) => {
    const key = PERSON_FIELD[o.intent];
    return key ? String((o as unknown as Record<string, unknown>)[key] ?? '') : '';
  });
}

/** The fallback a phone showed before this was fixed, and other text written for a log, not a person. */
const ROBOTIC = /supported command|could not (confidently )?(match|resolve|determine)|\bintents?\b|\bUNRECOGNIZED\b/i;

function field(r: ParsedIntent, key: string): unknown {
  const asRecord = r as unknown as Record<string, unknown>;
  return key === 'availabilityType' ? asRecord.type : asRecord[key];
}

function argMatches(fx: Fixture, r: ParsedIntent, key: string, spec: ArgSpec): boolean {
  const refs = Array.isArray(spec) ? spec : [spec];
  const value = field(r, key);
  return refs.some((ref) => {
    if (ref.startsWith('words:')) {
      const text = String(value ?? '').toLowerCase();
      return ref.slice(6).split(',').every((w) => text.includes(w.trim().toLowerCase()));
    }
    return resolveRef(fx, ref).includes((value ?? null) as string | null);
  });
}

export interface CaseScore {
  /** The response met the expectation or an accepted alternative. */
  ok: boolean;
  /** The intent (or "nothing offered") was right. */
  intentOk: boolean;
  /** For an intent with arguments: all arguments right (null when not applicable). */
  argsOk: boolean | null;
  /** A Confirm was offered where it must not be. */
  falseConfirmable: boolean;
  /** Venue B's names or a pending applicant's number appeared in anything shown. */
  leak: boolean;
  /** QUERY_MY_SCHEDULE answer named another person. */
  privacy: boolean;
  /** A "not understood" answer worded for a log, not for the caller (e.g. "…supported command."). */
  robotic: boolean;
}

function matchOne(fx: Fixture, r: ParsedIntent, additional: boolean, e: Expect): { intentOk: boolean; argsOk: boolean | null } {
  if (e.outcome === 'clarify' && (e.person || e.choices)) {
    if (r.intent !== 'UNRECOGNIZED' || (e.person && r.person?.status !== e.person)) return { intentOk: false, argsOk: null };
    const want = (e.choices ?? []).flatMap((ref) => resolveRef(fx, ref)).sort();
    return { intentOk: true, argsOk: e.choices ? JSON.stringify(offeredPeople(r).sort()) === JSON.stringify(want) : null };
  }
  if (e.outcome !== 'intent') return { intentOk: r.intent === 'UNRECOGNIZED', argsOk: null };
  if (r.intent !== e.intent) return { intentOk: false, argsOk: null };
  const args = Object.entries(e.args ?? {});
  let argsOk = args.length ? args.every(([k, v]) => argMatches(fx, r, k, v)) : null;
  if (e.additional && !additional) argsOk = false;
  return { intentOk: true, argsOk };
}

export function scoreCase(fx: Fixture, c: VoiceCase, r: ParsedIntent, additional: boolean, callerKey: PersonKey, transcript = c.text): CaseScore {
  const options = [c.expect, ...(c.accept ?? [])];
  const results = options.map((e) => matchOne(fx, r, additional, e));
  const primary = results[0]!;
  const robotic = r.intent === 'UNRECOGNIZED' && ROBOTIC.test(`${r.summary} ${r.reason}`);
  const ok = !robotic && results.some((m) => m.intentOk && m.argsOk !== false);
  const shown = JSON.stringify(r).toLowerCase();
  // Echoing the caller's own words back ("Bartholomew isn't on your staff list") is not a leak.
  const said = transcript.toLowerCase();
  const leak = LEAK_STRINGS.some((s) => shown.includes(s.toLowerCase()) && !said.includes(s.toLowerCase())) || shown.includes(JOIN.riya.phone.slice(-7));
  const others = (Object.keys(PEOPLE) as PersonKey[]).filter((k) => k !== callerKey).map((k) => PEOPLE[k].name.toLowerCase().split(' ')[0]!);
  const privacy = r.intent === 'QUERY_MY_SCHEDULE' && others.some((name) => new RegExp(`\\b${name}\\b`).test(shown));
  const confirmable = r.intent !== 'UNRECOGNIZED' && r.intent !== 'QUERY_MY_SCHEDULE' && canConfirmVoiceIntent(c.role, r.intent);
  return {
    ok,
    intentOk: results.some((m) => m.intentOk),
    argsOk: primary.intentOk ? primary.argsOk : (results.find((m) => m.intentOk)?.argsOk ?? null),
    falseConfirmable: c.mustNotExecute && confirmable && !ok,
    leak,
    privacy,
    robotic,
  };
}

/** The caller each role speaks as. */
export const CALLER: Record<VoiceCase['role'], PersonKey> = { STAFF: 'sam', MANAGER: 'hannah', OWNER: 'rashid' };
