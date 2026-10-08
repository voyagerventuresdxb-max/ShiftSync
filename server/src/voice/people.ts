/**
 * Finds the person a voice command names among the caller's OWN venue's active staff (the
 * `staffDirectory` buildContext loads for that venue only). The model is told to return the name
 * as the caller said it and to leave the id empty when it isn't sure, but a model can still pick
 * one of two people who share a first name with high confidence (seen live), so this check is
 * deterministic and never trusts the model's choice on its own.
 *
 * Never guess: a name settles on one person only when exactly one person fits it strongly — the
 * exact full name; a first name or surname only one person has (spelling variants such as
 * Yousef/Yusuf and short forms such as Jim → James count as the same name); or, for a
 * mishearing, a single person whose name sounds the same (phonetic key) and is spelled within one
 * or two letters, with nobody else close. Anything else is a question: "Which one?" when two or
 * more people fit, "did you mean…?" for close-sounding names, and "pick from your team" when
 * nothing is close. A person is never created from a voice command.
 */
export interface StaffEntry {
  id: string;
  fullName: string;
  /** The person's scheduling role ("Bartender"), shown next to the name so a wrong match is visible. */
  role?: string | null;
}

export type PersonResolution =
  /** Exactly one person: use them. */
  | { kind: 'one'; person: StaffEntry }
  /** More than one person fits (a shared name, or the model's pick disagrees with the name said). */
  | { kind: 'ambiguous'; heard: string; people: StaffEntry[] }
  /** Nobody by that name; `near` are similar-sounding names, closest first (may be empty: pick from the team). */
  | { kind: 'missing'; heard: string; near: StaffEntry[] }
  /** No name was given and the model's id isn't one of this venue's staff. */
  | { kind: 'unknown' };

/** At most this many people are listed in a "which one?" or "did you mean?" choice. */
export const MAX_PEOPLE_CHOICES = 4;
const SELF_WORDS = new Set(['me', 'myself', 'i']);

/**
 * Words that point at someone without naming them, in English and the code-mixed Hindi/Urdu,
 * Tagalog and Arabic callers use ("usko", "siya", "kanya", "hiya"). Seen live: "Shukran Layla, give
 * her a shout-out" reached the server as the person "her".
 */
const PRONOUNS = new Set([
  'her', 'him', 'them', 'she', 'he', 'they', 'hers', 'his', 'their',
  'this person', 'that person', 'this guy', 'that guy', 'this girl', 'that girl', 'this lady', 'that lady',
  'usko', 'unko', 'isko', 'inko', 'use', 'unhe', 'unhein', 'inhe', 'uska', 'unka',
  'siya', 'sya', 'kanya', 'kaniya', 'niya', 'hiya', 'huwa', 'huwwa',
]);

/** True when the person as heard is a pronoun or a "that person"-style pointer, not a name. */
export function isPronoun(heard: string): boolean {
  return PRONOUNS.has(normalizeName(heard));
}

/** NFKC, lowercase, accents and possessive "'s" dropped, punctuation as spaces: "Jun-Jun's" → "jun jun". */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]s\b/gi, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const tokens = (s: string) => normalizeName(s).split(' ').filter(Boolean);

/** Every word of the name as said is one of this full name's words ("Alex" fits "Alex Morgan"). */
export function nameFits(heard: string, fullName: string): boolean {
  const words = tokens(heard);
  const name = tokens(fullName);
  return words.length > 0 && words.every((w) => name.includes(w));
}
const firstName = (p: StaffEntry) => tokens(p.fullName)[0] ?? '';
const byName = (a: StaffEntry, b: StaffEntry) => a.fullName.localeCompare(b.fullName);

/** Spellings of one name that transliteration produces; each maps to one canonical form. */
const SPELLINGS: Record<string, string[]> = {
  muhammad: ['mohammed', 'mohammad', 'mohamed', 'mohamad', 'muhammed', 'muhamad', 'muhamed', 'mohd', 'mhd', 'mohummad', 'mohamud', 'mohammod'],
  ahmad: ['ahmed', 'ahmet', 'achmed'],
  abdul: ['abdel', 'abdool', 'abdu'],
  hussain: ['hussein', 'husain', 'husein', 'hossain', 'hosein'],
  hasan: ['hassan'],
  yusuf: ['yousef', 'youssef', 'yousuf', 'yosef', 'yussuf', 'youssouf'],
  ali: ['aly'],
  fatima: ['fatma', 'fatimah'],
  aisha: ['ayesha', 'aysha', 'aishah'],
};
const CANONICAL = new Map<string, string>(Object.entries(SPELLINGS).flatMap(([canon, list]) => [[canon, canon] as const, ...list.map((v) => [v, canon] as const)]));

/** Short forms and the names they stand for. */
const NICKNAMES: Record<string, string[]> = {
  bill: ['william'],
  will: ['william'],
  billy: ['william'],
  liam: ['william'],
  bob: ['robert'],
  rob: ['robert'],
  bobby: ['robert'],
  robbie: ['robert'],
  mike: ['michael'],
  mick: ['michael'],
  tony: ['anthony', 'antonio'],
  alex: ['alexander', 'alexandra', 'alejandro'],
  sasha: ['alexander', 'alexandra'],
  sandy: ['alexandra', 'sandra'],
  mo: ['muhammad'],
  moe: ['muhammad'],
  abdul: ['abdullah', 'abdulrahman', 'abdulaziz', 'abdulla'],
  abd: ['abdullah', 'abdulrahman', 'abdulaziz'],
  abdo: ['abdullah', 'abdulrahman'],
  sam: ['samuel', 'samantha', 'samir', 'samira'],
  kate: ['katherine', 'catherine', 'kathryn'],
  katie: ['katherine', 'catherine', 'kathryn'],
  kat: ['katherine', 'catherine'],
  cathy: ['catherine', 'katherine'],
  liz: ['elizabeth'],
  beth: ['elizabeth', 'bethany'],
  jim: ['james'],
  jimmy: ['james'],
  jamie: ['james'],
  joe: ['joseph'],
  joey: ['joseph'],
  dan: ['daniel'],
  danny: ['daniel'],
  dave: ['david'],
  chris: ['christopher', 'christian', 'christina', 'christine'],
  nick: ['nicholas', 'nicolas'],
  matt: ['matthew'],
  tom: ['thomas'],
  tommy: ['thomas'],
  ben: ['benjamin'],
  jen: ['jennifer'],
  jenny: ['jennifer'],
  ed: ['edward'],
  eddie: ['edward'],
  andy: ['andrew'],
  drew: ['andrew'],
  steve: ['steven', 'stephen'],
  pat: ['patrick', 'patricia'],
  greg: ['gregory'],
  vicky: ['victoria'],
  gabby: ['gabriel', 'gabriela', 'gabrielle'],
  manny: ['emmanuel', 'manuel'],
  leo: ['leonardo', 'leandro', 'leonard', 'leopold'],
  max: ['maximilian', 'maxwell'],
  nate: ['nathan', 'nathaniel'],
  ricky: ['ricardo', 'richard'],
  rick: ['richard', 'ricardo'],
  rich: ['richard'],
  fred: ['frederick', 'alfred'],
  frank: ['francis', 'francisco'],
  pancho: ['francisco'],
  paco: ['francisco'],
  pepe: ['jose'],
  lupe: ['guadalupe'],
  nico: ['nicolas', 'nicholas'],
  ana: ['anastasia'],
  ann: ['anne', 'anna'],
  meg: ['margaret'],
  maggie: ['margaret'],
  peggy: ['margaret'],
  sue: ['susan', 'suzanne'],
  zack: ['zachary'],
  zak: ['zakaria', 'zakariya', 'zachary'],
  ibra: ['ibrahim'],
  hamid: ['abdulhamid'],
  rafa: ['rafael'],
};

/**
 * One word folded so spellings of the same spoken name compare equal: "Mohammed"/"Muhammad",
 * "Phillip"/"Filip", "Khalid"/"Kalid", "Youssef"/"Yusuf", "Jennie"/"Jenny".
 */
export function foldName(word: string): string {
  const cached = folded.get(word);
  if (cached !== undefined) return cached;
  const w = normalizeName(word).replace(/\s+/g, '');
  const out = CANONICAL.get(w) ?? fold(w);
  if (folded.size > 50_000) folded.clear();
  folded.set(word, out);
  return out;
}
const folded = new Map<string, string>();

function fold(w: string): string {
  return w
    .replace(/ph/g, 'f')
    .replace(/kh/g, 'k')
    .replace(/gh/g, 'g')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/th/g, 't')
    .replace(/ou/g, 'u')
    .replace(/oo/g, 'u')
    .replace(/ee/g, 'i')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1')
    .replace(/(ie|ey)$/, 'i');
}

/**
 * A small sound-alike key (Soundex/Metaphone-style, in-house): the first sound, then consonant
 * classes with vowels dropped and repeats merged. "Riya"/"Rhea" → "R"; "Karim"/"Kareem" → "KRM".
 */
export function phoneticKey(word: string): string {
  const cached = keys.get(word);
  if (cached !== undefined) return cached;
  const key = soundKey(foldName(word));
  if (keys.size > 50_000) keys.clear();
  keys.set(word, key);
  return key;
}
const keys = new Map<string, string>();

function soundKey(w: string): string {
  if (!w) return '';
  const cls: Record<string, string> = { b: 'P', p: 'P', f: 'F', v: 'F', k: 'K', g: 'K', j: 'J', s: 'S', z: 'S', x: 'S', d: 'T', t: 'T', l: 'L', m: 'M', n: 'N', r: 'R' };
  let key = /[aeiouyhw]/.test(w[0]!) ? 'A' : '';
  for (const ch of w) {
    const c = cls[ch];
    if (c && key[key.length - 1] !== c) key += c;
  }
  return key;
}

/** Damerau-Levenshtein (optimal string alignment) distance: two swapped letters count as one edit. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** Each short form's folded full names, and each full name's folded short forms. */
const NICK_LINKS = new Map<string, Set<string>>();
for (const [short, names] of Object.entries(NICKNAMES)) {
  for (const n of names) {
    const a = foldName(short);
    const b = foldName(n);
    if (!NICK_LINKS.has(a)) NICK_LINKS.set(a, new Set());
    if (!NICK_LINKS.has(b)) NICK_LINKS.set(b, new Set());
    NICK_LINKS.get(a)!.add(b);
    NICK_LINKS.get(b)!.add(a);
  }
}

/** Two words are the same name by short form ("Jim" ↔ "James", "Liz" ↔ "Elizabeth"). */
function sameByNickname(a: string, b: string): boolean {
  const fa = foldName(a);
  const fb = foldName(b);
  // A longer form of the full name counts too: "Dan" is Daniel, and so may be Daniela.
  const links = (from: string, to: string) =>
    [...(NICK_LINKS.get(from) ?? [])].some((x) => x === to || (Math.min(x.length, to.length) >= 4 && (to.startsWith(x) || x.startsWith(to))));
  return links(fa, fb) || links(fb, fa);
}

/** How well one heard word fits one word of a name: 3 exact, 2 same name (spelling/short form), 1 sounds alike, 0 no. */
interface WordFit {
  level: 0 | 1 | 2 | 3;
  /** For level 1: true when it both sounds the same and is spelled within one or two letters. */
  clear: boolean;
  distance: number;
}

const fits = new Map<string, WordFit>();
function wordFit(heard: string, word: string): WordFit {
  const key = `${heard}|${word}`;
  let fit = fits.get(key);
  if (!fit) {
    fit = measureFit(heard, word);
    if (fits.size > 50_000) fits.clear();
    fits.set(key, fit);
  }
  return fit;
}

function measureFit(heard: string, word: string): WordFit {
  if (heard === word) return { level: 3, clear: true, distance: 0 };
  const fh = foldName(heard);
  const fw = foldName(word);
  if (fh === fw || sameByNickname(heard, word)) return { level: 2, clear: true, distance: 0 };
  // A short form the table doesn't list ("Theo" for Theodore, "Cass" for Cassandra): plausible, never clear.
  if (isPrefix(heard, word) || isPrefix(fh, fw)) return { level: 1, clear: false, distance: Math.abs(word.length - heard.length) };
  // Folding can shorten one side ("Nadie" → "nadi"): the plain spelling's distance counts too.
  if (Math.abs(fh.length - fw.length) > 2 && Math.abs(heard.length - word.length) > 2) return { level: 0, clear: false, distance: 3 };
  const distance = Math.min(editDistance(fh, fw), editDistance(heard, word));
  const shortest = Math.min(fh.length, fw.length, heard.length, word.length);
  if (shortest < 3) return { level: 0, clear: false, distance };
  const allowed = shortest <= 4 ? 1 : 2;
  const sameSound = phoneticKey(heard) === phoneticKey(word);
  if (distance > allowed && !(sameSound && distance <= 2)) return { level: 0, clear: false, distance };
  return { level: 1, clear: sameSound && distance <= allowed, distance };
}

/** One word starts the other, the shorter at least three letters ("dan" / "daniela"; never a particle such as "Al"). */
function isPrefix(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && short !== long && long.startsWith(short);
}

/**
 * Loosely close — anyone a caller could conceivably have meant by this word: the same name or
 * short form, either word starting the other, the same first three letters, the same sound key,
 * or within two letters. Used only to refuse a guess, never to pick someone.
 */
function looselyNear(heard: string, word: string): boolean {
  const fh = foldName(heard);
  const fw = foldName(word);
  if (fh === fw || sameByNickname(heard, word) || isPrefix(heard, word) || isPrefix(fh, fw)) return true;
  if (fh.length >= 3 && fw.length >= 3 && fh.slice(0, 3) === fw.slice(0, 3)) return true;
  // A particle ("Al", "El", "De") is nobody's name on its own.
  if (Math.min(fh.length, fw.length) < 3) return false;
  if (phoneticKey(heard) === phoneticKey(word)) return true;
  return Math.min(editDistance(fh, fw), editDistance(heard, word)) <= (Math.min(fh.length, fw.length) >= 4 ? 2 : 1);
}

/** Another person's name word that is a close alternative to a word said exactly: a letter away, an extension, or a short form. */
function closeAlternative(heard: string, word: string): boolean {
  if (heard === word) return false;
  const fh = foldName(heard);
  const fw = foldName(word);
  if (fh === fw || sameByNickname(heard, word) || isPrefix(heard, word) || isPrefix(fh, fw)) return true;
  return Math.min(fh.length, fw.length) >= 3 && Math.min(editDistance(fh, fw), editDistance(heard, word)) <= 1;
}

/** Everyone, other than `except`, whom every heard word could loosely mean. */
function othersNear(said: string[], staff: StaffEntry[], except: StaffEntry): StaffEntry[] {
  return staff.filter((p) => {
    if (p.id === except.id) return false;
    const words = nameWords(p);
    return said.every((h) => words.some((w) => looselyNear(h, w)));
  });
}

/** A person's name words, plus each two neighbouring words joined ("Jun Jun" → "junjun", "Abdul Rahman" → "abdulrahman"). */
function nameWords(p: StaffEntry): string[] {
  const w = tokens(p.fullName);
  return [...w, ...w.slice(1).map((x, i) => `${w[i]}${x}`)];
}

export interface Candidate {
  person: StaffEntry;
  /** The weakest word fit: 3 every word exact, 2 same name, 1 sounds alike. */
  level: 1 | 2 | 3;
  clear: boolean;
  distance: number;
}

/** How the heard name fits this person, or null: every heard word must fit a different word of their name. */
function fitPerson(heard: string[], p: StaffEntry): Candidate | null {
  const words = nameWords(p);
  const tryWords = (said: string[]): Candidate | null => {
    const used = new Set<number>();
    let level: 1 | 2 | 3 = 3;
    let clear = true;
    let distance = 0;
    for (const h of said) {
      let best: { i: number; fit: WordFit } | null = null;
      for (let i = 0; i < words.length; i++) {
        if (used.has(i)) continue;
        const fit = wordFit(h, words[i]!);
        if (fit.level && (!best || fit.level > best.fit.level || (fit.level === best.fit.level && fit.distance < best.fit.distance))) best = { i, fit };
      }
      if (!best) return null;
      used.add(best.i);
      level = Math.min(level, best.fit.level) as 1 | 2 | 3;
      clear &&= best.fit.clear;
      distance += best.fit.distance;
    }
    return { person: p, level, clear, distance };
  };
  const split = tryWords(heard);
  // "Junjun" said as one word, "Abdul Rahman" said as two: also try the words joined.
  const joined = heard.length > 1 ? tryWords([heard.join('')]) : null;
  if (!split) return joined;
  if (!joined) return split;
  return joined.level > split.level ? joined : split;
}

/** Everyone the heard name could be, strongest fit first. */
export function candidatesFor(heard: string, staff: StaffEntry[]): Candidate[] {
  const said = tokens(heard);
  if (!said.length) return [];
  return staff
    .map((p) => fitPerson(said, p))
    .filter((c): c is Candidate => c !== null)
    .sort((a, b) => b.level - a.level || a.distance - b.distance || byName(a.person, b.person));
}

/**
 * True when the transcript names this person only by a first name someone else at the venue
 * shares ("Omar", with an Omar Haddad and an Omar Farouk): their other names aren't in it.
 */
function sharedFirstNameOnly(person: StaffEntry, staff: StaffEntry[], transcript: string): StaffEntry[] {
  const first = foldName(firstName(person));
  const others = staff.filter((p) => p.id !== person.id && foldName(firstName(p)) === first);
  if (!others.length || !transcript.trim()) return [];
  const said = tokens(transcript).map(foldName);
  if (!said.includes(first)) return [];
  const rest = tokens(person.fullName).slice(1).map(foldName);
  return rest.some((w) => said.includes(w)) ? [] : others;
}

/**
 * "Give her a shout-out": who the pronoun points at, from the staff names actually said in the same
 * transcript (word for word, or the same name spelled another way; never a sound-alike, and never
 * the caller). Exactly one person named: that name goes through the normal rules below, so a first
 * name two people share still asks. Two or more named: "Who did you mean?" with them. None named:
 * nobody to look up, so the caller picks from the team. Never a guess.
 */
function resolvePronoun(staff: StaffEntry[], transcript: string, callerId: string): PersonResolution {
  const said = tokens(transcript).filter((w) => !PRONOUNS.has(w) && !SELF_WORDS.has(w));
  const folded = new Set(said.map(foldName));
  const saidOf = (p: StaffEntry) => new Set(nameWords(p).filter((w) => w.length >= 3 && folded.has(foldName(w))).map(foldName));
  const matched = staff.filter((p) => p.id !== callerId).map((p) => ({ p, words: saidOf(p) })).filter((m) => m.words.size > 0);
  // "Thanks Omar Farouk": Omar Haddad is named only by a word Omar Farouk's name also covers, so he isn't meant.
  const named = matched
    .filter((m) => !matched.some((o) => o !== m && o.words.size > m.words.size && [...m.words].every((w) => o.words.has(w))))
    .map((m) => m.p);
  if (named.length === 1) {
    // The words of their name as said, in order ("Layla", "Layla Nasser"), looked up like any name.
    const words = nameWords(named[0]!).filter((w) => folded.has(foldName(w)));
    const heard = said.filter((w) => words.some((x) => foldName(x) === foldName(w))).filter((w, i, all) => all.indexOf(w) === i).join(' ');
    return resolvePerson(heard, null, staff, transcript, callerId);
  }
  if (named.length > 1) return { kind: 'ambiguous', heard: 'person', people: [...named].sort(byName).slice(0, MAX_PEOPLE_CHOICES) };
  return { kind: 'missing', heard: '', near: [] };
}

/**
 * @param heard the name as the caller said it (the model's `targetUserName`), or '' if none
 * @param modelId the id the model picked, if any — trusted only when it agrees with the name
 * @param staff the caller's own venue's active staff
 * @param transcript what was heard, for the shared-first-name check
 * @param callerId "me"/"myself" resolves to the caller
 */
export function resolvePerson(heard: string, modelId: string | null, staff: StaffEntry[], transcript: string, callerId: string): PersonResolution {
  const byId = new Map(staff.map((p) => [p.id, p]));
  const picked = modelId ? (byId.get(modelId) ?? null) : null;
  const name = heard.trim();

  const settle = (person: StaffEntry): PersonResolution => {
    const sharers = sharedFirstNameOnly(person, staff, transcript);
    if (!sharers.length) return { kind: 'one', person };
    return { kind: 'ambiguous', heard: person.fullName.split(/\s+/)[0]!, people: [person, ...sharers].sort(byName) };
  };

  if (!name || SELF_WORDS.has(normalizeName(name))) {
    const self = name ? byId.get(callerId) : undefined;
    if (self) return { kind: 'one', person: self };
    return picked ? settle(picked) : { kind: 'unknown' };
  }
  if (isPronoun(name)) return resolvePronoun(staff, transcript, callerId);

  const found = candidatesFor(name, staff);
  const said = tokens(name);
  // An exact full name of two or more words settles; one word ("Edwin") is checked below.
  const exactFull = said.length > 1 ? staff.filter((p) => normalizeName(p.fullName) === normalizeName(name)) : [];
  // The same name (exact, a spelling variant or a short form): spelling is the speech engine's
  // choice, so "Mohammed" and a listed "Muhammad" are the same answer, never a tie-breaker.
  const strong = exactFull.length ? exactFull : found.filter((c) => c.level >= 2).map((c) => c.person);
  // One word that is exactly someone's name still isn't settled while another person is a close
  // alternative: a letter away ("Riya"/"Riaz"), one name extending the other ("Edwin"/"Edwina",
  // "Dan"/"Dana"), or the word a short form of their name ("Jim" with a James). Ask, the exact
  // match first.
  if (!exactFull.length && said.length === 1 && strong.length === 1 && found[0]!.level === 3) {
    const alternatives = staff.filter((p) => p.id !== strong[0]!.id && nameWords(p).some((w) => closeAlternative(said[0]!, w)));
    if (alternatives.length) return { kind: 'ambiguous', heard: name, people: [strong[0]!, ...alternatives].slice(0, MAX_PEOPLE_CHOICES) };
  }
  // Only a spelling variant or short form fits ("Joe" for Joseph, "Nate" for Nathaniel) and anyone
  // else could be meant too ("Joel", "Nata"): that is a question, not an answer.
  if (!exactFull.length && strong.length === 1 && found[0]!.level === 2) {
    // Shown: the other plausible names; only when there are none, the loosely close ones.
    const plausible = found.slice(1).map((c) => c.person);
    const others = plausible.length ? plausible : othersNear(said, staff, strong[0]!);
    if (others.length) return { kind: 'ambiguous', heard: name, people: [strong[0]!, ...others].slice(0, MAX_PEOPLE_CHOICES) };
  }
  if (strong.length === 1) {
    const person = strong[0]!;
    // The model chose someone else than the name it heard: both are put to the caller.
    if (picked && picked.id !== person.id) return { kind: 'ambiguous', heard: name, people: [person, picked] };
    return settle(person);
  }
  // Exact matches first, then spelling variants and short forms; by name within each.
  if (strong.length > 1) return { kind: 'ambiguous', heard: name, people: exactFull.length ? [...strong].sort(byName) : strong };

  // Nobody has that name. A mishearing is settled only when exactly one person is close, it sounds
  // the same, and nobody else is even loosely close (within two letters, the same sound key or
  // first three letters, or a name it starts): then either the words are long enough (five
  // letters or more, one letter off — "Tanakka" for Tanaka) or the model picked that same person.
  // Anything less is a question.
  const only = found.length === 1 ? found[0]! : null;
  if (only && only.clear && !othersNear(said, staff, only.person).length) {
    const unmistakable = said.every((w) => foldName(w).length >= 5) && only.distance <= said.length;
    if ((unmistakable && !picked) || picked?.id === only.person.id) return settle(only.person);
  }
  return { kind: 'missing', heard: name, near: found.slice(0, MAX_PEOPLE_CHOICES).map((m) => m.person) };
}
