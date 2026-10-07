import { similarity } from '../lib/textSimilarity.js';

/**
 * Finds the person a voice command names among the caller's OWN venue's active staff (the
 * `staffDirectory` buildContext loads for that venue only). The model is told to return the name
 * as the caller said it and to leave the id empty when it isn't sure, but a model can still pick
 * one of two people who share a first name with high confidence (seen live), so this check is
 * deterministic and never trusts the model's choice on its own.
 */
export interface StaffEntry {
  id: string;
  fullName: string;
}

export type PersonResolution =
  /** Exactly one person: use them. */
  | { kind: 'one'; person: StaffEntry }
  /** More than one person fits (a shared name, or the model's pick disagrees with the name said). */
  | { kind: 'ambiguous'; heard: string; people: StaffEntry[] }
  /** Nobody by that name; `near` are similar-sounding names, closest first (may be empty). */
  | { kind: 'missing'; heard: string; near: StaffEntry[] }
  /** No name was given and the model's id isn't one of this venue's staff. */
  | { kind: 'unknown' };

/** At most this many people are listed in a "which one?" or "did you mean?" choice. */
export const MAX_PEOPLE_CHOICES = 3;
/** Similar spelling worth suggesting ("Alix" → Alex is 0.75, "Leila" → Layla 0.6). */
const NEAR_SCORE = 0.6;
/** Similar enough to accept the model's own pick when it agrees and no one else is close. */
const STRONG_NEAR_SCORE = 0.75;
const SELF_WORDS = new Set(['me', 'myself', 'i']);

/** Lowercase, accents and possessive "'s" dropped, punctuation as spaces: "Jun-Jun's" → "jun jun". */
export function normalizeName(s: string): string {
  return s
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

/** Best similarity of the heard name to the full name, any one of its words, or two words in a row. */
function nearScore(heard: string, p: StaffEntry): number {
  const words = tokens(p.fullName);
  const parts = [words.join(' '), ...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
  return Math.max(...parts.map((part) => similarity(heard, part)));
}

/** Everyone the heard name fits: the exact full name first, else every word of it found in a name, else similar spellings. */
function lookUp(heard: string, staff: StaffEntry[]): { exact: StaffEntry[]; near: { person: StaffEntry; score: number }[] } {
  const h = normalizeName(heard);
  const full = staff.filter((p) => normalizeName(p.fullName) === h);
  if (full.length) return { exact: full, near: [] };
  const words = h.split(' ');
  const partial = staff.filter((p) => {
    const name = tokens(p.fullName);
    return words.every((w) => name.includes(w));
  });
  if (partial.length) return { exact: partial, near: [] };
  const near = staff
    .map((person) => ({ person, score: nearScore(h, person) }))
    .filter((m) => m.score >= NEAR_SCORE)
    .sort((a, b) => b.score - a.score || byName(a.person, b.person));
  return { exact: [], near };
}

/**
 * True when the transcript names this person only by a first name someone else at the venue
 * shares ("Omar", with an Omar Haddad and an Omar Farouk): their other names aren't in it.
 */
function sharedFirstNameOnly(person: StaffEntry, staff: StaffEntry[], transcript: string): StaffEntry[] {
  const first = firstName(person);
  const others = staff.filter((p) => p.id !== person.id && firstName(p) === first);
  if (!others.length || !transcript.trim()) return [];
  const said = tokens(transcript);
  if (!said.includes(first)) return [];
  const rest = tokens(person.fullName).slice(1);
  return rest.some((w) => said.includes(w)) ? [] : others;
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

  const { exact, near } = lookUp(name, staff);
  if (exact.length === 1) {
    const [person] = exact as [StaffEntry];
    // The model chose someone else than the name it heard: both are put to the caller.
    if (picked && picked.id !== person.id) return { kind: 'ambiguous', heard: name, people: [person, picked] };
    return settle(person);
  }
  if (exact.length > 1) return { kind: 'ambiguous', heard: name, people: [...exact].sort(byName) };

  // Nobody has that name. A close spelling the model also picked, with no other close name, is a
  // mishearing it already resolved ("Alix" → Alex); anything less is a question.
  const strong = near.filter((m) => m.score >= STRONG_NEAR_SCORE);
  if (picked && strong.length === 1 && strong[0]!.person.id === picked.id && near.length === 1) return settle(picked);
  return { kind: 'missing', heard: name, near: near.slice(0, MAX_PEOPLE_CHOICES).map((m) => m.person) };
}
