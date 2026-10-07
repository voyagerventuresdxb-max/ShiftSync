/**
 * Mock AI-reader answers for the layout-family corpus, derived from the truth with realistic
 * perturbations: one person row dropped, one shift's start and end swapped, one name misread
 * by a letter, and — on multi-page files — the last page missing. A page-focused re-read
 * answers that page cleanly (the "stricter prompt" working). Never a model score: it checks
 * that the pipeline catches, flags or recovers each perturbation. No network, nothing billed.
 */
import { rng, type FamilyTruth } from './families.js';

export interface Perturbations {
  /** Person whose whole row the first reading leaves out. */
  dropped: string | null;
  /** One shift whose start and end the first reading swaps. */
  swapped: { name: string; date: string; start: string } | null;
  /** One name the first reading misreads (`as`). */
  misread: { name: string; as: string } | null;
  /** A page the first reading leaves out entirely. */
  missingPage: number | null;
}

function hashSeed(id: string): number {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Changes one letter so the name is plausibly misread ("Okafor" → "Okafar"). */
export function misreadName(name: string, r: () => number): string {
  const letters = [...name].map((c, i) => ({ c, i })).filter(({ c }) => /[a-z]/.test(c));
  const target = letters[Math.floor(r() * letters.length)] ?? { c: name[0]!, i: 0 };
  const swap: Record<string, string> = { a: 'o', o: 'a', e: 'c', i: 'l', l: 'i', n: 'm', m: 'n', u: 'v', r: 'n', s: 'e', t: 'f', h: 'b' };
  const chars = [...name];
  chars[target.i] = swap[target.c] ?? 'e';
  return chars.join('');
}

export function perturbationsFor(truth: FamilyTruth): Perturbations {
  const r = rng(hashSeed(truth.id));
  const withShifts = truth.people.filter((p) => truth.shifts.some((s) => s.name === p.name));
  const page1 = withShifts.filter((p) => p.page === 1);
  const dropped = page1.length >= 5 ? page1[Math.floor(r() * page1.length)]!.name : null;
  const others = withShifts.filter((p) => p.name !== dropped);
  const swapPerson = others[Math.floor(r() * others.length)];
  const swapShift = swapPerson ? truth.shifts.find((s) => s.name === swapPerson.name) : undefined;
  const misreadPerson = others.filter((p) => p.name !== swapPerson?.name && p.name.length >= 5)[0];
  return {
    dropped,
    swapped: swapShift ? { name: swapShift.name, date: swapShift.date, start: swapShift.start } : null,
    misread: misreadPerson ? { name: misreadPerson.name, as: misreadName(misreadPerson.name, r) } : null,
    missingPage: truth.pageCount > 1 ? truth.pageCount : null,
  };
}

const leaveInterpretation = (code: string) => (code === 'OFF' || code === 'DO' ? 'day_off' : code === 'PH' ? 'public_holiday' : 'leave');

/**
 * The answer in the ORIGINAL schema (ROSTER_VLM_JSON_SCHEMA before the reading rework): one
 * employee list, dates as printed on the day header (the schema allowed the raw label when the
 * model could not resolve a year). Used to record the baseline.
 */
export function legacyAnswer(truth: FamilyTruth, p: Perturbations = perturbationsFor(truth)): string {
  const dayLabel = (date: string) => truth.printed.dayLabels[truth.week.dates.indexOf(date)] ?? date;
  const employees = truth.people
    .filter((person) => person.name !== p.dropped && person.page !== p.missingPage)
    .map((person) => {
      const cells: unknown[] = [];
      for (const s of truth.shifts.filter((x) => x.name === person.name)) {
        const swap = p.swapped && p.swapped.name === s.name && p.swapped.date === s.date && p.swapped.start === s.start;
        cells.push({ date: dayLabel(s.date), rawText: `${s.start}-${s.end}`, period: null, interpretation: 'worked_shift', startTime: swap ? s.end : s.start, endTime: swap ? s.start : s.end, leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null });
      }
      for (const l of truth.leave.filter((x) => x.name === person.name)) {
        cells.push({ date: dayLabel(l.date), rawText: l.code, period: null, interpretation: leaveInterpretation(l.code), startTime: null, endTime: null, leaveCode: l.code, confidence: 0.9, needsReview: false, reviewReason: null });
      }
      for (const f of truth.flagged.filter((x) => x.name === person.name)) {
        cells.push({ date: dayLabel(f.date), rawText: 'CL', period: null, interpretation: 'unresolved', startTime: null, endTime: null, leaveCode: null, confidence: 0.3, needsReview: true, reviewReason: 'open-ended shift' });
      }
      const name = p.misread?.name === person.name ? p.misread.as : person.name;
      return { rawName: name, role: person.role || null, cells };
    });
  return JSON.stringify({ venueTemplateNotes: '', legend: [], documentAnomalies: [], employees });
}

/** What a page-focused or whole-file request asks the mock to read. */
export interface MockRequest {
  focus?: { page: number; rows?: { from: number; to: number | null } };
  strict?: boolean;
}

/**
 * The answer in the CURRENT transcription schema (vlmPrompt.ts), for one request. The first
 * (non-strict) read of each page carries the perturbations; a strict re-read of a page lists
 * every row (the stricter prompt working) but keeps the reader's consistent misreadings (the
 * swapped cell, the misread name), which only the table reader can catch.
 */
export function transcriptionAnswer(truth: FamilyTruth, request: MockRequest, p: Perturbations = perturbationsFor(truth)): string {
  const pages = request.focus ? [request.focus.page] : Array.from({ length: truth.pageCount }, (_, i) => i + 1);
  const outPages = pages
    .filter((page) => request.strict || page !== p.missingPage)
    .map((page) => {
      const onPage = truth.people.filter((x) => x.page === page);
      const people = onPage
        .map((person, idx) => ({ person, i: idx + 1 }))
        .filter(({ i }) => !request.focus?.rows || (i >= request.focus.rows.from && (request.focus.rows.to === null || i <= request.focus.rows.to)));
      const sections: { h: string | null; n: number; ppl: unknown[] }[] = [];
      for (const { person, i } of people) {
        let sec = sections[sections.length - 1];
        if (!sec || sec.h !== person.section) {
          sec = { h: person.section, n: 0, ppl: [] };
          sections.push(sec);
        }
        sec.n++;
        if (!request.strict && person.name === p.dropped) continue;
        const cells = (person.cells ?? truth.week.dates.map(() => '')).map((text, d) => {
          const swap = p.swapped && p.swapped.name === person.name && p.swapped.date === truth.week.dates[d];
          if (!swap) return text;
          const segs = truth.shifts.filter((s) => s.name === person.name && s.date === truth.week.dates[d]);
          return segs.map((s, k) => (k === 0 ? `${s.end}-${s.start}` : `${s.start}-${s.end}`)).join(' / ');
        });
        sec.ppl.push({ nm: p.misread?.name === person.name ? p.misread.as : person.name, t: truth.family === 'B' ? person.role || null : null, i, c: cells });
      }
      return { p: page, rows: onPage.length, sec: sections, unread: [] };
    });
  return JSON.stringify({ title: truth.printed.title, days: truth.printed.dayLabels, key: [], pages: outPages });
}
