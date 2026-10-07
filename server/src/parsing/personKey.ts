import { isRoleTitle, nameKey } from './resolveRows.js';

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

/** Column and row headings ("NAME", "TITLE", "Staff", "Day of the week"). */
const HEADER_WORD = /^(names?|full names?|staff( names?| members?)?|employees?( names?)?|team( members?)?|title|job title|roles?|positions?|designations?|grades?|dept|department|date|dates|days?|day of the week|events?|shifts?)$/i;
/** Totals and counts ("Total staff on rota", "Headcount", "Number of staff"). */
const SUMMARY_LINE = /^(totals?|sub ?totals?|grand totals?|sum|count|head ?count|number of|no\.? of|hours)\b/i;
/** Footers, signatures and notes ("Prepared by", "Printed on", "Page 1 of 2", "Notes"). */
const NOTE_LINE = /^(prepared|approved|printed|signed|signature|checked|authori[sz]ed|legend|key|page|notes?|remarks?|comments?)\b/i;
/** Captions that describe the day, not a person (a covers count, events). */
const CAPTION_LINE = /^(covers?|pax|events?|functions?|bookings?|reservations?|forecast|occupancy)\b/i;

/** A total or count line, a footer, signature or note ("Total staff on rota", "Prepared by: …", "Page 1 of 2"). */
export function isFooterTotalOrNote(label: string): boolean {
  const s = label.trim().replace(/\s+/g, ' ');
  return SUMMARY_LINE.test(s) || NOTE_LINE.test(s) || /\bpage \d+ of \d+\b/i.test(s) || /:\s*\S/.test(s) || /_{3,}/.test(s);
}

/** A column heading over the names ("NAME", "Staff", "Employee") or over the titles ("TITLE", "Role", "Position"). */
export function columnHeading(label: string): 'name' | 'title' | null {
  const s = label.trim().replace(/\s+/g, ' ');
  if (/^(names?|full names?|staff( names?)?|employees?( names?)?|team members?)$/i.test(s)) return 'name';
  if (/^(titles?|job titles?|roles?|positions?|designations?|grades?)$/i.test(s)) return 'title';
  return null;
}

/**
 * Why a row label is not a person, or null when it may be one. Every reader asks this before
 * listing someone: a role or title ("Waiter 3", "RM", "Ops Manager"), a column or section
 * heading, a total or count line, a footer, signature or note, a caption, or a bare number is
 * never imported as a person.
 */
export function nonPersonReason(label: string): string | null {
  const s = label.trim().replace(/\s+/g, ' ');
  if (!s) return 'blank';
  if (/^\d+([.,]\d+)?$/.test(s)) return 'a count, not a name';
  if (HEADER_WORD.test(s)) return 'a heading, not a name';
  if (SUMMARY_LINE.test(s)) return 'a total or count line, not a person';
  if (NOTE_LINE.test(s) || /\bpage \d+ of \d+\b/i.test(s) || /:\s*\S/.test(s) || /_{3,}/.test(s)) return 'a footer or note, not a person';
  if (CAPTION_LINE.test(s)) return 'a caption, not a person';
  if (isRoleTitle(s)) return 'a title or role, not a name';
  return null;
}
