import { editDistance, foldName, normalizeName, phoneticKey } from './people.js';

/**
 * Spoken venue words — sections ("the bar", "terrace", "floor"), roles ("bartender") and service
 * periods ("closing", "dinner", "opening", "lunch") — checked against THIS venue's own lists. The
 * model picks a section or role id itself; this is the deterministic second look at what the
 * caller actually said, with the same rule as for people: one clear match is used, close or
 * several matches are a question, and nothing is ever guessed or created.
 */
export interface Term {
  id: string;
  label: string;
}

export type TermResolution =
  | { kind: 'one'; item: Term }
  /** Two or more of the venue's items fit what was said ("the bar": Main Bar, Pool Bar). */
  | { kind: 'choice'; heard: string; items: Term[] }
  /** Nothing at the venue fits; `heard` is what was said, to say back. */
  | { kind: 'none'; heard: string };

/** Words that say what kind of place a label is, not which one ("Terrace Section" is the terrace). */
const GENERIC = new Set(['the', 'a', 'an', 'section', 'area', 'zone', 'station', 'side', 'on', 'in', 'at', 'to']);
const MAX_TERM_CHOICES = 4;

/** A word as compared: spelling folded, a plural "s" dropped ("bars" → "bar"). */
const word = (w: string) => {
  const f = foldName(w);
  return f.length > 3 && f.endsWith('s') ? f.slice(0, -1) : f;
};
const words = (s: string) => normalizeName(s).split(' ').filter(Boolean);
/** The words that pick out one item ("Main Bar" → main, bar; "Terrace Section" → terrace). */
const distinctive = (label: string) => {
  const all = words(label);
  const own = all.filter((w) => !GENERIC.has(w));
  return (own.length ? own : all).map(word);
};

function sounds(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return editDistance(a, b) <= 1 || (phoneticKey(a) === phoneticKey(b) && editDistance(a, b) <= 2);
}

/** What was said ("the bar", "Terace") against the venue's items. */
export function resolveTerm(heard: string, items: Term[]): TermResolution {
  const said = words(heard).filter((w) => !GENERIC.has(w)).map(word);
  const name = heard.trim();
  if (!said.length) return { kind: 'none', heard: name };
  const exact = items.filter((i) => distinctive(i.label).join(' ') === said.join(' '));
  if (exact.length === 1) return { kind: 'one', item: exact[0]! };
  // Every word said is one of the item's words: "bar" fits Main Bar and Pool Bar.
  const containing = exact.length ? exact : items.filter((i) => said.every((w) => distinctive(i.label).includes(w)));
  if (containing.length === 1) return { kind: 'one', item: containing[0]! };
  if (containing.length > 1) return { kind: 'choice', heard: name, items: containing.slice(0, MAX_TERM_CHOICES) };
  // Close in sound or spelling: always a question, never an answer.
  const close = items.filter((i) => said.every((w) => distinctive(i.label).some((x) => sounds(w, x))));
  return close.length ? { kind: 'choice', heard: name, items: close.slice(0, MAX_TERM_CHOICES) } : { kind: 'none', heard: name };
}

/**
 * The venue's items the caller's own words name: every distinctive word of the label said
 * ("terrace bar" names Terrace Bar, and not Terrace when Terrace Bar is also named); failing
 * that, any one of them ("the bar" names Main Bar and Pool Bar). Empty when none is said.
 */
export function mentionedIn(transcript: string, items: Term[]): Term[] {
  const said = new Set(words(transcript).map(word));
  const full = items.filter((i) => distinctive(i.label).every((w) => said.has(w)));
  if (full.length) {
    // The most specific: drop a label whose words are all inside another named label's.
    return full.filter((i) => !full.some((o) => o !== i && distinctive(o.label).length > distinctive(i.label).length && distinctive(i.label).every((w) => distinctive(o.label).includes(w))));
  }
  return items.filter((i) => distinctive(i.label).some((w) => said.has(w)));
}

// Service words only: "open" (an open shift), "close" and a bare "am" ("I am") say nothing about the period.
// Plus the code-mixed words callers use inside English: Tagalog gabi/umaga, Hindi/Urdu raat/subah.
const EVENING = ['evening', 'night', 'tonight', 'dinner', 'closing', 'late', 'supper', 'gabi', 'raat'];
const MORNING = ['morning', 'opening', 'breakfast', 'brunch', 'lunch', 'daytime', 'umaga', 'subah'];

/** "AM"/"PM" when the caller named a service period ("closing", "lunch"), null when none or both. */
export function periodSaid(transcript: string): 'AM' | 'PM' | null {
  const said = new Set(words(transcript));
  const pm = EVENING.some((w) => said.has(w));
  const am = MORNING.some((w) => said.has(w));
  return pm === am ? null : pm ? 'PM' : 'AM';
}
