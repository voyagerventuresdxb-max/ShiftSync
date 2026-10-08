import type { ParsedIntent } from '@/api/voice';

/**
 * Sentences and labels on the voice confirm sheet that state numbers or consequences, kept out of
 * the components so they can be checked word for word.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Whole days from `start` to `end`, both included (YYYY-MM-DD); null if either isn't a date or they're backwards. */
export function daysInclusive(start: string, end: string): number | null {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** "12 shifts will change and 8 people will be notified." — the publish card's sentence, stating both counts. */
export function publishSentence(counts: { shiftsChanging: number; peopleNotified: number }): string {
  const shifts = `${plural(counts.shiftsChanging, 'shift', 'shifts')} will change`;
  const people = counts.peopleNotified === 0 ? 'nobody will be notified' : `${plural(counts.peopleNotified, 'person', 'people')} will be notified`;
  return `${shifts} and ${people}.`;
}

/** The Confirm button's words: a publish says how many people it notifies; a cancellation says what it cancels. */
export function confirmLabel(intent: ParsedIntent): string {
  if (intent.intent === 'PUBLISH_ROTA' && intent.counts) {
    const n = intent.counts.peopleNotified;
    return n === 0 ? 'Confirm: publish (nobody to notify)' : `Confirm: publish and notify ${plural(n, 'person', 'people')}`;
  }
  if (intent.intent === 'CANCEL_SHIFT') return 'Confirm: cancel this shift';
  return 'Confirm';
}

/** Only an in-app route ("/people"), never another site ("//evil.example", "/\\evil.example", "https://…"). */
export function isAppPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}
