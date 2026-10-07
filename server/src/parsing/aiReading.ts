/**
 * Turns the AI reader's transcription (vlmPrompt.ts ReadingAnswer) into rows, people, leave and
 * flags — with the table reader's own rules: dates from the printed day headers
 * (weekDetection.ts), times and codes from the printed cell text (interpretCell). The model
 * never decides a date or a time on its own; where it had to read something that is not plain
 * times ("z"), the row is kept and flagged for a look.
 */
import { interpretCell } from './deterministicGridParser.js';
import { canonicalRoleName } from './resolveRows.js';
import { isOvernight } from './normalize.js';
import { looksLikePersonName, personKeyOf } from './personKey.js';
import { parseShiftText, sheetDotStyle } from './shiftText.js';
import { detectWeek, parseDayLabel } from './weekDetection.js';
import type { ReadingAnswer } from './vlmPrompt.js';
import type { ReadPerson, RowFlag, UnreadRow } from './rosterContract.js';
import type { AnomalyRecord, LeaveRecord, ParsedShiftRow, ParsedVisionResult, RowIssue } from './types.js';

/** templateLabel of a result the AI reader produced (local fallbacks are labelled 'Deterministic local parser (…)'). */
export const AI_TEMPLATE_LABEL = 'Direct Vision Ingestion';

export interface AiReadingContext {
  /** Today in the venue's timezone (YYYY-MM-DD). */
  today: string;
  /** The week the client asked for; used only when the roster prints no dates. */
  clientWeekStart: string | null;
}

/** Row labels that are never a person (the same closed caption vocabulary as the table reader). */
const NOT_A_PERSON = /^(covers?|pax|events?|notes?|remarks?|comments?|totals?|sub ?total|grand total|total hours|headcount|date|day of the week)$/i;

/** A colour-only cell's meaning ("[Holiday]") as a leave category. */
function colourCategory(meaning: string): LeaveRecord['category'] {
  if (/\b(off|rest|request)\b/i.test(meaning)) return 'day_off';
  if (/\b(holiday|ph|public)\b/i.test(meaning)) return 'public_holiday';
  return 'leave';
}

export function mapReadingAnswer(answer: ReadingAnswer, ctx: AiReadingContext): ParsedVisionResult {
  const rows: ParsedShiftRow[] = [];
  const issues: RowIssue[] = [];
  const anomalies: AnomalyRecord[] = [];
  const leaveRecords: LeaveRecord[] = [];
  const people: ReadPerson[] = [];
  const unreadRows: UnreadRow[] = [];

  const days = answer.days ?? [];
  const titles = answer.title ? [answer.title] : [];
  // A day the model split into its AM and PM halves ("17-Aug MONDAY AM", "… PM") is one day.
  const dayText = days.map((d) => (d ?? '').replace(/\b(am|pm)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim());
  const slotOf: number[] = [];
  const slots: string[] = [];
  dayText.forEach((t, i) => {
    if (i > 0 && t && t === dayText[i - 1]) slotOf.push(slots.length - 1);
    else {
      slots.push(t);
      slotOf.push(slots.length - 1);
    }
  });
  const detected = detectWeek(slots.map(parseDayLabel), titles, ctx);
  const week = detected.week;
  const dates = slotOf.map((s) => detected.dates[s] ?? null);
  const allCells = (answer.pages ?? []).flatMap((p) => (p.sec ?? []).flatMap((s) => (s.ppl ?? []).flatMap((x) => x.c ?? [])));
  const timeOptions = { dotMeans: sheetDotStyle(allCells) };

  let rowNumber = 1;
  let sourceRowIndex = 0;
  const seen = new Set<string>();
  for (const page of [...(answer.pages ?? [])].sort((a, b) => a.p - b.p)) {
    for (const u of page.unread ?? []) unreadRows.push({ page: page.p, row: u.r ?? null, text: u.x ?? '', reason: u.w || 'The AI reader could not read this row.' });
    for (const section of page.sec ?? []) {
      for (const person of section.ppl ?? []) {
        const name = (person.nm ?? '').trim();
        const cells = person.c ?? [];
        if (!name) {
          unreadRows.push({ page: page.p, row: person.i ?? null, text: cells.filter(Boolean).join(' | '), reason: 'A row with shifts but no readable name.' });
          continue;
        }
        // A stitched answer (a page read twice) may list the same printed row twice.
        const dedupe = `${page.p}:${person.i}:${name.toLowerCase()}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        // Listed despite the instructions: a headcount (a number), a caption, or a section
        // banner with nothing in its days. Not a person — kept visible as an unread row.
        const blankWeek = cells.every((c) => !(c ?? '').trim());
        if (/^\d+(\.\d+)?$/.test(name) || NOT_A_PERSON.test(name) || (blankWeek && canonicalRoleName(name) !== name)) {
          unreadRows.push({ page: page.p, row: person.i ?? null, text: name, reason: 'Listed by the AI reader but looks like a count, caption or section heading, not a person.' });
          continue;
        }

        const personKey = personKeyOf(name, page.p, person.i ?? null);
        const heading = section.h?.trim() || null;
        const title = person.t?.trim() || null;
        const roleName = title ?? heading ?? '';
        people.push({ personKey, name, roleLabel: title ?? heading, section: heading, sourcePage: page.p, sourceRow: person.i ?? null, readerSource: 'ai' });
        const unsure = new Set(person.q ?? []);
        const thisSource = sourceRowIndex++;
        if (!looksLikePersonName(name)) {
          issues.push({ rowNumber: 0, field: 'employeeName', severity: 'info', message: `"${name}" was read as a person; check it is one.` });
        }

        cells.forEach((rawCell, d) => {
          const text = (rawCell ?? '').trim();
          if (!text) return;
          const date = dates[d] ?? null;
          if (!date) {
            anomalies.push({ employeeName: name, date: null, rawText: text, reason: `The day column "${days[d] ?? '?'}" has no readable date.`, confidence: 0.2, rowNumber: null });
            return;
          }
          if (text === '[?]') {
            anomalies.push({ employeeName: name, date, rawText: '(illegible)', reason: 'This cell could not be read (blacked out or illegible).', confidence: 0.2, rowNumber: null });
            return;
          }
          const colour = text.match(/^\[(.+)\]$/);
          if (colour) {
            leaveRecords.push({ employeeName: name, date, leaveCode: colour[1]!.trim(), category: colourCategory(colour[1]!) });
            return;
          }
          let parsed = interpretCell(text, timeOptions);
          const flags: RowFlag[] = unsure.has(d) ? ['low_confidence'] : [];
          if (parsed.kind === 'unresolved') {
            // The model's own reading of a cell that is not plain times: kept, and flagged.
            const own = (person.z ?? []).find((z) => z.d === d);
            const segments = own?.s.map((s) => parseShiftText(s)?.segments ?? []).flat() ?? [];
            if (segments.length) {
              parsed = { kind: 'shifts', intervals: segments.map((s) => ({ start: s.start, end: s.end })) };
              if (!flags.includes('low_confidence')) flags.push('low_confidence');
            }
          }
          if (parsed.kind === 'leave') {
            leaveRecords.push({ employeeName: name, date, leaveCode: parsed.code, category: parsed.category });
            return;
          }
          if (parsed.kind === 'flagged') {
            anomalies.push({ employeeName: name, date, rawText: parsed.raw, reason: parsed.reason, confidence: 0.7, rowNumber: null });
            return;
          }
          if (parsed.kind === 'unresolved') {
            anomalies.push({ employeeName: name, date, rawText: parsed.raw, reason: `Could not resolve shift time from cell "${parsed.raw}".`, confidence: 0.2, rowNumber: null });
            return;
          }
          if (parsed.kind === 'blank') return;
          // A segment of 14 hours or more is almost always a misread (start and end swapped, a
          // digit dropped): kept, flagged and explained, never silently trusted.
          const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
          const tooLong = parsed.intervals.some((iv) => ((minutes(iv.end) - minutes(iv.start) + 1440) % 1440 || 1440) >= 14 * 60);
          if (tooLong) {
            if (!flags.includes('low_confidence')) flags.push('low_confidence');
            anomalies.push({ employeeName: name, date, rawText: text, reason: `"${text}" reads as a shift of 14 hours or more. Check the start and end times.`, confidence: 0.4, rowNumber });
          }
          for (const interval of parsed.intervals) {
            if (!roleName) {
              issues.push({ rowNumber, field: 'role', severity: 'warning', message: `No role could be identified for "${name}" — flagged for manual role assignment.` });
            }
            rows.push({
              rowNumber: rowNumber++,
              sourceRowIndex: thisSource,
              employeeName: name,
              roleName,
              date,
              startTime: interval.start,
              endTime: interval.end,
              overnight: isOvernight(interval.start, interval.end),
              breakMinutes: 0,
              managerNotes: flags.length ? `Check this cell ("${text}").` : null,
              personKey,
              section: heading,
              sourcePage: page.p,
              readerSource: 'ai',
              ...(flags.length ? { flags: [...flags] } : {}),
            });
          }
        });
      }
    }
  }

  return {
    templateLabel: AI_TEMPLATE_LABEL,
    rows,
    issues,
    anomalies,
    leaveRecords,
    legend: (answer.key ?? []).map((k) => ({ code: k.c, meaning: k.m })),
    people,
    unreadRows,
    week,
  };
}
