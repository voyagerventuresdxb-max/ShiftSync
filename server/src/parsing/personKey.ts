import { nameKey } from './resolveRows.js';

/**
 * Groups every shift of one person within one file: the normalized name plus the page and row
 * the person was first read on, so two different people sharing a name stay apart.
 */
export function personKeyOf(name: string, page: number | null, row: number | null): string {
  return `${nameKey(name)}@${page ?? 0}:${row ?? 0}`;
}

/**
 * True when a label reads like a person's name: one to five words of letters (any script),
 * apostrophes, hyphens or dots — no digits, no colon, not overly long.
 */
export function looksLikePersonName(label: string): boolean {
  const s = label.trim();
  if (s.length < 2 || s.length > 40 || /[\d:@#=]/.test(s)) return false;
  const words = s.split(/\s+/);
  return words.length <= 5 && words.every((w) => /^[\p{L}][\p{L}'’.\-]*$/u.test(w));
}
