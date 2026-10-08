import type { PrismaClient } from '@prisma/client';
import { similarity } from '../lib/textSimilarity.js';
import { normalizeHeader } from './templates.js';
import type { ParsedShiftRow, PreviewRow, RowIssue, UploadPreviewSummary } from './types.js';
import type { PeopleSummary, PersonFlag, PersonPreview, ReaderSource, ReadPerson, RowReadingInfo } from './rosterContract.js';

/** Case/whitespace-insensitive key for matching names against DB records. */
export function nameKey(value: string): string {
  return normalizeHeader(value);
}

/**
 * Canonical role aliases. The parser/VLM emits free-form role strings
 * ("Floor", "Supervisor", "Head Waiter", "Management / Floor", "SUPERVISORS")
 * that rarely match the exact Role.name seeded in the DB ("Floor Staff",
 * "Supervisor", "Head Waiter", "Management"). This map normalizes common
 * hospitality variants to the canonical role name so a valid staff member
 * isn't flagged "Unmatched role ⚠️" purely because of casing or a synonym.
 *
 * Keys are normalized (lowercase, alnum+space) via nameKey; values are the
 * canonical Role.name to look up. Lookup is case/whitespace-insensitive.
 */
const ROLE_ALIASES: Record<string, string> = {
  floor: 'Floor Staff',
  'floor staff': 'Floor Staff',
  'floor team': 'Floor Staff',
  'floor service': 'Floor Staff',
  'floor staff member': 'Floor Staff',
  // "Commis de rang"/"commis de salle" = the most junior member of a
  // French-service rang team (clearing, assisting) — general floor duty
  // rather than a specific waiter/runner specialization.
  'commis de rang': 'Floor Staff',
  'commis de salle': 'Floor Staff',
  waiter: 'Waiter',
  waiters: 'Waiter',
  'wait staff': 'Waiter',
  'waiting staff': 'Waiter',
  server: 'Waiter',
  servers: 'Waiter',
  // Classic French-service brigade: a "demi chef de rang" is the junior
  // half of a section-waiter pair, working under a chef de rang — same
  // seniority tier as a regular waiter, NOT the kitchen 'Chef' bucket.
  'demi chef de rang': 'Waiter',
  'demi chefs de rang': 'Waiter',
  'head waiter': 'Head Waiter',
  'head waiters': 'Head Waiter',
  'head server': 'Head Waiter',
  'senior waiter': 'Head Waiter',
  // "Chef de rang" = senior section waiter who owns a group of tables in
  // French service. Despite the word "Chef", this is a FOH floor role,
  // not kitchen staff — do not route into the 'Chef' bucket below.
  'chef de rang': 'Head Waiter',
  'chefs de rang': 'Head Waiter',
  // "Captain" is a common senior-waiter title on Dubai fine-dining floors.
  captain: 'Head Waiter',
  captains: 'Head Waiter',
  supervisor: 'Supervisor',
  supervisors: 'Supervisor',
  'floor supervisor': 'Supervisor',
  'shift supervisor': 'Supervisor',
  'team leader': 'Supervisor',
  'team lead': 'Supervisor',
  'section leader': 'Supervisor',
  'section leaders': 'Supervisor',
  // "Sup" — real abbreviated per-row title, confirmed in this app's own
  // audit fixture (server/scripts/make-skewed-scan-fixture.ts), not
  // invented. Short enough that a bare match risks false positives on
  // unrelated short tokens elsewhere (e.g. a stray "sup" in free text),
  // but this column only ever holds a role/title label, never prose.
  sup: 'Supervisor',
  runner: 'Runner',
  runners: 'Runner',
  'food runner': 'Runner',
  'bar runner': 'Runner',
  // "Run" — same fixture as "Sup" above, same reasoning.
  run: 'Runner',
  bartender: 'Bartender',
  bartenders: 'Bartender',
  barista: 'Bartender',
  barback: 'Bartender',
  barbacks: 'Bartender',
  mixologist: 'Bartender',
  mixologists: 'Bartender',
  host: 'Host',
  hostess: 'Host',
  'host hostess': 'Host',
  // Guest Relations Officer/Associate — the guest-greeting/seating desk
  // role common at Dubai/GCC fine-dining and hotel outlets; functionally
  // closest to Host among existing buckets (see report re: judgment call).
  'guest relations officer': 'Host',
  'guest relations officers': 'Host',
  'guest relations': 'Host',
  // A one-grade-up GRO title seen at some hotel-affiliated outlets — same
  // function, so the same bucket.
  'guest relations manager': 'Host',
  'guest relations managers': 'Host',
  gro: 'Host',
  'guest relations associate': 'Host',
  'guest relations associates': 'Host',
  gra: 'Host',
  chef: 'Chef',
  cooks: 'Chef',
  cook: 'Chef',
  'kitchen staff': 'Chef',
  // "Commis chef"/"Commis de Cuisine" = junior/trainee kitchen chef — real,
  // distinct kitchen titles (unlike bare "commis", which is ambiguous
  // between kitchen and floor and is deliberately NOT added here — see
  // report).
  'commis chef': 'Chef',
  'commis chefs': 'Chef',
  'commis de cuisine': 'Chef',
  management: 'Management',
  'management floor': 'Management',
  'management / floor': 'Management',
  manager: 'Management',
  managers: 'Management',
  // "Mgr"/"Mgrs" — the universal English shorthand for manager/managers.
  mgr: 'Management',
  mgrs: 'Management',
  gm: 'Management',
  'general manager': 'Management',
  'restaurant manager': 'Management',
  // "RM" — real per-row title abbreviation, confirmed in the Bar des Pres
  // reference fixture (barDesPresReference.test.ts, transcribed from an
  // actual venue roster) — the same abbreviation pattern as the existing
  // "gm" entry above for "General Manager", here for the already-mapped
  // "restaurant manager" one line up.
  rm: 'Management',
  // Deliberately NOT added, despite also appearing as real per-row titles
  // in the same Bar des Pres reference fixture: "AM" and "JAM". "AM" is
  // already a heavily overloaded token elsewhere in this app's own domain
  // (the AM/PM shift-period marker — see DayColumn.period in
  // deterministicGridParser.ts) — even though it isn't read through this
  // same map today, a bare "am" alias here is a real future collision risk
  // for no confirmed gain. "JAM" has no confirmed expansion anywhere in
  // this codebase or its source material (plausibly "Junior Assistant
  // Manager" by hospitality convention, but that's a guess, not a
  // confirmed fact) — same "don't guess" principle already applied to bare
  // "commis" below. Both stay unresolved (flagged "Unmatched role" for
  // manual assignment) until a real venue confirms what they mean.
  'floor manager': 'Management',
  'duty manager': 'Management',
  'shift manager': 'Management',
  'operations manager': 'Management',
  'assistant manager': 'Management',
  // "Asst Mgr"/"Asst Manager" — common shorthand for the "assistant
  // manager" entry above.
  'asst mgr': 'Management',
  'asst manager': 'Management',
  'assistant gm': 'Management',
  'head of floor': 'Management',
  'floor management': 'Management',
  // Maître d'Hôtel / Chef de Salle — the senior FOH authority in French
  // service, above chef de rang and reporting to the F&B/restaurant
  // manager. Grouped with 'Management' to match this table's existing
  // "head of floor" / "floor management" entries rather than Supervisor.
  // NOTE: nameKey/normalizeHeader preserves each accented char as its own
  // Unicode letter (via \p{L}) rather than folding it to plain ASCII (an
  // accent-folding attempt was tried and reverted — see templates.ts's own
  // comment — because it broke Vietnamese name matching), so a literal
  // "Maître d'Hôtel" normalizes to "maître d hôtel" — a DIFFERENT key from
  // this ASCII one — and will NOT match this key. Only the plain-ASCII
  // spellings real Dubai rosters actually use ("Maitre D", "Maitre
  // D'Hotel") match here.
  'maitre d': 'Management',
  'maitre d hotel': 'Management',
  'chef de salle': 'Management',
  'outlet manager': 'Management',
  'outlet managers': 'Management',
  // F&B / Food & Beverage Manager — the spelled-out, "&"-punctuated, AND
  // no-space "FB" forms are each their own distinct normalized key
  // ("F&B" -> "f b" [two tokens], "FB" -> "fb" [one token] — normalization
  // only collapses punctuation to a space, it doesn't merge/split letter
  // runs), plus the plural of each, since a section header grouping
  // several people under one manager title ("Food & Beverage Managers") is
  // a realistic sheet shape distinct from an individual's own title.
  'f b manager': 'Management',
  'f b managers': 'Management',
  'fb manager': 'Management',
  'fb managers': 'Management',
  'fnb manager': 'Management',
  'fnb managers': 'Management',
  'food and beverage manager': 'Management',
  'food and beverage managers': 'Management',
  'food beverage manager': 'Management',
  'food beverage managers': 'Management',
  staff: 'Staff',
  'general staff': 'Staff',
};

/**
 * Resolves a raw role string to its canonical Role.name, if a known alias
 * exists. Returns the canonical name, or the original string when no alias
 * matches (so the exact DB lookup still gets a chance).
 */
export function canonicalRoleName(raw: string): string {
  const key = nameKey(raw);
  // Plain bracket access (`ROLE_ALIASES[key]`) also resolves inherited
  // Object.prototype properties — a role/section label that normalizes to
  // "constructor" would otherwise silently return the real Object
  // constructor FUNCTION (truthy, so `?? raw` never kicks in) instead of
  // falling through to the raw string, corrupting anything downstream that
  // expects a string (e.g. a ParsedShiftRow.roleName). hasOwnProperty guards
  // against that same class of collision templates.ts's normalizeHeader fix
  // targets for name keys.
  return Object.prototype.hasOwnProperty.call(ROLE_ALIASES, key) ? ROLE_ALIASES[key] : raw;
}

/**
 * Whether `raw` matches a known role alias (including a canonical name
 * typed as-is, e.g. "Waiter" — the canonical spellings are their own keys
 * in ROLE_ALIASES). Used to disambiguate which of two candidate columns on
 * a grid-format sheet holds role labels vs. staff names by content rather
 * than position — see deterministicGridParser.ts.
 */
export function isRecognizedRoleAlias(raw: string): boolean {
  // `in` also matches inherited Object.prototype property names (see
  // canonicalRoleName above) — a cell reading "constructor" or "toString"
  // would otherwise be misreported as a recognized role alias.
  return Object.prototype.hasOwnProperty.call(ROLE_ALIASES, nameKey(raw));
}


/** The venue role every role-unresolved person is imported under until the manager assigns one. */
export const TEAM_MEMBER_ROLE_NAME = 'Team member';

/**
 * Key for matching a PERSON's name: `nameKey` on the NFC form, so the same name typed with
 * precomposed or decomposed accents gives one key. Deliberately keeps accents and tone marks
 * (see templates.ts: folding them merges different Vietnamese names), so only an exact match
 * on this key ever links a roster name to a staff member without asking.
 */
export function personNameKey(value: string): string {
  return nameKey(String(value ?? '').normalize('NFC'));
}

/**
 * Loose key: NFKD with combining marks stripped, then `nameKey` (lowercase, punctuation and
 * hyphens to spaces, whitespace collapsed). Only ever used to SUGGEST a possible match
 * ("José" vs "Jose"), never to link on its own.
 */
export function foldedNameKey(value: string): string {
  return nameKey(String(value ?? '').normalize('NFKD').replace(/\p{M}+/gu, ''));
}

export interface VenueUser {
  id: string;
  fullName: string;
  roleId: string | null;
}

/** Everything about one venue that a roster is matched against. */
export interface VenueMatchContext {
  /** nameKey(Role.name) -> id, active roles only. */
  roleByName: Map<string, string>;
  /** Remembered roster label (nameKey) -> roleId, active roles only. */
  roleAliasByLabel: Map<string, string>;
  /** Active staff. */
  users: VenueUser[];
  /** personNameKey(fullName) -> active staff with that name (more than one = ambiguous). */
  usersByKey: Map<string, VenueUser[]>;
  /** Remembered printed name (personNameKey) -> userId of an active staff member. */
  nameAliasByKey: Map<string, string>;
}

type ContextClient = Pick<PrismaClient, 'role' | 'user' | 'rosterRoleAlias' | 'rosterNameAlias'>;

export function buildVenueMatchContext(
  roles: { id: string; name: string }[],
  users: VenueUser[],
  roleAliases: { normalizedLabel: string; roleId: string }[],
  nameAliases: { normalizedName: string; userId: string }[],
): VenueMatchContext {
  const roleByName = new Map(roles.map((r) => [nameKey(r.name), r.id]));
  const activeRoleIds = new Set(roles.map((r) => r.id));
  const roleAliasByLabel = new Map(roleAliases.filter((a) => activeRoleIds.has(a.roleId)).map((a) => [a.normalizedLabel, a.roleId]));
  const usersByKey = new Map<string, VenueUser[]>();
  for (const user of users) {
    const key = personNameKey(user.fullName);
    if (!key) continue;
    usersByKey.set(key, [...(usersByKey.get(key) ?? []), user]);
  }
  const activeUserIds = new Set(users.map((u) => u.id));
  const nameAliasByKey = new Map(nameAliases.filter((a) => activeUserIds.has(a.userId)).map((a) => [a.normalizedName, a.userId]));
  return { roleByName, roleAliasByLabel, users, usersByKey, nameAliasByKey };
}

export async function loadVenueMatchContext(prisma: ContextClient, locationId: string): Promise<VenueMatchContext> {
  const [roles, users, roleAliases, nameAliases] = await Promise.all([
    prisma.role.findMany({ where: { locationId, isActive: true } }),
    prisma.user.findMany({ where: { locationId, isActive: true, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    prisma.rosterRoleAlias.findMany({ where: { locationId } }),
    prisma.rosterNameAlias.findMany({ where: { locationId } }),
  ]);
  return buildVenueMatchContext(roles, users.map((u) => ({ id: u.id, fullName: u.fullName, roleId: u.roleId })), roleAliases, nameAliases);
}

/**
 * Titles only the review's role RESOLUTION maps. Deliberately not in ROLE_ALIASES: the grid
 * parser uses that table (isRecognizedRoleAlias / canonicalRoleName) to tell a role column
 * from a name column, where a bare "AM" is the AM/PM marker. Here the label is already known
 * to be a role/title, so the common hospitality abbreviations are safe to map.
 */
const RESOLVE_ONLY_ROLE_ALIASES: Record<string, string> = {
  am: 'Management', // Assistant Manager
  jam: 'Management', // Junior Assistant Manager
  arm: 'Management', // Assistant Restaurant Manager
  'asst rm': 'Management',
  'chef de pass': 'Chef',
  'chef de partie': 'Chef',
  'demi chef de partie': 'Chef',
  'sous chef': 'Chef',
  'junior sous chef': 'Chef',
  'head chef': 'Chef',
  'executive chef': 'Chef',
  'pastry chef': 'Chef',
  busser: 'Runner',
  bussers: 'Runner',
  busboy: 'Runner',
  agm: 'Management', // Assistant General Manager
  hod: 'Management', // Head of Department
  om: 'Management', // Operations Manager
  dm: 'Management', // Duty Manager
  fm: 'Management', // Floor Manager
  tl: 'Supervisor', // Team Leader
  hw: 'Head Waiter',
  cdr: 'Head Waiter', // Chef de Rang
  dcdr: 'Waiter', // Demi Chef de Rang
  cdp: 'Chef', // Chef de Partie
  dcdp: 'Chef', // Demi Chef de Partie
  // Department banners, for the people listed under one without a title of their own.
  bar: 'Bartender',
  hosts: 'Host',
  hostesses: 'Host',
  kitchen: 'Chef',
  // Abbreviations rotas print for titles ("RNR", "BTD", "SVR", "HST", "BAR BK", "LEAD SVR" = lead + SVR).
  rnr: 'Runner',
  btd: 'Bartender',
  btdr: 'Bartender',
  'bar bk': 'Bartender',
  barbk: 'Bartender',
  svr: 'Waiter',
  srv: 'Waiter',
  wtr: 'Waiter',
  hst: 'Host',
  capt: 'Head Waiter',
  somm: 'Sommelier',
  sommelier: 'Sommelier',
  'sec ldr': 'Supervisor',
};

/** A grade before a title ("Senior Server", "Jr Bartender", "Trainee Host"): the role is the title after it. */
const SENIORITY_PREFIX = /^(senior|snr|sr|junior|jnr|jr|trainee|lead|chief|principal|deputy|assistant|asst)\s+(?=\S)/;

/**
 * A role in the plural, as a section banner prints it, in the singular: "food runners" -> "food
 * runner", "hostesses" -> "hostess", "section leaders" -> "section leader". Short words are left
 * alone ("bus" is not a plural).
 */
export function singularRoleKey(key: string): string {
  if (/(?:ss|us|is)$/.test(key)) return key;
  if (/\p{L}{4}(?:sses|shes|ches)$/u.test(key)) return key.slice(0, -2);
  return key.replace(/(?<=\p{L}{3})s$/u, '');
}

/**
 * A role key without a trailing position number: "waiter 3", "head waiter 1", "runner 2nd",
 * "waiter ii", "waiter3" -> "waiter" / "head waiter" / "runner". Rosters number people within
 * a title; the number is never part of the role.
 */
export function stripRoleOrdinal(key: string): string {
  return key
    .replace(/(?:\s+(?:\d+(?:st|nd|rd|th)?|i{1,3}|iv))+$/u, '')
    .replace(/(?<=\p{L})\d+$/u, '')
    .trim();
}

/**
 * Resolves a role label as printed to one of the venue's active roles: its own exact role
 * name first (a venue's own "GRO" beats the generic alias bucket), then a mapping the manager
 * asked to remember, then the canonical alias table, then the resolve-only abbreviations —
 * each tried on the label as printed, then without a trailing number ("Waiter 3"), then
 * without a grade before the title ("Senior Server").
 * Null when none applies (non-blocking: the person is imported as "Team member").
 */
export function resolveRoleLabel(label: string | null | undefined, ctx: VenueMatchContext): string | null {
  const raw = String(label ?? '').trim();
  if (!raw) return null;
  const tryKey = (key: string): string | null => {
    if (!key) return null;
    const resolveOnly = Object.prototype.hasOwnProperty.call(RESOLVE_ONLY_ROLE_ALIASES, key) ? RESOLVE_ONLY_ROLE_ALIASES[key] : undefined;
    return (
      ctx.roleByName.get(key) ??
      ctx.roleAliasByLabel.get(key) ??
      ctx.roleByName.get(nameKey(canonicalRoleName(key))) ??
      (resolveOnly ? ctx.roleByName.get(nameKey(resolveOnly)) : undefined) ??
      null
    );
  };
  const key = nameKey(raw);
  const stripped = stripRoleOrdinal(key);
  // Any other "… Manager" title ("Ops Manager", "Events Manager") is a manager, when the venue
  // has no closer role of its own (its own role name and remembered mappings are tried first).
  const manager = MANAGER_TITLE.test(stripped) ? ctx.roleByName.get(nameKey('Management')) ?? null : null;
  const plain = stripped.replace(SENIORITY_PREFIX, '');
  const one = singularRoleKey(plain);
  return tryKey(key) ?? (stripped !== key ? tryKey(stripped) : null) ?? (plain !== stripped ? tryKey(plain) : null) ?? (one !== plain ? tryKey(one) : null) ?? manager;
}

const MANAGER_TITLE = /\b(managers?|mgrs?)$/;

/**
 * True when a label is a role or title rather than a person's name: a known role alias or
 * abbreviation, with or without a position number ("Waiter 3", "Head waiter 1", "RM", "JAM"),
 * or any "… Manager" title. Keeps titles, banners and header words from ever being imported
 * as people.
 */
export function isRoleTitle(label: string): boolean {
  const key = nameKey(label);
  if (!key) return false;
  const known = (k: string) => Object.prototype.hasOwnProperty.call(ROLE_ALIASES, k) || Object.prototype.hasOwnProperty.call(RESOLVE_ONLY_ROLE_ALIASES, k);
  const stripped = stripRoleOrdinal(key);
  const plain = stripped.replace(SENIORITY_PREFIX, '');
  const one = singularRoleKey(plain);
  return known(key) || (stripped !== key && known(stripped)) || (plain !== stripped && known(plain)) || (one !== plain && known(one)) || MANAGER_TITLE.test(stripped);
}

type TokenMatch = 'equal' | 'initial' | 'prefix' | 'nickname' | 'spelling';

/**
 * Common nicknames and the names they stand for (and spellings of one name), one group per
 * name: "Bill" and "William", "Mo" and "Mohammed". Only ever used to SUGGEST a possible match.
 */
const NICKNAME_GROUPS: string[][] = [
  ['william', 'bill', 'billy', 'will', 'willy', 'willie', 'liam'],
  ['robert', 'bob', 'bobby', 'rob', 'robbie', 'bert'],
  ['elizabeth', 'liz', 'lizzie', 'beth', 'betty', 'eliza', 'libby', 'elsie'],
  ['katherine', 'catherine', 'kathryn', 'katharine', 'kate', 'katie', 'kathy', 'cathy', 'kat', 'cat', 'kitty'],
  ['michael', 'mike', 'mikey', 'mick', 'mickey', 'micky'],
  ['thomas', 'tom', 'tommy'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['richard', 'dick', 'rick', 'ricky', 'rich', 'richie'],
  ['charles', 'chuck', 'charlie', 'chas'],
  ['margaret', 'peggy', 'maggie', 'meg', 'marge', 'madge'],
  ['alexander', 'alexandra', 'alex', 'sasha', 'sandy', 'lexi', 'xander'],
  ['edward', 'ted', 'teddy', 'ed', 'eddie', 'ned'],
  ['anthony', 'antony', 'tony'],
  ['samuel', 'samantha', 'sam', 'sammy'],
  ['benjamin', 'ben', 'benny', 'benji'],
  ['daniel', 'danielle', 'dan', 'danny'],
  ['joseph', 'josephine', 'joe', 'joey', 'jo', 'josie'],
  ['nicholas', 'nicola', 'nick', 'nicky', 'nico'],
  ['christopher', 'christine', 'christina', 'chris', 'kris', 'chrissy'],
  ['matthew', 'matt', 'matty'],
  ['patrick', 'patricia', 'pat', 'paddy', 'patty', 'trish'],
  ['jonathan', 'jon', 'jonny'],
  ['john', 'jack', 'johnny'],
  ['andrew', 'andy', 'drew'],
  ['stephen', 'steven', 'steve', 'stevie'],
  ['david', 'dave', 'davey'],
  ['jennifer', 'jen', 'jenny'],
  ['rebecca', 'becky', 'becca'],
  ['victoria', 'vicky', 'vicki', 'tori'],
  ['susan', 'sue', 'susie'],
  ['deborah', 'debbie', 'deb'],
  ['gregory', 'greg'],
  ['timothy', 'tim', 'timmy'],
  ['kenneth', 'ken', 'kenny'],
  ['ronald', 'ron', 'ronnie'],
  ['donald', 'don', 'donnie'],
  ['frederick', 'fred', 'freddie'],
  ['lawrence', 'laurence', 'larry'],
  ['raymond', 'ray'],
  ['jacob', 'jake'],
  ['zachary', 'zach', 'zack'],
  ['nathaniel', 'nathan', 'nate'],
  ['abdullah', 'abdulrahman', 'abdulaziz', 'abdulla', 'abdul', 'abd', 'abdu', 'abdo'],
  ['mohammed', 'mohammad', 'mohamed', 'muhammad', 'muhammed', 'mohd', 'md', 'mo', 'moe'],
  ['ahmed', 'ahmad'],
  ['yusuf', 'yousef', 'youssef', 'yousuf'],
];
const NICKNAMES = new Map<string, Set<number>>();
NICKNAME_GROUPS.forEach((group, i) => {
  for (const name of group) NICKNAMES.set(name, new Set([...(NICKNAMES.get(name) ?? []), i]));
});
/** Two first names that are a nickname and the name it stands for, or two spellings of one name. */
function sameNameGroup(a: string, b: string): boolean {
  const ga = NICKNAMES.get(a);
  const gb = NICKNAMES.get(b);
  return !!ga && !!gb && [...ga].some((g) => gb.has(g));
}

function tokenMatch(a: string, b: string): TokenMatch | null {
  if (a === b) return 'equal';
  if (sameNameGroup(a, b)) return 'nickname';
  if ((a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))) return 'initial';
  if (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))) return 'prefix';
  const maxLen = Math.max(a.length, b.length);
  const distance = Math.round((1 - similarity(a, b)) * maxLen);
  const allowed = maxLen >= 7 ? 2 : maxLen >= 4 ? 1 : 0;
  return distance > 0 && distance <= allowed ? 'spelling' : null;
}

/**
 * How close a printed name is to a staff member's name, when they are NOT the same key:
 * 'strong' (same letters without accents, first name only, a nickname that starts the name or
 * a common one — "Bill" for William, "Mo" for Mohammed — an initial for the surname, the same
 * words in another order, an initial with the surname
 * in either order — "I. Fairweather", "Fairweather I.") or 'weak' (a small spelling difference, initials
 * only — "I.F."). Null = unrelated. Only ever a suggestion: nothing here links anyone.
 */
export function nameCloseness(printed: string, staffName: string): 'strong' | 'weak' | null {
  const fa = foldedNameKey(printed);
  const fb = foldedNameKey(staffName);
  if (!fa || !fb) return null;
  if (fa === fb) return 'strong';
  const ta = fa.split(' ');
  const tb = fb.split(' ');
  return positionalCloseness(ta, tb) ?? initialsCloseness(printed, ta, tb) ?? initialsCloseness(staffName, tb, ta);
}

/** Word by word, in order: the first name (or a nickname that starts it), then the rest. */
function positionalCloseness(ta: string[], tb: string[]): 'strong' | 'weak' | null {
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const kinds: TokenMatch[] = [];
  for (let i = 0; i < short.length; i++) {
    const kind = tokenMatch(short[i]!, long[i]!);
    if (!kind) return null;
    kinds.push(kind);
  }
  // A lone initial for the first name ("M. Lopez") is left to initialsCloseness.
  if (kinds[0] === 'initial') return null;
  if (short.length < long.length) return kinds.every((k) => k === 'equal' || k === 'prefix' || k === 'nickname') ? 'strong' : 'weak';
  return kinds.includes('spelling') ? 'weak' : 'strong';
}

/**
 * A shortened form of `full`, whatever the order: the same words reordered ("Fairweather Ignatius"),
 * an initial with the surname ("I. Fairweather", "Fairweather I.", "A. Obi"), or initials alone ("I.F.",
 * "IF"). Every written word must be one of the full name's words and every initial must start
 * a different one of them.
 */
function initialsCloseness(raw: string, short: string[], full: string[]): 'strong' | 'weak' | null {
  if ([...short].sort().join(' ') === [...full].sort().join(' ')) return 'strong';
  const firstLetters = full.map((t) => t[0]).join('');
  // Initials alone, in capitals or with dots: "I.F.", "I F", "IF".
  if (/^\s*(\p{Lu}\.?\s*){2,3}$/u.test(raw)) {
    const letters = short.join('');
    return letters.length >= 2 && (letters === firstLetters || letters === `${full[0]![0]}${full[full.length - 1]![0]}`) ? 'weak' : null;
  }
  const initials = short.filter((t) => t.length === 1);
  const words = short.filter((t) => t.length > 1);
  if (initials.length === 0 || words.length === 0 || short.length > full.length) return null;
  const left = [...full];
  let spelling = false;
  for (const w of words) {
    const i = left.findIndex((t) => t === w || tokenMatch(w, t) === 'spelling' || tokenMatch(w, t) === 'prefix');
    if (i < 0) return null;
    if (left[i] !== w) spelling = true;
    left.splice(i, 1);
  }
  for (const c of initials) {
    const i = left.findIndex((t) => t[0] === c);
    if (i < 0) return null;
    left.splice(i, 1);
  }
  return spelling ? 'weak' : 'strong';
}

interface NameMatch {
  /** Linked without asking: one exact name match, or a remembered "same person". */
  userId: string | null;
  candidates: { userId: string; fullName: string; strength: 'strong' | 'weak' }[];
}

export function matchPersonName(name: string, ctx: VenueMatchContext): NameMatch {
  const key = personNameKey(name);
  if (!key) return { userId: null, candidates: [] };
  const exact = ctx.usersByKey.get(key) ?? [];
  if (exact.length === 1) return { userId: exact[0]!.id, candidates: [] };
  if (exact.length > 1) {
    // Two staff share this exact name: never pick one silently.
    return { userId: null, candidates: exact.map((u) => ({ userId: u.id, fullName: u.fullName, strength: 'weak' as const })) };
  }
  const aliased = ctx.nameAliasByKey.get(key);
  if (aliased) return { userId: aliased, candidates: [] };
  const candidates = ctx.users
    .map((u) => ({ userId: u.id, fullName: u.fullName, strength: nameCloseness(name, u.fullName) }))
    .filter((c): c is { userId: string; fullName: string; strength: 'strong' | 'weak' } => c.strength !== null)
    .sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'strong' ? -1 : 1))
    .slice(0, 3);
  return { userId: null, candidates };
}

type ReadingRow = ParsedShiftRow & RowReadingInfo;

/** The person a row belongs to: the reader's personKey, else its source row, else its name. */
export function personKeyOf(row: ReadingRow): string {
  if (row.personKey) return row.personKey;
  if (row.sourceRowIndex !== undefined) return `row:${row.sourceRowIndex}`;
  return `name:${personNameKey(row.employeeName) || `#${row.rowNumber}`}`;
}

function combinedReader(sources: (ReaderSource | undefined)[]): ReaderSource | undefined {
  const known = sources.filter((s): s is ReaderSource => !!s);
  if (known.length === 0) return undefined;
  if (known.every((s) => s === 'ai')) return 'ai';
  if (known.every((s) => s === 'table')) return 'table';
  return 'both';
}

/**
 * One PersonPreview per person on the roster — every person a reader saw, including people
 * with no shifts that week — matched against the venue. Exact name (or a remembered link) =
 * matched; anything close is only ever a suggestion (needs_decision + possible_match); the
 * same name on two rows or under two sections is flagged, never merged or dropped here.
 */
export function buildPeoplePreview(rows: ReadingRow[], readPeople: ReadPerson[] | undefined, ctx: VenueMatchContext): PersonPreview[] {
  const rowsByKey = new Map<string, ReadingRow[]>();
  for (const row of rows) {
    const key = personKeyOf(row);
    rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
  }
  const readByKey = new Map((readPeople ?? []).map((p) => [p.personKey, p]));
  const keys = [...new Set([...(readPeople ?? []).map((p) => p.personKey), ...rowsByKey.keys()])];

  const people: PersonPreview[] = keys.flatMap((personKey) => {
    const personRows = rowsByKey.get(personKey) ?? [];
    const read = readByKey.get(personKey);
    const name = (read?.name ?? personRows[0]?.employeeName ?? '').trim();
    if (!name) return [];
    const roleLabel = read?.roleLabel?.trim() || personRows.find((r) => r.roleName.trim())?.roleName.trim() || null;
    const section = read?.section ?? personRows.find((r) => r.section)?.section ?? null;
    // Two AI readings of a photo or scan that spelled the name differently: never settled silently.
    // (With a table reader, its spelling is the file's own text and is kept.)
    const spellings = read && read.readerSource !== 'both' ? [...new Set([name, ...(read.nameAlternatives ?? []).map((n) => n.name.trim())])].filter(Boolean) : [];
    const nameDiffers = new Set(spellings.map((s) => foldedNameKey(s).replace(/ /g, ''))).size > 1;
    const match = matchPersonName(name, ctx);
    // Another spelling that is exactly someone on staff is offered as a possible match.
    if (nameDiffers && !match.userId) {
      for (const other of spellings.slice(1)) {
        const id = matchPersonName(other, ctx).userId;
        const user = id ? ctx.users.find((u) => u.id === id) : undefined;
        if (user && !match.candidates.some((c) => c.userId === user.id)) match.candidates.unshift({ userId: user.id, fullName: user.fullName, strength: 'strong' });
      }
    }
    const matchedUser = match.userId ? ctx.users.find((u) => u.id === match.userId) : undefined;
    // The role their shifts get if the manager assigns none: the printed label, else a row's
    // own label, else (already on staff) their current role. Null = role_unresolved.
    const rowRoleId = personRows.map((r) => resolveRoleLabel(r.roleName, ctx)).find((id): id is string => !!id) ?? null;
    const resolvedRoleId = resolveRoleLabel(roleLabel, ctx) ?? rowRoleId ?? matchedUser?.roleId ?? null;

    const flags: PersonFlag[] = [];
    if (match.candidates.length > 0) flags.push({ kind: 'possible_match', candidates: match.candidates.map(({ userId, fullName }) => ({ userId, fullName })) });
    const reader = read?.readerSource ?? combinedReader(personRows.map((r) => r.readerSource));
    if (nameDiffers) flags.push({ kind: 'name_differs', spellings });
    if (reader === 'ai') flags.push({ kind: 'ai_only' });
    if (read?.oneReading) flags.push({ kind: 'one_reading' });
    if (reader === 'table') flags.push({ kind: 'table_only' });
    if (!resolvedRoleId) flags.push({ kind: 'role_unresolved' });

    const sourceRows = read
      ? [{ page: read.sourcePage, row: read.sourceRow }]
      : [...new Map(personRows.map((r) => [`${r.sourcePage ?? ''}:${r.sourceRowIndex ?? r.rowNumber}`, { page: r.sourcePage ?? null, row: r.sourceRowIndex ?? null }])).values()];

    const preview: PersonPreview = {
      personKey,
      name,
      normalizedName: personNameKey(name),
      roleLabel,
      resolvedRoleId,
      section,
      status: match.userId && !nameDiffers ? 'matched' : match.candidates.length > 0 || nameDiffers ? 'needs_decision' : 'new',
      matchedUserId: match.userId,
      flags,
      shiftCount: personRows.length,
      rowNumbers: personRows.map((r) => r.rowNumber),
      sourceRows,
      // The review screen's preselection: only an exact (or remembered) match links. A close
      // name is never preselected as the same person — the manager answers it (the review
      // screen won't confirm until they do), and a confirm without an answer creates.
      suggestedAction: match.userId ? 'link' : 'create',
      suggestedUserId: match.userId,
    };
    return [preview];
  });

  // The same name on two or more entries: listed twice, or under two sections.
  const byName = new Map<string, PersonPreview[]>();
  for (const person of people) byName.set(person.normalizedName, [...(byName.get(person.normalizedName) ?? []), person]);
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const personKeys = group.map((p) => p.personKey);
    const sections = [...new Set(group.map((p) => p.section).filter((s): s is string => !!s))];
    for (const person of group) {
      person.flags.push({ kind: 'duplicate_name', personKeys });
      if (sections.length >= 2) person.flags.push({ kind: 'two_sections', sections });
      person.status = 'needs_decision';
    }
  }
  return people;
}

export function summarizePeople(people: PersonPreview[]): PeopleSummary {
  return {
    total: people.length,
    matched: people.filter((p) => p.status === 'matched').length,
    new: people.filter((p) => p.status === 'new').length,
    needsDecision: people.filter((p) => p.status === 'needs_decision').length,
    roleUnresolved: people.filter((p) => p.flags.some((f) => f.kind === 'role_unresolved')).length,
  };
}

export interface ResolveRowsOptions {
  /** Every person the readers saw, including people with no shifts that week. */
  readPeople?: ReadPerson[];
}

/**
 * Resolves parsed rows against a Location's roles and staff, and groups them into people.
 * Nothing here blocks: an unresolved role is a flag (the person is imported as "Team member"
 * unless the manager assigns a role), an unknown name is a new person, a close name is a
 * question for the manager. Nothing is written.
 */
export async function resolveRowsAgainstDatabase(
  prisma: ContextClient,
  locationId: string,
  rows: ParsedShiftRow[],
  options: ResolveRowsOptions = {},
): Promise<{ previewRows: PreviewRow[]; summary: UploadPreviewSummary & { people: PeopleSummary }; people: PersonPreview[] }> {
  const ctx = await loadVenueMatchContext(prisma, locationId);
  const people = buildPeoplePreview(rows, options.readPeople, ctx);
  const personByKey = new Map(people.map((p) => [p.personKey, p]));

  const previewRows: PreviewRow[] = rows.map((row) => {
    const issues: RowIssue[] = [];
    const person = personByKey.get(personKeyOf(row));
    const resolvedUserId = person?.matchedUserId ?? null;
    const matchedUser = resolvedUserId ? ctx.users.find((u) => u.id === resolvedUserId) : undefined;

    // The file gave no role at all for someone already on staff with one: use theirs.
    const usedExistingRoleFallback = !row.roleName.trim() && !!matchedUser?.roleId;
    const resolvedRoleId = resolveRoleLabel(row.roleName, ctx) ?? (usedExistingRoleFallback ? matchedUser!.roleId : null);

    if (usedExistingRoleFallback) {
      issues.push({
        rowNumber: row.rowNumber,
        field: 'role',
        severity: 'info',
        message: `Role for "${row.employeeName}" was not specified in the file — inferred from their existing staff record.`,
      });
    }
    if (!resolvedRoleId) {
      issues.push({
        rowNumber: row.rowNumber,
        field: 'role',
        severity: 'warning',
        message: row.roleName.trim()
          ? `Role "${row.roleName}" does not exist for this location yet. Assign a role on the review screen, or this shift is added as "${TEAM_MEMBER_ROLE_NAME}".`
          : `No role could be identified for this shift. Assign a role on the review screen, or it is added as "${TEAM_MEMBER_ROLE_NAME}".`,
      });
    }
    if (!resolvedUserId) {
      issues.push({
        rowNumber: row.rowNumber,
        field: 'employeeName',
        severity: 'info',
        message: `"${row.employeeName}" is not on your staff list yet. Confirming adds them.`,
      });
    }

    const status: PreviewRow['status'] = !resolvedRoleId ? 'unmatched_role' : !resolvedUserId ? 'new_employee' : 'matched';
    return { ...row, status, resolvedRoleId, resolvedUserId, issues };
  });

  const summary = {
    totalRows: previewRows.length,
    matchedRows: previewRows.filter((r) => r.status === 'matched').length,
    newEmployeeRows: previewRows.filter((r) => r.status === 'new_employee').length,
    unmatchedRoleRows: previewRows.filter((r) => r.status === 'unmatched_role').length,
    errorRows: previewRows.filter((r) => r.status === 'error').length,
    people: summarizePeople(people),
  };

  return { previewRows, summary, people };
}
