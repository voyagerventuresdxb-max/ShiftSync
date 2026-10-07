/**
 * Reading a roster with two independent readers and never losing anyone between them.
 *
 *  - aiReadRoster: the AI reader (visionProvider.ts) transcribes the file. Multi-page files are
 *    read one page per call, all calls in parallel, so the wall time is that of the slowest
 *    page. Self-consistency: a page that comes back with fewer people than were counted on it
 *    (by the model itself, or by the table reader), a page missing from the answer, or an
 *    answer cut off at the output cap, is read once more with a stricter, page-focused prompt
 *    (a cut-off single page in two halves). Whatever stays unread is reported, never dropped.
 *    Every call has its own deadline inside the upload's time budget.
 *  - reconcileReadings: the AI reading is primary and the table reader (text-layer PDFs,
 *    spreadsheets) cross-checks it, person by person and shift by shift. A person or shift
 *    only one reader found is kept and flagged (ai_only / table_only); times that differ keep
 *    the AI's and carry both readings (times_differ). Every disagreement is counted.
 * Logs carry counts only — never names or cell text.
 */
import { mapReadingAnswer, type AiReadingContext } from './aiReading.js';
import { isUnreadableName, nonPersonReason, personKeyOf, UNREADABLE_NAME } from './personKey.js';
import { isRoleTitle } from './resolveRows.js';
import { VisionProviderError, type VisionInput, type VisionOutput, type VisionProvider } from './visionProvider.js';
import { isReadingAnswer, type ReadingAnswer, type ReadingAnswerPage } from './vlmPrompt.js';
import type { ReadPerson, RowFlag, ShiftAlternative, UnreadRow, WeekDetection } from './rosterContract.js';
import type { AnomalyRecord, LeaveRecord, ParsedShiftRow, ParsedVisionResult } from './types.js';

/** Re-reads are not started with less than this left of the upload's time budget. */
const MIN_REREAD_MS = 15_000;

export type AiReadSource =
  | { kind: 'file'; data: Buffer; mimeType: string; name: string; pageCount: number; pageTexts?: string[] }
  | { kind: 'grid'; text: string; name: string };

export interface AiReadOptions {
  provider: VisionProvider;
  locationId: string | null;
  userId: string | null;
  /** Latest moment (epoch ms) any call may still run. */
  deadline: number;
  /** People the table reader found on each page, when there is a table reader. */
  tablePeoplePerPage?: Map<number, number>;
}

export interface AiReadOutcome {
  /** The stitched transcription (pages in order). */
  answer: ReadingAnswer;
  calls: number;
  rereadPages: number[];
  /** Pages no call managed to read. */
  missingPages: number[];
  /** Pages that still hold fewer people than were counted on them. */
  shortPages: { page: number; expected: number; read: number }[];
  /** Every page read and none short. */
  complete: boolean;
  /**
   * Safe to keep for a re-import of the same file: every page read, and any page still short was
   * already read a second time (asking again would give the same reading and bill again).
   */
  cacheable: boolean;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const normName = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
/** A name with every space removed: "Sa ffi ya" (a text layer split at a ligature) and "Saffiya" are one name. */
const joinedKey = (s: string) => normName(s).replace(/ /g, '');
/** The spelling kept when two readers read one person: the file's own text (the table reader's), unless it only differs by stray spaces inside words — then the joined one. */
const keptSpelling = (table: string, ai: string) => (table !== ai && joinedKey(table) === joinedKey(ai) && ai.split(/\s+/).length < table.split(/\s+/).length ? ai : table);
/**
 * What one reader glued onto a name the other read alone, when it is the person's title or row
 * number printed in the next column: "Lakshmi Shevchenko RM" vs "Lakshmi Shevchenko", "1 Marites
 * Horvat" vs "Marites Horvat", "Head waiter 1 Dalia Gurung" vs "Dalia Gurung". A plain role
 * word counts only when the other reader read it as this person's title ("Mark Cook" is a
 * name); an abbreviation ("RM", "AGM") or a numbered title ("Waiter 3") always counts. Null
 * when the longer name is not the shorter plus such a remainder.
 */
export function gluedTitle(longer: string, shorter: string, shorterRole: string | null): string | null {
  const l = longer.trim().replace(/\s+/g, ' ');
  const sh = shorter.trim().replace(/\s+/g, ' ');
  if (!sh || l.length <= sh.length) return null;
  const lower = l.toLowerCase();
  const short = sh.toLowerCase();
  const rest = lower.startsWith(short + ' ') ? l.slice(sh.length + 1) : lower.endsWith(' ' + short) ? l.slice(0, l.length - sh.length - 1) : null;
  if (!rest) return null;
  const r = rest.replace(/^[\s|/,\-–—(]+|[\s|/,\-–—)]+$/g, '');
  if (!r) return null;
  if (/^#?\d{1,4}[.)]?$/.test(r)) return r;
  // The other reader read it as this person's title: whatever the title is ("Ana Silva / Sommelier").
  const sameAsRole = shorterRole !== null && normName(shorterRole) === normName(r);
  if (sameAsRole) return r;
  if (!isRoleTitle(r)) return null;
  return /^[A-Z]{2,5}$/.test(r) || /\d/.test(r) || r.split(' ').length > 1 ? r : null;
}

/**
 * The days on which two readings of one person disagree because one of them put the cells a day
 * or two off: a day's times in one reading are another (disagreeing) day's times in the other,
 * within two days. Every day of such a pair is returned.
 */
export function shiftedDays(a: ParsedShiftRow[], b: ParsedShiftRow[]): Set<string> {
  const timesOn = (rows: ParsedShiftRow[]) => {
    const by = new Map<string, string[]>();
    for (const r of rows) by.set(r.date, [...(by.get(r.date) ?? []), segKey(r)]);
    return new Map([...by].map(([d, keys]) => [d, keys.sort().join(',')]));
  };
  const [ta, tb] = [timesOn(a), timesOn(b)];
  const dates = [...new Set([...ta.keys(), ...tb.keys()])];
  const differ = dates.filter((d) => (ta.get(d) ?? '') !== (tb.get(d) ?? ''));
  const dayNo = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  const out = new Set<string>();
  for (const d of differ) {
    for (const e of differ) {
      if (d === e || Math.abs(dayNo(d) - dayNo(e)) > 2) continue;
      const x = ta.get(d);
      if (x && x === tb.get(e)) {
        out.add(d);
        out.add(e);
      }
    }
  }
  return out;
}

const peopleOn = (page: ReadingAnswerPage) => (page.sec ?? []).reduce((n, s) => n + (s.ppl?.length ?? 0), 0);

/** Union of two readings of one page: the fuller one, plus anyone only the other has. */
function mergePage(a: ReadingAnswerPage, b: ReadingAnswerPage): ReadingAnswerPage {
  const [base, other] = peopleOn(a) >= peopleOn(b) ? [a, b] : [b, a];
  const names = new Set(base.sec.flatMap((s) => s.ppl.map((p) => normName(p.nm))));
  const merged: ReadingAnswerPage = { ...base, rows: Math.max(a.rows ?? 0, b.rows ?? 0), sec: base.sec.map((s) => ({ ...s, ppl: [...s.ppl] })), unread: [...(base.unread ?? [])] };
  for (const sec of other.sec ?? []) {
    const missing = (sec.ppl ?? []).filter((p) => !names.has(normName(p.nm)));
    if (!missing.length) continue;
    const target = merged.sec.find((s) => (s.h ?? null) === (sec.h ?? null));
    if (target) target.ppl.push(...missing);
    else merged.sec.push({ h: sec.h, n: sec.n, ppl: missing });
    for (const p of missing) names.add(normName(p.nm));
  }
  for (const s of merged.sec) s.ppl.sort((x, y) => (x.i ?? 0) - (y.i ?? 0));
  return merged;
}

function parseAnswer(output: VisionOutput): ReadingAnswer | null {
  if (output.truncated) return null;
  try {
    const parsed: unknown = JSON.parse(output.raw);
    return isReadingAnswer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function aiReadRoster(source: AiReadSource, o: AiReadOptions): Promise<AiReadOutcome> {
  const pageCount = source.kind === 'file' ? Math.max(1, source.pageCount) : 1;
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let model = o.provider.model;
  let firstError: unknown = null;

  const call = async (focus?: VisionInput['focus'], strict = false): Promise<ReadingAnswer | 'incomplete' | null> => {
    const base = { originalFilename: source.name, locationId: o.locationId, userId: o.userId, deadline: o.deadline, ...(focus ? { focus } : {}), ...(strict ? { strict } : {}) };
    const input: VisionInput =
      source.kind === 'file'
        ? { ...base, kind: 'file', data: source.data, mimeType: source.mimeType, ...(source.pageTexts ? { pageTexts: source.pageTexts } : {}) }
        : { ...base, kind: 'grid', text: source.text };
    calls++;
    try {
      const output = await o.provider.readRoster(input);
      tokensIn += output.usage.promptTokens ?? 0;
      tokensOut += output.usage.outputTokens ?? 0;
      model = output.model;
      return parseAnswer(output) ?? 'incomplete';
    } catch (err) {
      if (!(err instanceof VisionProviderError)) throw err;
      firstError ??= err;
      return null;
    }
  };

  // Pass 1: the whole file in one call, or one call per page, all at once.
  const pages = new Map<number, ReadingAnswerPage>();
  let head: Pick<ReadingAnswer, 'title' | 'days' | 'key'> | null = null;
  /** Takes an answer's pages in. A focused answer counts only for its page, whatever it numbered it. */
  const absorb = (answer: ReadingAnswer, onlyPage?: number) => {
    if (!head || (answer.days?.length ?? 0) > head.days.length) head = { title: answer.title ?? null, days: answer.days ?? [], key: answer.key ?? [] };
    else if (!head.title && answer.title) head.title = answer.title;
    const list = answer.pages ?? [];
    const chosen = onlyPage !== undefined ? [list.find((pg) => pg.p === onlyPage) ?? list[0]].filter((pg): pg is ReadingAnswerPage => !!pg) : list;
    for (const page of chosen) {
      const p = onlyPage ?? page.p;
      if (p < 1 || p > pageCount) continue;
      const tagged = { ...page, p };
      pages.set(p, pages.has(p) ? mergePage(pages.get(p)!, tagged) : tagged);
    }
  };
  const truncatedSingle: boolean[] = [];
  if (pageCount === 1) {
    const answer = await call();
    if (answer && answer !== 'incomplete') absorb(answer, 1);
    else if (answer === 'incomplete') truncatedSingle.push(true);
  } else {
    const answers = await Promise.all(Array.from({ length: pageCount }, (_, i) => call({ page: i + 1 })));
    answers.forEach((a, i) => {
      if (a && a !== 'incomplete') absorb(a, i + 1);
    });
  }
  if (!head && !truncatedSingle.length && firstError) throw firstError;

  // Pass 2 (once): pages missing, short or cut off — read again, stricter and focused, in parallel.
  const expectedOn = (p: number) => {
    const page = pages.get(p);
    const own = page ? Math.max(page.rows ?? 0, (page.sec ?? []).reduce((n, s) => n + (s.n ?? 0), 0)) : 0;
    return Math.max(own, o.tablePeoplePerPage?.get(p) ?? 0);
  };
  const rereads: { page: number; rows?: { from: number; to: number | null } }[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const page = pages.get(p);
    if (!page) {
      if (pageCount === 1 && truncatedSingle.length) {
        // Cut off at the output cap: two halves of the page, each well inside the cap.
        const half = Math.max(1, Math.ceil((o.tablePeoplePerPage?.get(1) ?? 40) / 2));
        rereads.push({ page: 1, rows: { from: 1, to: half } }, { page: 1, rows: { from: half + 1, to: null } });
      } else rereads.push({ page: p });
    } else if (peopleOn(page) < expectedOn(p)) rereads.push({ page: p });
  }
  const rereadPages = [...new Set(rereads.map((r) => r.page))];
  if (rereads.length && o.deadline - Date.now() >= MIN_REREAD_MS) {
    const answers = await Promise.all(rereads.map((r) => call({ page: r.page, ...(r.rows ? { rows: r.rows } : {}) }, true)));
    answers.forEach((a, i) => {
      if (a && a !== 'incomplete') absorb(a, rereads[i]!.page);
    });
  } else if (rereads.length) {
    rereadPages.length = 0;
  }
  if (!head) {
    if (firstError) throw firstError;
    throw new VisionProviderError('The AI reader returned no usable answer.', 'failed');
  }

  const missingPages: number[] = [];
  const shortPages: AiReadOutcome['shortPages'] = [];
  for (let p = 1; p <= pageCount; p++) {
    const page = pages.get(p);
    if (!page) missingPages.push(p);
    else if (peopleOn(page) < expectedOn(p)) shortPages.push({ page: p, expected: expectedOn(p), read: peopleOn(page) });
  }
  const h = head as Pick<ReadingAnswer, 'title' | 'days' | 'key'>;
  const answer: ReadingAnswer = { title: h.title, days: h.days, key: h.key, pages: [...pages.values()].sort((a, b) => a.p - b.p) };
  console.log(
    `[roster-reading] AI read: ${calls} call(s), ${pages.size}/${pageCount} page(s), ${answer.pages.reduce((n, p) => n + peopleOn(p), 0)} people, ` +
      `re-read ${rereadPages.length} page(s), missing ${missingPages.length}, short ${shortPages.length}.`,
  );
  const reread = new Set(rereadPages);
  return {
    answer,
    calls,
    rereadPages,
    missingPages,
    shortPages,
    complete: !missingPages.length && !shortPages.length,
    cacheable: !missingPages.length && shortPages.every((s) => reread.has(s.page)),
    model,
    tokensIn,
    tokensOut,
  };
}

/**
 * Pages of a stored reading that hold fewer people than were counted on them (by the reading
 * itself, or by the table reader): what a reading kept in the cache still owes the manager.
 */
export function shortPagesOf(answer: ReadingAnswer, tablePeoplePerPage?: Map<number, number>): AiReadOutcome['shortPages'] {
  return answer.pages.flatMap((page) => {
    const expected = Math.max(page.rows ?? 0, (page.sec ?? []).reduce((n, s) => n + (s.n ?? 0), 0), tablePeoplePerPage?.get(page.p) ?? 0);
    const read = peopleOn(page);
    return read < expected ? [{ page: page.p, expected, read }] : [];
  });
}

/** The unread rows an incomplete AI read leaves behind (pages it never read, rows it never listed). */
export function incompleteReadRows(outcome: Pick<AiReadOutcome, 'missingPages' | 'shortPages'>): UnreadRow[] {
  return [
    ...outcome.missingPages.map((page) => ({ page, row: null, text: '', reason: `Page ${page} could not be read in time. Check it and add anyone missing.` })),
    ...outcome.shortPages.map((s) => ({
      page: s.page,
      row: null,
      text: '',
      reason: `${s.expected - s.read} person row(s) on page ${s.page} could not be read (${s.expected} counted, ${s.read} read). Check the page and add anyone missing.`,
    })),
  ];
}

/** The AI reading as rows, people, leave and flags. */
export function aiResult(outcome: AiReadOutcome, ctx: AiReadingContext): ParsedVisionResult {
  const result = mapReadingAnswer(outcome.answer, ctx);
  result.unreadRows = [...(result.unreadRows ?? []), ...incompleteReadRows(outcome)];
  return result;
}

// --- reconciliation ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** People of a reader that tracks none (long-format templates, text fallback): one per name, in order. */
export function peopleFromRows(rows: ParsedShiftRow[], leave: LeaveRecord[], readerSource: ReadPerson['readerSource']): ReadPerson[] {
  const seen = new Map<string, ReadPerson>();
  [...rows.map((r) => ({ name: r.employeeName, role: r.roleName, row: r.rowNumber })), ...leave.map((l) => ({ name: l.employeeName, role: '', row: 0 }))].forEach(({ name, role, row }) => {
    const key = normName(name);
    if (!key || seen.has(key)) return;
    seen.set(key, { personKey: personKeyOf(name, null, row || seen.size + 1), name, roleLabel: role || null, section: null, sourcePage: null, sourceRow: row || null, readerSource });
  });
  return [...seen.values()];
}

/**
 * Gives every row without a personKey the key of the one person read under the same name, so
 * the people list and the rows always agree (the review screen groups rows by personKey, and a
 * person whose key no row carries is listed as a person with no shifts).
 */
export function withPersonKeys(rows: ParsedShiftRow[], people: ReadPerson[]): ParsedShiftRow[] {
  const byName = new Map<string, string | null>();
  for (const p of people) {
    const key = normName(p.name);
    byName.set(key, byName.has(key) ? null : p.personKey);
  }
  return rows.map((r) => {
    if (r.personKey) return r;
    const personKey = byName.get(normName(r.employeeName));
    return personKey ? { ...r, personKey } : r;
  });
}

export interface Reconciled {
  result: ParsedVisionResult;
  /** Real conflicts between the readers, each flagged or shown to check. */
  disagreements: number;
  /**
   * Days (person and date) the AI cross-check read differently where the file's own text was
   * read for certain and was used: counted for the reading report, never flagged.
   */
  aiDiffCells: number;
}

const segKey = (r: { startTime: string; endTime: string }) => `${r.startTime}-${r.endTime}`;
const alt = (reader: 'ai' | 'table', r: ParsedShiftRow): ShiftAlternative => ({ reader, startTime: r.startTime, endTime: r.endTime, overnight: r.overnight });
const withFlag = (r: ParsedShiftRow, flag: RowFlag): ParsedShiftRow => ({ ...r, flags: [...new Set([...(r.flags ?? []), flag])] });
/** A table reading the AI read the same way: an inferred day or am / pm is confirmed, its "check" flag dropped. */
function confirmed(r: ParsedShiftRow): ParsedShiftRow {
  const { inferredDay, inferredTimes: _times, flags, ...rest } = r;
  const kept = (flags ?? []).filter((f) => !(f === 'low_confidence' && inferredDay));
  return kept.length ? { ...rest, flags: kept } : rest;
}

/**
 * Cross-checks the AI reading (primary) against the table reading. Either may be null (then the
 * other is returned as is). Where both read the same person and day, the table reader's values
 * win — names and times are the file's own text — and the AI's differing reading is kept as an
 * alternative, flagged for the manager. The AI still adds what the table reader missed (people,
 * days), flagged as AI-only.
 */
export function reconcileReadings(
  ai: ParsedVisionResult | null,
  table: ParsedVisionResult | null,
  opts: {
    /** Table people (personKey) on a row whose day placement was inferred: a cell longer than its column. */
    placementUncertain?: Set<string>;
  } = {},
): Reconciled {
  if (!ai || !table) return { result: (ai ?? table)!, disagreements: 0, aiDiffCells: 0 };
  let disagreements = 0;
  let aiDiffCells = 0;
  /** Per final name: the days the file's own text settled (an AI note on such a day is the AI's misreading). */
  const settled = new Map<string, Set<string>>();
  const aiPeople = ai.people ?? peopleFromRows(ai.rows, ai.leaveRecords, 'ai');
  const tablePeople = table.people ?? peopleFromRows(table.rows, table.leaveRecords, 'table');

  // Pair people: the same name first (spaces aside: a text layer can split a name at a
  // ligature, "Sa ffi ya"); then a near-miss spelling (a misread letter or two).
  const pairs = new Map<ReadPerson, ReadPerson>(); // ai -> table
  const usedTable = new Set<ReadPerson>();
  for (const a of aiPeople) {
    const t = tablePeople.find((x) => !usedTable.has(x) && normName(x.name) === normName(a.name)) ?? tablePeople.find((x) => !usedTable.has(x) && joinedKey(x.name) === joinedKey(a.name));
    if (t) {
      pairs.set(a, t);
      usedTable.add(t);
    }
  }
  // One reader glued the person's title or row number onto the name ("Lakshmi Shevchenko RM").
  const glued = new Map<ReadPerson, string>(); // ai -> the remainder
  for (const a of aiPeople) {
    if (pairs.has(a)) continue;
    for (const x of tablePeople) {
      if (usedTable.has(x)) continue;
      const rest = gluedTitle(x.name, a.name, a.roleLabel) ?? gluedTitle(a.name, x.name, x.roleLabel);
      if (rest === null) continue;
      pairs.set(a, x);
      usedTable.add(x);
      glued.set(a, rest);
      break;
    }
  }
  for (const a of aiPeople) {
    if (pairs.has(a)) continue;
    const n = normName(a.name);
    const candidates = tablePeople
      .filter((x) => !usedTable.has(x) && (a.sourcePage === null || x.sourcePage === null || x.sourcePage === a.sourcePage))
      .map((x) => ({ x, d: levenshtein(normName(x.name), n) }))
      .filter(({ x, d }) => d <= Math.max(1, Math.floor(Math.min(n.length, normName(x.name).length) * 0.2)))
      .sort((p, q) => p.d - q.d);
    if (candidates[0]) {
      pairs.set(a, candidates[0].x);
      usedTable.add(candidates[0].x);
      disagreements++;
    }
  }

  const people: ReadPerson[] = [];
  const rows: ParsedShiftRow[] = [];
  const leaveRecords: LeaveRecord[] = [];
  const anomalies: AnomalyRecord[] = [];
  const nameMap = new Map<string, string>(); // any reader's name -> final name
  const rowsOf = (result: ParsedVisionResult, p: ReadPerson) =>
    result.rows.filter((r) => (r.personKey ? r.personKey === p.personKey : normName(r.employeeName) === normName(p.name)));
  const leaveOf = (result: ParsedVisionResult, p: ReadPerson) => result.leaveRecords.filter((l) => normName(l.employeeName) === normName(p.name));

  // A label only one reader took for a person, that reads as a title, heading, total or footer
  // ("Waiter 3", "TITLE", "Total staff on rota"), is never imported: it's shown as an unread row.
  const refused = new Set<string>();
  const refuse = (p: ReadPerson, reason: string, reader: string) => {
    disagreements++;
    refused.add(normName(p.name));
    refusedRows.push({
      page: p.sourcePage,
      row: p.sourceRow,
      text: p.name,
      reason:
        reason === UNREADABLE_NAME
          ? "A row whose name couldn't be read. Add the person and their shifts by hand if it is one."
          : `Only the ${reader} listed "${p.name}" as a person, and it reads as ${reason}. Not imported; add the person by hand if it is one.`,
    });
  };
  const refusedRows: UnreadRow[] = [];

  for (const a of aiPeople) {
    const t = pairs.get(a);
    // A name that couldn't be read ("[?]") is never a person, whoever read it.
    const aiOnlyReason = isUnreadableName(a.name) ? UNREADABLE_NAME : t ? null : nonPersonReason(a.name);
    if (aiOnlyReason) {
      refuse(a, aiOnlyReason, 'AI reader');
      continue;
    }
    const gluedRest = glued.get(a);
    const name = gluedRest !== undefined ? (a.name.length < t!.name.length ? a.name : t!.name) : t ? keptSpelling(t.name, a.name) : a.name;
    const gluedRole = gluedRest !== undefined && !/^#?\d/.test(gluedRest) ? gluedRest : null;
    const person: ReadPerson = {
      personKey: t?.personKey ?? a.personKey,
      name,
      // A title glued onto the name is this person's own title: more specific than a section heading.
      roleLabel: gluedRole ?? a.roleLabel ?? t?.roleLabel ?? null,
      section: a.section ?? t?.section ?? null,
      sourcePage: t?.sourcePage ?? a.sourcePage,
      sourceRow: t?.sourceRow ?? a.sourceRow,
      readerSource: t ? 'both' : 'ai',
      ...(t && t.name !== a.name && gluedRest === undefined ? { nameAlternatives: [name === t.name ? { reader: 'ai' as const, name: a.name } : { reader: 'table' as const, name: t.name }] } : {}),
    };
    people.push(person);
    nameMap.set(a.name, name);
    if (t) nameMap.set(t.name, name);
    const fix = (r: ParsedShiftRow): ParsedShiftRow => ({ ...r, employeeName: name, personKey: person.personKey, section: person.section, sourcePage: person.sourcePage, ...(gluedRole ? { roleName: gluedRole } : {}) });
    const aiRows = rowsOf(ai, a).map(fix);
    if (!t) {
      disagreements++;
      rows.push(...aiRows.map((r) => withFlag({ ...r, readerSource: 'ai' }, 'ai_only')));
      leaveRecords.push(...leaveOf(ai, a).map((l) => ({ ...l, employeeName: name })));
      continue;
    }
    const tableRows = rowsOf(table, t).map(fix);
    const dates = [...new Set([...aiRows, ...tableRows].map((r) => r.date))].sort();
    // Where the table reader read a day from the file's own text for certain (the text sits in
    // its day's column and its times need no guess), that day stands whatever the AI read: an AI
    // difference there is a misreading of text the file prints exactly. It is counted for the
    // reading report, never flagged. A real conflict is flagged: a day the table reader had to
    // infer (a cell running on past its column, an am / pm left out) that the AI read otherwise,
    // the same times put on different days with no certain reading, or a shift only the AI saw.
    const uncertainPerson = opts.placementUncertain?.has(t.personKey) ?? false;
    const certain = (day: ParsedShiftRow[]) => !uncertainPerson && day.length > 0 && day.every((r) => !r.inferredDay && !r.inferredTimes);
    const tableOn = (date: string) => tableRows.filter((r) => r.date === date).sort((x, y) => x.startTime.localeCompare(y.startTime));
    const leaveRead = new Map(leaveOf(table, t).map((l) => [l.date, l]));
    const settledDates = new Set<string>();
    settled.set(name, settledDates);
    const dayKey = (day: ParsedShiftRow[]) => day.map(segKey).sort().join(',');
    const dayNo = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    /** The table reader's day (within two days) holding the times the AI read on `date`. */
    const tableDayOf = (aDay: ParsedShiftRow[], date: string) =>
      [...new Set(tableRows.map((r) => r.date))].find((d) => d !== date && Math.abs(dayNo(d) - dayNo(date)) <= 2 && dayKey(tableOn(d)) === dayKey(aDay));
    // The same times on different days: one reader put a row's cells a day or two off.
    const shiftedAll = shiftedDays(tableRows, aiRows);
    const said = (day: ParsedShiftRow[]) => day.map((r) => `${r.startTime}–${r.endTime}`).join(' · ') || 'nothing';
    for (const date of dates) {
      const aDay = aiRows.filter((r) => r.date === date).sort((x, y) => x.startTime.localeCompare(y.startTime));
      const tDay = tableOn(date);
      if (dayKey(aDay) === dayKey(tDay)) {
        // Both readers read this day the same way: a day the table reader inferred is confirmed.
        settledDates.add(date);
        rows.push(...tDay.map((r) => confirmed({ ...r, readerSource: 'both', roleName: r.roleName || aDay[0]?.roleName || '' })));
        continue;
      }
      const leave = leaveRead.get(date);
      const fromCertainDay = !tDay.length && shiftedAll.has(date) && certain(tableOn(tableDayOf(aDay, date) ?? ''));
      if (certain(tDay) || (!tDay.length && leave && !leave.inferredDay && !uncertainPerson) || fromCertainDay) {
        // The file's own text settles this day: it stands, and the AI's other reading is only counted.
        settledDates.add(date);
        aiDiffCells++;
        rows.push(...tDay.map((r) => ({ ...r, readerSource: aDay.length ? ('both' as const) : ('table' as const) })));
        continue;
      }
      disagreements++;
      if (shiftedAll.has(date)) {
        // No certain reading of which day these times belong to: neither day is written; both are shown.
        anomalies.push({
          employeeName: name,
          date,
          rawText: `Built-in reader: ${said(tDay)} · AI reader: ${said(aDay)}`,
          reason: "The two readers put the same times on different days for this person, so this day was not imported. Check which day is right on the roster and add the shift on the rota.",
          confidence: 0.3,
          rowNumber: null,
        });
        continue;
      }
      if (!tDay.length) {
        // A shift only the AI saw, on a day the file's text shows nothing: never written, shown to check.
        anomalies.push({
          employeeName: name,
          date,
          rawText: `AI reader: ${said(aDay)}`,
          reason: "The AI reader saw a shift here, but the file's own text shows none on this day. If it's right, add it on the rota after importing.",
          confidence: 0.5,
          rowNumber: null,
        });
        continue;
      }
      // A day the table reader had to infer (or whose am / pm it had to guess), read differently
      // by the AI: the table reader's times stay, with the AI's reading as an alternative.
      const tLeft = [...tDay];
      const aLeft: ParsedShiftRow[] = [];
      for (const r of aDay) {
        const same = tLeft.findIndex((x) => segKey(x) === segKey(r));
        // A segment both read on this day is confirmed, whatever else differs.
        if (same >= 0) rows.push(confirmed({ ...tLeft.splice(same, 1)[0]!, readerSource: 'both' }));
        else aLeft.push(r);
      }
      const anchor = aLeft.length ? tLeft.shift() ?? null : null;
      if (anchor) rows.push({ ...withFlag({ ...anchor, readerSource: 'both' }, 'times_differ'), alternatives: [alt('table', anchor), ...aLeft.map((r) => alt('ai', r))] });
      else if (aLeft.length) {
        // Every table segment matched one of the AI's; the AI saw more: shown as another reading of the day.
        const x = rows.findIndex((row) => row.personKey === person.personKey && row.date === date);
        if (x >= 0) rows[x] = { ...withFlag(rows[x]!, 'times_differ'), alternatives: [alt('table', rows[x]!), ...aLeft.map((r) => alt('ai', r))] };
      }
      for (const x of tLeft) rows.push(withFlag({ ...x, readerSource: 'table' }, 'table_only'));
    }
    // Leave: the file's own text first; the AI's only on a day the file's text shows nothing.
    const leaveDates = new Set<string>(tableRows.map((r) => r.date));
    for (const l of [...leaveOf(table, t), ...leaveOf(ai, a)]) {
      if (leaveDates.has(l.date)) continue;
      leaveDates.add(l.date);
      const { inferredDay: _inferred, ...record } = l;
      leaveRecords.push({ ...record, employeeName: name });
    }
  }
  for (const t of tablePeople) {
    if (usedTable.has(t)) continue;
    const tableOnlyReason = nonPersonReason(t.name);
    if (tableOnlyReason) {
      refuse(t, tableOnlyReason, 'built-in reader');
      continue;
    }
    disagreements++;
    people.push({ ...t, readerSource: 'table' });
    nameMap.set(t.name, t.name);
    // The person is marked as found by the table reader only; a row it read for certain is the file's own text.
    rows.push(...rowsOf(table, t).map((r) => ({ ...r, personKey: t.personKey, readerSource: 'table' as const })).map((r) => (r.inferredDay || r.inferredTimes ? withFlag(r, 'table_only') : r)));
    leaveRecords.push(...leaveOf(table, t));
  }

  // Renumber rows; keep anomaly links pointing at the same shifts.
  const renumber = new Map<string, number>();
  rows.forEach((r, i) => {
    renumber.set(`${r.readerSource === 'table' ? 'table' : 'ai'}:${r.rowNumber}`, i + 1);
    r.rowNumber = i + 1;
  });
  const keyed = new Set<string>();
  for (const [source, result] of [['ai', ai], ['table', table]] as const) {
    for (const a of result.anomalies) {
      if (a.employeeName && refused.has(normName(a.employeeName))) continue;
      const employeeName = a.employeeName ? nameMap.get(a.employeeName) ?? a.employeeName : null;
      // The AI's note on a day the file's own text settled (an unsure or unreadable cell) is not shown.
      if (source === 'ai' && employeeName && a.date && settled.get(employeeName)?.has(a.date)) continue;
      const key = `${employeeName ?? ''}|${a.date ?? ''}|${a.rawText}`;
      if (keyed.has(key)) continue;
      keyed.add(key);
      anomalies.push({ ...a, employeeName, rowNumber: a.rowNumber === null ? null : renumber.get(`${source}:${a.rowNumber}`) ?? null });
    }
  }
  const sourceIndex = new Map(people.map((p, i) => [p.personKey, i]));
  for (const r of rows) r.sourceRowIndex = sourceIndex.get(r.personKey ?? '') ?? r.sourceRowIndex;

  const unread = new Map<string, UnreadRow>();
  for (const u of [...(table.unreadRows ?? []), ...(ai.unreadRows ?? []), ...refusedRows]) {
    const key = `${u.page}|${u.row}|${normName(u.text)}|${u.reason}`;
    // A row the table could not read but the AI did read is no longer unread.
    if (u.text && people.some((p) => normName(u.text).includes(normName(p.name)))) continue;
    if (!unread.has(key)) unread.set(key, u);
  }

  const week = reconcileWeeks(ai.week, table.week);
  if (week.disagree === 'flagged') disagreements++;
  else if (week.disagree === 'settled') aiDiffCells++;
  return {
    result: {
      templateLabel: ai.templateLabel,
      rows,
      issues: [...table.issues, ...ai.issues.filter((i) => !table.issues.some((t) => t.message === i.message))],
      anomalies,
      leaveRecords,
      legend: ai.legend.length ? ai.legend : table.legend,
      people,
      unreadRows: [...unread.values()],
      ...(week.week ? { week: week.week } : {}),
    },
    disagreements,
    aiDiffCells,
  };
}

/**
 * The table reader's week when it read printed dates (the file's own text); else the AI's. A
 * week the file prints for certain (dates or a title, nothing to confirm) stands over an AI
 * reading of another week ('settled': counted, not flagged); otherwise a difference asks the
 * manager to confirm the week ('flagged').
 */
function reconcileWeeks(ai: WeekDetection | undefined, table: WeekDetection | undefined): { week: WeekDetection | undefined; disagree: 'flagged' | 'settled' | null } {
  if (!ai || !table) return { week: table ?? ai, disagree: null };
  const printed = (w: WeekDetection) => w.source === 'printed_dates' || w.source === 'title';
  const base = printed(table) || !printed(ai) ? table : ai;
  if (ai.weekStart === table.weekStart) return { week: base, disagree: null };
  if (printed(table) && !table.needsConfirmation) return { week: table, disagree: 'settled' };
  return {
    week: { ...base, needsConfirmation: true, reason: `The two readers placed this roster in different weeks (${table.weekStart} and ${ai.weekStart}). Check the week before confirming.` },
    disagree: 'flagged',
  };
}
