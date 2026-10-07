import { isRoleTitle, nameKey } from './resolveRows.js';

/**
 * Groups every shift of one person within one file: the normalized name plus the page and row
 * the person was first read on, so two different people sharing a name stay apart.
 */
export function personKeyOf(name: string, page: number | null, row: number | null): string {
  return `${nameKey(name)}@${page ?? 0}:${row ?? 0}`;
}

/** A piece a text layer cuts out of a word at a ligature glyph: ff, fi, fl, ffi, ffl, ft, st. */
const LIGATURE_PIECE = /^(ffi|ffl|ff|fi|fl|ft|st)$/;

/**
 * A word a text layer split at its ligature, put back together: the ligature piece standing on
 * its own between spaces ("O ffi ce use only", "Veri fi ed by", "Sa ffi ya", "fi nal copy") joins
 * the letters around it. Only a lone lower-case ligature piece is joined, so two real words
 * ("Ana Stewart", "St John") are never run together.
 */
export function joinLigatureSplits(text: string): string {
  return joinCutWords(joinLonePieces(text));
}

/**
 * A word cut just after its ligature, the glyph kept with the letters before it ("Offi cial",
 * "Griffi n", "Tiff any", "Duff y"): joined, unless what follows is a name particle ("Jeff de").
 */
function joinCutWords(text: string): string {
  return text.replace(/(\p{L})(ffi|ffl|ff|fi|fl) (\p{Ll}+)(?![\p{L}])/gu, (m, a: string, lig: string, rest: string) =>
    NAME_PARTICLE.test(rest) && rest !== 'y' && rest !== 'e' ? m : `${a}${lig}${rest}`,
  );
}

/** A lone ligature piece between spaces, glued to the letters around it. */
function joinLonePieces(text: string): string {
  if (!/\s(ffi|ffl|ff|fi|fl|ft|st)\s|\s(ffi|ffl|ff|fi|fl|ft|st)$|^(ffi|ffl|ff|fi|fl|ft|st)\s/.test(text)) return text;
  const tokens = text.split(/(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!LIGATURE_PIECE.test(t)) {
      out.push(t);
      continue;
    }
    // Glue to the word before (when it ends in a letter) and to the word after (when it starts lower-case).
    const prev = out.length >= 2 ? out[out.length - 2]! : null;
    if (prev !== null && /\p{L}$/u.test(prev) && /^\s+$/.test(out[out.length - 1]!)) {
      out.pop();
      out[out.length - 1] = `${prev}${t}`;
    } else out.push(t);
    const next = tokens[i + 2];
    if (next !== undefined && /^\s+$/.test(tokens[i + 1] ?? '') && /^\p{Ll}/u.test(next)) {
      out[out.length - 1] = `${out[out.length - 1]}${next}`;
      i += 2;
    }
  }
  return out.join('');
}

/**
 * True when a label reads like a person's name: one to five words of letters (any script),
 * apostrophes, hyphens or dots — no digits, no colon, not overly long.
 */
export function looksLikePersonName(label: string): boolean {
  const s = joinLigatureSplits(label.trim());
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

/**
 * The shape of a label or a line on a form, never of a name: a label ending in a colon ("Date:",
 * "Manager on duty:"), a label ending in "by" ("Checked by", "Approved by:"), a blank to fill
 * in ("____", "........", "……").
 */
const FORM_LABEL = /:\s*$|\bby\s*:?\s*$|_{2,}|\.{4,}|…{2,}/i;

/** A total or count line, a footer, signature or note ("Total staff on rota", "Prepared by: …", "Page 1 of 2"). */
export function isFooterTotalOrNote(label: string): boolean {
  const s = joinLigatureSplits(label.trim().replace(/\s+/g, ' '));
  return SUMMARY_LINE.test(s) || NOTE_LINE.test(s) || /\bpage \d+ of \d+\b/i.test(s) || /:\s*\S/.test(s) || /_{3,}/.test(s) || FORM_LABEL.test(s);
}

/**
 * A line that reads as a label, a form line or a footer rather than as anyone's row: the shapes
 * above, "<word>ed by / on / at" ("Verified by", "Updated on 12/04"), "Page 2 of 3", or a total,
 * footer or note line. Asked only of rows with no shift, time or leave in any day: a name may
 * end in "-ed" ("Ahmed", "Saeed").
 */
export function isLabelLine(text: string): boolean {
  const s = joinLigatureSplits(text.trim().replace(/\s+/g, ' '));
  if (!s) return false;
  return /^\p{L}+ed\s+(by|on|at)\b/iu.test(s) || /\bpage\s+\d+\s*(of|\/)\s*\d+\b/i.test(s) || FOOTER_SIGNAL.test(s) || isFooterTotalOrNote(s);
}

/**
 * Words footers, sign-offs and office notes carry ("Office use only", "Final copy", "Internal",
 * "Confidential", "Checked", "Verified", "Remarks"): a sign only on a row with no shift, time or
 * leave in any day.
 */
const FOOTER_SIGNAL = /\b(office use|for office|final copy|internal|confidential|approved|checked|verified|certified|prepared|issued|remarks?|notes?|draft|do not)\b/i;

/** Words a footer or a printed-by line carries anywhere ("Rota issued 10/04 by Operations", "Generated by … confidential"). */
const FOOTER_WORD = /\b(issued|generated|created|printed|updated|revised|confidential|version|prepared|approved|signature|copyright)\b|©/i;
/** A date or a version number inside a line ("10/04/2026", "v3.2"): a person's name never carries one. */
const DATE_OR_VERSION = /\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b|\b(19|20)\d{2}\b|\bv?\d+\.\d+\b/i;

const INDEX_MARK = new Set(['#', 'no', 'no.', 'nos', 'nos.', 'nr', 'nr.', 'num', 'number', 's/n', 'sn', 's.no', 's.no.', 'sno', 'sr', 'sr.', 'sl', 'sl.', 'id', 'ref', 'ref.', 'code']);
const INDEX_OWNER = new Set(['emp', 'emp.', 'employee', 'staff', 'serial', 'payroll', 'badge', 'personnel', 'clock', 'card', 'file', 'hr']);
const NAME_CORE = new Set(['name', 'names', 'surname', 'surnames', 'staff', 'employee', 'employees', 'member', 'members', 'associate', 'associates', 'colleague', 'colleagues']);
const NAME_WORD = new Set([...NAME_CORE, 'full', 'first', 'last', 'given', 'family', 'emp', 'emp.', 'team', 'of', 'the', 'and']);
const TITLE_CORE = new Set(['title', 'titles', 'job', 'role', 'roles', 'position', 'positions', 'pos', 'pos.', 'designation', 'designations', 'desig', 'desig.', 'grade', 'grades', 'rank', 'occupation']);
const TITLE_WORD = new Set([...TITLE_CORE, 'of', 'the', 'and']);
const OTHER_WORD = new Set(['total', 'totals', 'hours', 'hrs', 'signature', 'signatures', 'sign', 'note', 'notes', 'remark', 'remarks', 'comment', 'comments', 'dept', 'dept.', 'department', 'departments', 'section', 'sections', 'contract', 'ot']);

/**
 * A column heading: over the names ("NAME", "Staff", "Employee full name"), over the titles
 * ("TITLE", "Job title", "Role / Position"), over an index or number column ("#", "No.", "S/N",
 * "Emp ID"), or over another column that is neither ("TOTAL", "Signature", "Dept"). Read word by
 * word, so any wording made of those words counts.
 */
export function columnHeading(label: string): 'name' | 'title' | 'index' | 'other' | null {
  const tokens = label
    .trim()
    .toLowerCase()
    .replace(/\s+\/\s+/g, ' ')
    .split(/[\s,&+|]+/)
    .flatMap((t) => (t === 's/n' ? [t] : t.split('/')))
    .map((t) => t.replace(/:$/, ''))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const all = (set: Set<string>) => tokens.every((t) => set.has(t));
  const some = (set: Set<string>) => tokens.some((t) => set.has(t));
  if (tokens.every((t) => INDEX_MARK.has(t) || INDEX_OWNER.has(t)) && some(INDEX_MARK)) return 'index';
  if (all(NAME_WORD) && some(NAME_CORE)) return 'name';
  if (all(TITLE_WORD) && some(TITLE_CORE)) return 'title';
  if (all(OTHER_WORD)) return 'other';
  return null;
}

/** One word of a heading line ("STAFF NAME", "# EMPLOYEE", "Name / Position", "No. Name Title"). */
const HEADING_TOKEN = /^(#|no\.?|s\/n|sn|sr\.?|sl\.?|id|ref|names?|full|first|last|surnames?|staff|employees?|emp\.?|team|members?|titles?|job|roles?|positions?|designations?|grades?|dept\.?|departments?|sections?|totals?|hours|hrs|signatures?|date|dates|days?|of|the|week|shifts?|notes?|remarks?)$/i;
/** A heading line: two or more words, every one of them a heading word. */
function isHeadingLine(s: string): boolean {
  const tokens = s.replace(/\s+\/\s+/g, ' ').split(/[\s|,&+]+/).filter(Boolean);
  const heading = (t: string) => HEADING_TOKEN.test(t) || (t.includes('/') && t.split('/').every((p) => p.length > 1 && HEADING_TOKEN.test(p)));
  return tokens.length >= 2 && tokens.every(heading);
}

/** Department, area and section words ("BAR", "HOSTS", "MANAGEMENT", "TERRACE", "Front of house", "Kitchen team"). */
const SECTION_WORD = /^(bar|bars|floor|service|kitchen|pastry|reception|door|valet|security|stewarding|housekeeping|cleaning|cashiers?|management|admin(istration)?|operations|front of house|back of house|foh|boh|f ?& ?b|hosts|hostesses|runners|bussers|servers|waiters|waitresses|bartenders|barbacks|baristas|sommeliers|chefs|cooks|supervisors|managers|captains|trainees|interns|casuals|relief|terrace|lounge|pool|beach|rooftop|garden|patio|main dining|private dining|banquets?|outlet)( (team|staff|crew|section|department|dept))?$/i;

/**
 * A department or section banner rather than a person: a department word ("BAR", "Kitchen
 * team", "FOH") or a role in the plural ("HOSTS", "Senior Servers").
 */
export function isSectionLabel(label: string): boolean {
  const s = label.trim().replace(/\s+/g, ' ');
  if (!s) return false;
  if (SECTION_WORD.test(s)) return true;
  // A group named as such ("FLOOR AND BAR SERVICE TEAM", "Night crew").
  if (/\s(team|staff|crew|squad|section|department|dept|group)$/i.test(s)) return true;
  // "HOSTS" -> "Host"; a short word is left alone ("James" is not "JAM" in the plural).
  const singular = s.replace(/(?<=\p{L}{4})s$/iu, '');
  const singularEs = s.replace(/(?<=\p{L}{4}(?:ss|sh|ch))es$/iu, '');
  return (singular !== s && isRoleTitle(singular)) || (singularEs !== s && isRoleTitle(singularEs));
}

/** The reason nonPersonReason gives for a name that couldn't be read ("[?]", "?", "…", "xxx"). */
export const UNREADABLE_NAME = 'an unreadable name';

/** A name placeholder rather than a name: no letters at all ("[?]", "?", "…", "-"; a number is a count), or "xxx", "unknown", "illegible", "TBC". */
export function isUnreadableName(label: string): boolean {
  const s = label.trim();
  if (/^\d+([.,]\d+)?$/.test(s)) return false;
  return !/\p{L}/u.test(s) ||/^\[?\s*(x{2,}|unknown|illegible|unreadable|unclear|n\/?a|tbc|tba|tbd|name)\s*\]?$/i.test(s) || /^\[.*\?.*\]$/.test(s);
}

/**
 * Why a row label is not a person, or null when it may be one. Every reader asks this before
 * listing someone: a role or title ("Waiter 3", "RM", "Ops Manager"), a column or section
 * heading ("NAME TITLE", "BAR"), a total or count line, a footer, signature or note, a
 * caption, a bare number, or a name that couldn't be read ("[?]") is never imported as a person.
 */
/** Particles a name may carry in lower case ("de la Paz", "van der Berg", "bin Rashed"). */
const NAME_PARTICLE = /^(de|da|das|dos|do|di|dei|degli|del|della|du|la|le|van|von|der|den|ter|ten|zu|zum|al|el|bin|binti|bint|ibn|ap|af|y|e|mac|st|[dlo]['’]\p{L}+)$/u;
/** Words a footer, an office note or a label carries, never a name ("Official copy – for staff only", "Final version"). */
const NON_NAME_WORD = /^(only|copy|check|daily|final|version|official|use|staff|for|by|approved|verified|printed|total|note|notes)$/i;

/**
 * Why a label can't be a name on its own shape: brackets, digits, a dash between lower-case
 * words ("fluid – check daily"), a word a footer or label uses, a lower-case word that is not a
 * name particle, or more than five words. Checked on the label as printed and with its ligature
 * splits joined, so a split ("O ffi cial copy") never hides it.
 */
function notNameShape(label: string): string | null {
  const joined = joinLigatureSplits(label);
  const wordsOf = (s: string) => s.split(/\s+/).map((w) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')).filter(Boolean);
  if (/[()[\]{}]/.test(joined) || /\d/.test(joined)) return 'a note or a label, not a name';
  if (/\p{Ll}\s*[–—]\s*\p{L}|\p{Ll}\s+-\s+\p{L}/u.test(joined)) return 'a note or a label, not a name';
  const words = wordsOf(joined);
  if (words.length > 5) return 'a line of text, not a name';
  // A footer's words, as printed or with its ligature splits joined ("sta ff only" is "staff only").
  if ([...words, ...wordsOf(label)].some((w) => NON_NAME_WORD.test(w))) return 'a note or a label, not a name';
  if (words.some((w) => /^\p{Ll}/u.test(w) && !NAME_PARTICLE.test(w))) return 'a note or a label, not a name';
  return null;
}

export function nonPersonReason(label: string): string | null {
  const s = joinLigatureSplits(label.trim().replace(/\s+/g, ' '));
  if (!s) return 'blank';
  if (/^\d+([.,]\d+)?$/.test(s)) return 'a count, not a name';
  if (isUnreadableName(s)) return UNREADABLE_NAME;
  if (HEADER_WORD.test(s) || isHeadingLine(s) || columnHeading(s)) return 'a heading, not a name';
  if (SUMMARY_LINE.test(s)) return 'a total or count line, not a person';
  if (NOTE_LINE.test(s) || /\bpage \d+ of \d+\b/i.test(s) || /:\s*\S/.test(s) || /_{3,}/.test(s) || FORM_LABEL.test(s)) return 'a footer or note, not a person';
  if (FOOTER_WORD.test(s) || DATE_OR_VERSION.test(s)) return 'a footer or note, not a person';
  if (CAPTION_LINE.test(s)) return 'a caption, not a person';
  if (isSectionLabel(s)) return 'a section heading, not a name';
  if (isRoleTitle(s)) return 'a title or role, not a name';
  return notNameShape(label.trim().replace(/\s+/g, ' '));
}

/** A title in a combined cell: a known role or banner word, an abbreviation ("RM"), or a numbered title ("Waiter 3"). */
const titleish = (t: string) => isRoleTitle(t) || isSectionLabel(t) || /^[A-Z]{2,5}$/.test(t) || /[A-Za-z].*\d/.test(t);
/** A name in a combined cell: words of letters that are not a title. */
const nameish = (t: string) => looksLikePersonName(t) && !titleish(t);

/** The two sides of a cell that holds a name and a title: "A / B", "A - B", "A | B", "A (B)", "A/B". */
function combinedParts(label: string): [string, string] | null {
  const s = label.trim().replace(/\s+/g, ' ');
  const m = s.match(/^(.+?)\s+[/|–—-]\s+(.+)$/) ?? s.match(/^(.+?)\s*\(([^()]+)\)$/) ?? s.match(/^([^/\d]+?)\/([^/\d]+)$/);
  if (!m) return null;
  const a = m[1]!.trim();
  const b = m[2]!.trim();
  return a && b ? [a, b] : null;
}

/**
 * How a column (or a page of names) writes name and title in one cell, decided from all of its
 * cells: 'name-first' ("Ana Silva / Waiter"), 'title-first' ("Waiter / Ana Silva"), or null when
 * fewer than three cells, or under half of them, are written that way. The title side is the one
 * whose values read as titles or repeat from row to row; then even a title no vocabulary knows
 * ("Sommelier") is split off.
 */
export function combinedLabelOrder(labels: string[]): 'name-first' | 'title-first' | null {
  const filled = labels.map((l) => l.trim()).filter(Boolean);
  const parts = filled.map(combinedParts).filter((p): p is [string, string] => p !== null);
  if (parts.length < 3 || parts.length < filled.length * 0.5) return null;
  const side = (k: 0 | 1) => {
    const values = parts.map((p) => p[k]);
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v.toLowerCase(), (counts.get(v.toLowerCase()) ?? 0) + 1);
    const repeats = values.filter((v) => counts.get(v.toLowerCase())! > 1).length;
    return values.filter(titleish).length + repeats - values.filter(nameish).length;
  };
  const [a, b] = [side(0), side(1)];
  if (a === b) return null;
  return b > a ? 'name-first' : 'title-first';
}

/**
 * The name and the title of a cell that holds both ("Ana Silva / Waiter", "Ana Silva (RM)",
 * "Waiter 3 - Ana Silva"), or null. With the column's own order (combinedLabelOrder) any title
 * splits off; without it, one side must read as a name and the other as a title.
 */
export function splitNameTitle(label: string, order: 'name-first' | 'title-first' | null = null): { name: string; title: string } | null {
  const parts = combinedParts(label);
  if (!parts) return null;
  const [a, b] = parts;
  if (order === 'name-first') return looksLikePersonName(a) && !titleish(a) ? { name: a, title: b } : null;
  if (order === 'title-first') return looksLikePersonName(b) && !titleish(b) ? { name: b, title: a } : null;
  if (nameish(a) && titleish(b)) return { name: a, title: b };
  if (nameish(b) && titleish(a)) return { name: b, title: a };
  return null;
}
