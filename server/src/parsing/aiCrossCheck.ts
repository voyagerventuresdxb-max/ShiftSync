/**
 * The independent cross-check of a photo or scan. With no text layer there is no table reader,
 * so a misread from the AI reader would be silent. A second AI read, framed differently — day
 * column by day column instead of person by person (vlmPrompt.ts) — runs at the same time as the
 * first, and the two are compared exactly like the table cross-check: what both read is kept;
 * whatever only one read saw is kept too, flagged, with a "cell to look at"; times that differ
 * keep the first reading's with both readings attached. Nothing either read saw is dropped
 * silently. Logs carry counts only.
 */
import { columnsToRows, isColumnAnswer, type ReadingAnswer } from './vlmPrompt.js';
import { VisionProviderError, type VisionInput, type VisionProvider } from './visionProvider.js';
import type { AiReadSource } from './rosterReading.js';
import type { ReadPerson, RowFlag, ShiftAlternative, UnreadRow } from './rosterContract.js';
import type { AnomalyRecord, LeaveRecord, ParsedShiftRow, ParsedVisionResult } from './types.js';

export interface CrossReadOutcome {
  /** The second reading, laid out person by person; null when no page could be read. */
  answer: ReadingAnswer | null;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

/** The column-by-column read: one call per page, all at once, no second pass (it is the check). */
export async function aiCrossRead(
  source: Extract<AiReadSource, { kind: 'file' }>,
  o: { provider: VisionProvider; locationId: string | null; userId: string | null; deadline: number },
): Promise<CrossReadOutcome> {
  const pageCount = Math.max(1, source.pageCount);
  let tokensIn = 0;
  let tokensOut = 0;
  const call = async (page?: number): Promise<ReadingAnswer | null> => {
    const input: VisionInput = {
      kind: 'file',
      data: source.data,
      mimeType: source.mimeType,
      originalFilename: source.name,
      locationId: o.locationId,
      userId: o.userId,
      deadline: o.deadline,
      framing: 'columns',
      ...(page ? { focus: { page } } : {}),
    };
    try {
      const output = await o.provider.readRoster(input);
      tokensIn += output.usage.promptTokens ?? 0;
      tokensOut += output.usage.outputTokens ?? 0;
      if (output.truncated) return null;
      const parsed: unknown = JSON.parse(output.raw);
      if (!isColumnAnswer(parsed)) return null;
      const rows = columnsToRows(parsed);
      return page ? { ...rows, pages: rows.pages.filter((p) => p.p === page).slice(0, 1).map((p) => ({ ...p, p: page })) } : rows;
    } catch (err) {
      if (err instanceof VisionProviderError || err instanceof SyntaxError) return null;
      throw err;
    }
  };
  const answers = pageCount === 1 ? [await call()] : await Promise.all(Array.from({ length: pageCount }, (_, i) => call(i + 1)));
  const read = answers.filter((a): a is ReadingAnswer => a !== null);
  console.log(`[roster-reading] AI cross-check read: ${answers.length} call(s), ${read.length} answered.`);
  if (!read.length) return { answer: null, calls: answers.length, tokensIn, tokensOut };
  const head = read.reduce((best, a) => ((a.days?.length ?? 0) > (best.days?.length ?? 0) ? a : best));
  return {
    answer: { title: read.find((a) => a.title)?.title ?? null, days: head.days, key: head.key ?? [], pages: read.flatMap((a) => a.pages).sort((a, b) => a.p - b.p) },
    calls: answers.length,
    tokensIn,
    tokensOut,
  };
}

const normName = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const joined = (s: string) => normName(s).replace(/ /g, '');
const segKey = (r: { startTime: string; endTime: string }) => `${r.startTime}-${r.endTime}`;
const withFlag = (r: ParsedShiftRow, flag: RowFlag): ParsedShiftRow => ({ ...r, flags: [...new Set([...(r.flags ?? []), flag])] });
const alt = (r: ParsedShiftRow): ShiftAlternative => ({ reader: 'ai', startTime: r.startTime, endTime: r.endTime, overnight: r.overnight });

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

const ONE_READING = 'Only one of the two AI readings of this photo or scan saw this. Check it against the roster.';

/**
 * Compares the first (person-by-person) and second (column-by-column) AI readings. The first
 * reading's names and times are kept where both read something; everything only one saw is
 * kept and flagged; a day one reading saw as a coloured cell and the other as times keeps the
 * times, flagged.
 */
export function crossCheckAiReadings(first: ParsedVisionResult, second: ParsedVisionResult | null): { result: ParsedVisionResult; disagreements: number } {
  if (!second) return { result: first, disagreements: 0 };
  let disagreements = 0;
  const aPeople = first.people ?? [];
  const bPeople = second.people ?? [];
  const samePage = (a: ReadPerson, b: ReadPerson) => a.sourcePage === null || b.sourcePage === null || a.sourcePage === b.sourcePage;

  const pairs = new Map<ReadPerson, ReadPerson>();
  const usedB = new Set<ReadPerson>();
  const pairBy = (match: (a: ReadPerson, b: ReadPerson) => boolean) => {
    for (const a of aPeople) {
      if (pairs.has(a)) continue;
      const b = bPeople.find((x) => !usedB.has(x) && samePage(a, x) && match(a, x));
      if (b) {
        pairs.set(a, b);
        usedB.add(b);
      }
    }
  };
  pairBy((a, b) => normName(a.name) === normName(b.name));
  pairBy((a, b) => joined(a.name) === joined(b.name));
  pairBy((a, b) => {
    const [x, y] = [normName(a.name), normName(b.name)];
    return levenshtein(x, y) <= Math.max(1, Math.floor(Math.min(x.length, y.length) * 0.2)) && (a.sourceRow === null || b.sourceRow === null || Math.abs(a.sourceRow - b.sourceRow) <= 1);
  });

  const people: ReadPerson[] = [];
  const rows: { row: ParsedShiftRow; from: 'a' | 'b'; note?: string }[] = [];
  const leaveRecords: LeaveRecord[] = [];
  const anomalies: AnomalyRecord[] = [];
  const nameMap = new Map<string, string>();
  const rowsOf = (r: ParsedVisionResult, p: ReadPerson) => r.rows.filter((x) => (x.personKey ? x.personKey === p.personKey : normName(x.employeeName) === normName(p.name)));
  const leaveOf = (r: ParsedVisionResult, p: ReadPerson) => r.leaveRecords.filter((l) => normName(l.employeeName) === normName(p.name));
  const oneReader = (row: ParsedShiftRow, from: 'a' | 'b') => {
    disagreements++;
    rows.push({ row: withFlag({ ...row, readerSource: 'ai' }, 'low_confidence'), from, note: ONE_READING });
  };

  const addAlone = (p: ReadPerson, result: ParsedVisionResult, from: 'a' | 'b') => {
    disagreements++;
    people.push({ ...p, readerSource: 'ai' });
    nameMap.set(p.name, p.name);
    for (const r of rowsOf(result, p)) rows.push({ row: withFlag({ ...r, personKey: p.personKey, readerSource: 'ai' }, 'low_confidence'), from });
    leaveRecords.push(...leaveOf(result, p));
    anomalies.push({ employeeName: p.name, date: null, rawText: p.name, reason: `Only one of the two AI readings listed ${p.name}. Check the roster before importing them.`, confidence: 0.5, rowNumber: null });
  };

  for (const a of aPeople) {
    const b = pairs.get(a);
    if (!b) {
      addAlone(a, first, 'a');
      continue;
    }
    const person: ReadPerson = {
      ...a,
      readerSource: 'ai',
      roleLabel: a.roleLabel ?? b.roleLabel,
      section: a.section ?? b.section,
      ...(a.name !== b.name ? { nameAlternatives: [...(a.nameAlternatives ?? []), { reader: 'ai' as const, name: b.name }] } : {}),
    };
    if (a.name !== b.name) disagreements++;
    people.push(person);
    nameMap.set(a.name, a.name);
    nameMap.set(b.name, a.name);
    const fix = (r: ParsedShiftRow): ParsedShiftRow => ({ ...r, employeeName: a.name, personKey: a.personKey, section: person.section, sourcePage: a.sourcePage, roleName: r.roleName || a.roleLabel || '' });
    const aRows = rowsOf(first, a).map(fix);
    const bRows = rowsOf(second, b).map(fix);
    const aLeave = leaveOf(first, a);
    const bLeave = leaveOf(second, b);
    const dates = [...new Set([...aRows, ...bRows].map((r) => r.date).concat([...aLeave, ...bLeave].map((l) => l.date)))].sort();
    for (const date of dates) {
      const aDay = aRows.filter((r) => r.date === date).sort((x, y) => x.startTime.localeCompare(y.startTime));
      const bLeft = bRows.filter((r) => r.date === date).sort((x, y) => x.startTime.localeCompare(y.startTime));
      const aLeft: ParsedShiftRow[] = [];
      for (const r of aDay) {
        const same = bLeft.findIndex((x) => segKey(x) === segKey(r));
        if (same >= 0) {
          bLeft.splice(same, 1);
          rows.push({ row: { ...r, readerSource: 'ai' }, from: 'a' });
        } else aLeft.push(r);
      }
      while (aLeft.length && bLeft.length) {
        const r = aLeft.shift()!;
        const x = bLeft.shift()!;
        disagreements++;
        rows.push({ row: { ...withFlag({ ...r, readerSource: 'ai' }, 'times_differ'), alternatives: [alt(r), alt(x)] }, from: 'a' });
      }
      for (const r of aLeft) oneReader(r, 'a');
      for (const x of bLeft) oneReader(x, 'b');
      // Leave: kept when the day has no times in either reading; a coloured cell one reading saw
      // where the other read times is the times (text wins over colour), noted for a look.
      const dayLeave = [...aLeave, ...bLeave].filter((l) => l.date === date);
      if (!dayLeave.length) continue;
      if (aDay.length || bRows.some((r) => r.date === date)) {
        disagreements++;
        anomalies.push({ employeeName: a.name, date, rawText: dayLeave.map((l) => l.leaveCode).join(' / '), reason: 'One AI reading saw a code or colour on this day, the other saw times. The times were kept; check the day.', confidence: 0.5, rowNumber: null });
        continue;
      }
      const first1 = aLeave.find((l) => l.date === date) ?? bLeave.find((l) => l.date === date)!;
      leaveRecords.push({ ...first1, employeeName: a.name });
    }
  }
  for (const b of bPeople) if (!usedB.has(b)) addAlone(b, second, 'b');

  // Renumber; anomalies of either reading keep pointing at their shifts.
  const renumber = new Map<string, number>();
  const finalRows = rows.map(({ row, from, note }, i) => {
    renumber.set(`${from}:${row.rowNumber}`, i + 1);
    if (note) anomalies.push({ employeeName: row.employeeName, date: row.date, rawText: `${row.startTime}–${row.endTime}`, reason: note, confidence: 0.5, rowNumber: i + 1 });
    return { ...row, rowNumber: i + 1 };
  });
  const seen = new Set<string>();
  for (const [from, result] of [['a', first], ['b', second]] as const) {
    for (const x of result.anomalies) {
      const employeeName = x.employeeName ? nameMap.get(x.employeeName) ?? x.employeeName : null;
      const key = `${employeeName ?? ''}|${x.date ?? ''}|${x.rawText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anomalies.push({ ...x, employeeName, rowNumber: x.rowNumber === null ? null : renumber.get(`${from}:${x.rowNumber}`) ?? null });
    }
  }
  const index = new Map(people.map((p, i) => [p.personKey, i]));
  for (const r of finalRows) r.sourceRowIndex = index.get(r.personKey ?? '') ?? r.sourceRowIndex;

  const listed = people.map((p) => normName(p.name));
  const unread = new Map<string, UnreadRow>();
  for (const u of [...(first.unreadRows ?? []), ...(second.unreadRows ?? [])]) {
    if (u.text && listed.some((n) => normName(u.text).includes(n))) continue;
    unread.set(`${u.page}|${u.row}|${normName(u.text)}`, u);
  }

  let week = first.week ?? second.week;
  if (first.week && second.week && first.week.weekStart !== second.week.weekStart) {
    disagreements++;
    week = { ...first.week, needsConfirmation: true, reason: `The two AI readings placed this roster in different weeks (${first.week.weekStart} and ${second.week.weekStart}). Check the week before confirming.` };
  }
  console.log(`[roster-reading] AI cross-check: ${people.length} people, ${disagreements} disagreement(s).`);
  return {
    result: {
      ...first,
      rows: finalRows,
      anomalies,
      leaveRecords,
      people,
      unreadRows: [...unread.values()],
      ...(week ? { week } : {}),
    },
    disagreements,
  };
}
