/**
 * Mock AI-reader answers for the layout-family corpus, derived from the truth with realistic
 * perturbations — never a model score: they check that the pipeline catches, flags or recovers
 * each one. No network, nothing billed.
 *
 * The person-by-person (rows) read, first pass:
 *  - every file: one person row dropped (still counted, so the page reads short), one shift's
 *    start and end swapped, one name misread by a letter, and on 2-page files the last page left
 *    out;
 *  - name column printed before the title column: the title column read as the names;
 *  - a totals line under the grid: listed as a person;
 *  - photos and scans of the decimal-hour layout: coloured cells that hold times read as colour
 *    only, a PM-only day's values slipped into the next (empty) day, an "18" read as "18.5", and a
 *    person with no times all week left out (and not counted);
 *  - photos and scans of the free-text layout: the last row reported as cut off.
 * A strict page re-read lists every row but keeps the reader's consistent misreadings.
 *
 * The day-column-by-day-column (columns) read of a photo or scan is independent: it has none of
 * the above, but misreads a different name and misses one cell of its own.
 *
 * Round 5: a text PDF read like a live AI reads it (`aiNoise`: every time in another notation, one
 * row slipped a day to the left from an empty cell on, a digit misread in one cell); a sign-off
 * line under the grid listed as a person with its day texts; and a low-contrast scan whose two
 * readings read a few cells the same wrong way, read others differently, and whose row read marks
 * some cells unsure.
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
  /** The row read takes the title column as the names (name column printed first). */
  swapNameTitle: boolean;
  /** A totals line the row read lists as a person. */
  footerAsPerson: { label: string; cells: string[] } | null;
  /** Coloured cells holding times that the row read transcribes as colour only. */
  colourOverText: { name: string; day: number; meaning: string }[];
  /** A PM-only day whose values the row read puts under the next (empty) day. */
  slid: { name: string; day: number } | null;
  /** A cell where the row read takes an "18" for "18.5". */
  misread18: { name: string; day: number } | null;
  /** A person with no times all week the row read leaves out and doesn't count. */
  droppedZeroShift: string | null;
  /** The row read reports the page's last row as cut off instead of listing it. */
  cutOffLast: boolean;
  /** Dense photo: cells the row read slides into the next (empty) day, and cells the column read reads ".5" as a whole hour. */
  hard: {
    slidRows: { name: string; day: number }[];
    halfDropped: { name: string; day: number }[];
    /** Cells the column read slides into the next (empty) day. */
    colSlid: { name: string; day: number }[];
    /** Cells BOTH readings slide into the next (empty) day the same way: agreement that is wrong. */
    shared: { name: string; day: number }[];
  };
  /** Name and title in one cell: people whose whole cell the row read copies as the name. */
  combinedCopied: string[];
  /** Faint scan: a name the row read spells differently (a doubled or dropped letter). */
  faint: { name: string; as: string } | null;
  /** The column read's own mistakes: a different misread name, and one cell it misses. */
  columns: { misread: { name: string; as: string } | null; missedCell: { name: string; day: number } | null };
  /** A text PDF read like a live AI: a row slipped left a day from an empty cell on, and a cell with a misread digit. */
  noise: { slipped: { name: string; day: number } | null; digit: { name: string; day: number } | null };
  /** Low-contrast scan: cells both readings read the same wrong way, cells the column read reads differently, cells the row read marks unsure. */
  faded: { shared: { name: string; day: number }[]; colDiff: { name: string; day: number }[]; unsure: { name: string; day: number }[] };
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

const isImage = (truth: FamilyTruth) => truth.format === 'png' || truth.format === 'pdf-image';
const hasTimes = (cell: string | undefined) => !!cell && /\d/.test(cell) && !cell.startsWith('[');

export function perturbationsFor(truth: FamilyTruth): Perturbations {
  const r = rng(hashSeed(truth.id));
  const withShifts = truth.people.filter((p) => truth.shifts.some((s) => s.name === p.name));
  const page1 = withShifts.filter((p) => p.page === 1);
  const dropped = page1.length >= 5 ? page1[Math.floor(r() * page1.length)]!.name : null;
  const others = withShifts.filter((p) => p.name !== dropped);
  const swapPerson = others[Math.floor(r() * others.length)];
  const swapShift = swapPerson ? truth.shifts.find((s) => s.name === swapPerson.name) : undefined;
  const misreadPerson = others.filter((p) => p.name !== swapPerson?.name && p.name.length >= 5)[0];

  // Layout- and format-specific failures (their own random stream, so the ones above stay put).
  const r2 = rng(hashSeed(`${truth.id}#2`));
  const used = new Set([dropped, swapPerson?.name, misreadPerson?.name].filter(Boolean) as string[]);
  const free = truth.people.filter((p) => !used.has(p.name));
  const decimalImage = isImage(truth) && truth.family === 'A';
  const colourOverText: Perturbations['colourOverText'] = [];
  let slid: Perturbations['slid'] = null;
  let misread18: Perturbations['misread18'] = null;
  let droppedZeroShift: string | null = null;
  if (decimalImage) {
    for (const p of free) {
      p.fills?.forEach((meaning, day) => {
        if (meaning && colourOverText.length < 2 && !colourOverText.some((c) => c.name === p.name)) colourOverText.push({ name: p.name, day, meaning });
      });
    }
    const taken = new Set(colourOverText.map((c) => c.name));
    for (const p of free.filter((x) => !taken.has(x.name))) {
      const cells = p.cells ?? [];
      const day = cells.findIndex((c, d) => hasTimes(c) && c.split(' ').length === 2 && Number(c.split(' ')[0]) >= 14 && d < 6 && !hasTimes(cells[d + 1]));
      if (day >= 0 && !slid) {
        slid = { name: p.name, day };
        taken.add(p.name);
      }
    }
    for (const p of free.filter((x) => !taken.has(x.name))) {
      const day = (p.cells ?? []).findIndex((c) => hasTimes(c) && c.split(' ').includes('18'));
      if (day >= 0 && !misread18) {
        misread18 = { name: p.name, day };
        taken.add(p.name);
      }
    }
    droppedZeroShift = truth.people.find((p) => !used.has(p.name) && !(p.cells ?? []).some(hasTimes))?.name ?? null;
  }
  const colPool = free.filter((p) => p.name.length >= 5 && p.name !== droppedZeroShift && !colourOverText.some((c) => c.name === p.name) && p.name !== slid?.name && p.name !== misread18?.name);
  const colMisread = colPool[Math.floor(r2() * colPool.length)];
  const colMissed = colPool.filter((p) => p !== colMisread && (p.cells ?? []).some(hasTimes))[0];
  return {
    dropped,
    swapped: swapShift ? { name: swapShift.name, date: swapShift.date, start: swapShift.start } : null,
    misread: misreadPerson ? { name: misreadPerson.name, as: misreadName(misreadPerson.name, r) } : null,
    missingPage: truth.pageCount > 1 ? truth.pageCount : null,
    swapNameTitle: !!truth.printed.nameFirst && truth.family === 'B',
    footerAsPerson: truth.printed.totals?.[0] ?? (truth.printed.footers?.length ? { label: truth.printed.footers[0]!, cells: [] } : truth.printed.signOffs?.[0] ?? null),
    colourOverText,
    slid,
    misread18,
    droppedZeroShift,
    cutOffLast: isImage(truth) && truth.family === 'B',
    hard: hardCells(truth),
    faint: faintName(truth, used),
    combinedCopied: truth.printed.combined ? free.filter((x) => x.role).slice(1, 4).map((x) => x.name) : [],
    columns: {
      misread: colMisread ? { name: colMisread.name, as: misreadName(colMisread.name, r2) } : null,
      missedCell: colMissed ? { name: colMissed.name, day: (colMissed.cells ?? []).findIndex(hasTimes) } : null,
    },
    noise: noiseCells(truth, used),
    faded: fadedCells(truth),
  };
}

/** Live-like AI misreadings of a text PDF: one row slipped a day from an empty cell on, one digit misread. */
function noiseCells(truth: FamilyTruth, used: Set<string>): Perturbations['noise'] {
  if (!truth.printed.aiNoise) return { slipped: null, digit: null };
  const free = truth.people.filter((p) => !used.has(p.name));
  let slipped: Perturbations['noise']['slipped'] = null;
  for (const p of free) {
    const cells = p.cells ?? [];
    const day = cells.findIndex((c, d) => d >= 1 && d <= 4 && !c && cells.slice(d + 1).some(hasTimes));
    if (day >= 0) {
      slipped = { name: p.name, day };
      break;
    }
  }
  const digitPerson = free.find((p) => p.name !== slipped?.name && (p.cells ?? []).some(hasTimes));
  return { slipped, digit: digitPerson ? { name: digitPerson.name, day: (digitPerson.cells ?? []).findIndex(hasTimes) } : null };
}

/**
 * Low-contrast scan: both readings struggle, so as well as reading about one time cell in forty the
 * same wrong way (which no comparison can catch), they read about one in sixteen differently and
 * the row read marks about one in twenty unsure — a page harder to read than any readable one.
 */
function fadedCells(truth: FamilyTruth): Perturbations['faded'] {
  const out: Perturbations['faded'] = { shared: [], colDiff: [], unsure: [] };
  if (!truth.printed.lowContrast) return out;
  const r = rng(hashSeed(`${truth.id}#faded`));
  for (const p of truth.people) {
    (p.cells ?? []).forEach((c, day) => {
      if (!hasTimes(c)) return;
      const x = r();
      if (x < 0.025) out.shared.push({ name: p.name, day });
      else if (x < 0.085) out.colDiff.push({ name: p.name, day });
      else if (x < 0.135) out.unsure.push({ name: p.name, day });
    });
  }
  return out;
}

/** A cell's first time read an hour later ("18.5 26" -> "19.5 26", "4pm to 2am" -> "5pm to 2am"): a misread digit. */
const laterStart = (cell: string) => cell.replace(/^(\d{1,2})/, (m) => String(Number(m) === 12 ? 1 : (Number(m) + 1) % 24));

/** The same times in another notation, as a live AI writes them: "6:30pm – 1am", "18:30 - 00:00", "midnight". */
function otherNotation(truth: FamilyTruth, name: string, day: number): string | null {
  const segs = truth.shifts.filter((s) => s.name === name && s.date === truth.week.dates[day]);
  if (!segs.length) return null;
  const twelve = (t: string) => {
    const [h, m] = t.split(':').map(Number) as [number, number];
    if (h === 0 && m === 0) return 'midnight';
    return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
  };
  return day % 2 === 0 ? segs.map((s) => `${twelve(s.start)} – ${twelve(s.end)}`).join(' / ') : segs.map((s) => `${s.start} - ${s.end}`).join(', ');
}

/** Dense photo: about two cells in five of the half-day kind read differently by one of the two readings. */
function hardCells(truth: FamilyTruth): Perturbations['hard'] {
  const out: Perturbations['hard'] = { slidRows: [], halfDropped: [], colSlid: [], shared: [] };
  if (!truth.printed.hardToRead) return out;
  const r = rng(hashSeed(`${truth.id}#hard`));
  for (const p of truth.people) {
    const cells = p.cells ?? [];
    cells.forEach((c, d) => {
      if (!hasTimes(c)) return;
      // A slip lands on the next day when that day holds no times (a coloured cell on a dense photo too).
      const nextFree = d < 6 && !hasTimes(cells[d + 1]) && (!!truth.printed.sharedSlips || !(cells[d + 1] ?? '').startsWith('[')) && !out.shared.concat(out.slidRows, out.colSlid).some((x) => x.name === p.name && (x.day === d + 1 || x.day + 1 === d));
      if (truth.printed.sharedSlips) {
        // Most cells read two ways; some slipped the same way by both readings.
        const x = r();
        if (x < 0.15 && nextFree) out.shared.push({ name: p.name, day: d });
        else if (x < 0.45 && nextFree) out.slidRows.push({ name: p.name, day: d });
        else if (x < 0.65 && nextFree) out.colSlid.push({ name: p.name, day: d });
        else if (x < 0.85) out.halfDropped.push({ name: p.name, day: d });
        return;
      }
      if (c.split(' ').length === 2 && d < 6 && !hasTimes(cells[d + 1]) && !(cells[d + 1] ?? '').startsWith('[') && r() < 0.4) out.slidRows.push({ name: p.name, day: d });
      else if (/\.5\b/.test(c) && r() < 0.4) out.halfDropped.push({ name: p.name, day: d });
    });
  }
  return out;
}

/** Faint scan: a person with no times this week whose name the row read gets wrong at a double letter. */
function faintName(truth: FamilyTruth, used: Set<string>): Perturbations['faint'] {
  if (!truth.printed.faintNames) return null;
  const pool = truth.people.filter((p) => !used.has(p.name) && !(p.cells ?? []).some(hasTimes));
  const person = pool.find((p) => /([a-z])\1/.test(p.name)) ?? pool[0] ?? truth.people.find((p) => !used.has(p.name));
  if (!person) return null;
  const as = /([a-z])\1/.test(person.name) ? person.name.replace(/([a-z])\1/, '$1$1ai') : person.name.replace(/([a-z])$/, '$1$1');
  return { name: person.name, as };
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
  framing?: 'rows' | 'columns';
}

/** One person's cells as the row read gets them (consistent misreadings included). */
function rowReadCells(truth: FamilyTruth, name: string, cells: string[], p: Perturbations): string[] {
  const out = [...cells];
  const swapDay = p.swapped && p.swapped.name === name ? truth.week.dates.indexOf(p.swapped.date) : -1;
  if (swapDay >= 0) {
    const segs = truth.shifts.filter((s) => s.name === name && s.date === truth.week.dates[swapDay]);
    out[swapDay] = segs.map((s, k) => (k === 0 ? `${s.end}-${s.start}` : `${s.start}-${s.end}`)).join(' / ');
  }
  for (const c of p.colourOverText) if (c.name === name) out[c.day] = `[${c.meaning}]`;
  if (p.slid?.name === name) {
    out[p.slid.day + 1] = out[p.slid.day]!;
    out[p.slid.day] = '';
  }
  for (const s of [...p.hard.slidRows, ...p.hard.shared]) {
    if (s.name !== name) continue;
    out[s.day + 1] = out[s.day]!;
    out[s.day] = '';
  }
  if (p.misread18?.name === name) out[p.misread18.day] = out[p.misread18.day]!.split(' ').map((t, k, all) => (t === '18' && all.indexOf('18') === k ? '18.5' : t)).join(' ');
  if (truth.printed.aiNoise) {
    // Every time in another notation (the same times), then a misread digit and a slipped row.
    out.forEach((c, d) => {
      if (hasTimes(c)) out[d] = otherNotation(truth, name, d) ?? c;
    });
    if (p.noise.digit?.name === name) out[p.noise.digit.day] = laterStart(out[p.noise.digit.day]!);
    if (p.noise.slipped?.name === name) out.splice(p.noise.slipped.day, 1).length && out.push('');
  }
  for (const f of p.faded.shared) if (f.name === name) out[f.day] = laterStart(out[f.day]!);
  return out;
}

const inRows = (i: number, rows?: { from: number; to: number | null }) => !rows || (i >= rows.from && (rows.to === null || i <= rows.to));

/**
 * The answer in the CURRENT transcription schemas (vlmPrompt.ts), for one request: the row
 * framing (first read, or a strict page re-read) or the column framing (the independent second
 * read of a photo or scan).
 */
export function transcriptionAnswer(truth: FamilyTruth, request: MockRequest, p: Perturbations = perturbationsFor(truth)): string {
  const pages = request.focus ? [request.focus.page] : Array.from({ length: truth.pageCount }, (_, i) => i + 1);
  const lastPage = truth.pageCount;
  if (request.framing === 'columns') {
    const out = pages.map((page) => {
      const onPage = truth.people.filter((x) => x.page === page).map((person, idx) => ({ person, i: idx + 1 }));
      const ppl = onPage.map(({ person, i }) => ({ i, nm: p.columns.misread?.name === person.name ? p.columns.misread.as : person.name, t: truth.family === 'B' ? person.role || null : null, h: person.section }));
      const halfDropped = (name: string, d: number, x: string) =>
        p.hard.halfDropped.some((h) => h.name === name && h.day === d) ? (/\.5\b/.test(x) ? x.replace(/(\d+)\.5\b/, '$1') : x.replace(/^(\d+)/, (m) => String(Number(m) + 1))) : x;
      // The column read's own slips: a value slid into the next day (alone, or the same way as the row read).
      const colCells = (person: (typeof onPage)[number]['person']) => {
        const out = [...(person.cells ?? truth.week.dates.map(() => ''))];
        for (const s of [...p.hard.colSlid, ...p.hard.shared]) {
          if (s.name !== person.name) continue;
          out[s.day + 1] = out[s.day]!;
          out[s.day] = '';
        }
        for (const f of [...p.faded.shared, ...p.faded.colDiff]) if (f.name === person.name) out[f.day] = laterStart(out[f.day]!);
        return out;
      };
      const cols = truth.week.dates.map((_, d) => ({
        d,
        c: onPage
          .map(({ person, i }) => ({ i, x: p.columns.missedCell?.name === person.name && p.columns.missedCell.day === d ? '' : halfDropped(person.name, d, colCells(person)[d] ?? '') }))
          .filter((cell) => cell.x),
      }));
      return { p: page, rows: onPage.length, ppl, cols, unread: [] };
    });
    return JSON.stringify({ title: truth.printed.title, days: truth.printed.dayLabels, key: [], pages: out });
  }
  const outPages = pages
    .filter((page) => request.strict || page !== p.missingPage)
    .map((page) => {
      const onPage = truth.people.filter((x) => x.page === page);
      const people = onPage.map((person, idx) => ({ person, i: idx + 1 })).filter(({ i }) => inRows(i, request.focus?.rows));
      const sections: { h: string | null; n: number; ppl: unknown[] }[] = [];
      const unread: { r: number; x: string; w: string }[] = [];
      for (const { person, i } of people) {
        let sec = sections[sections.length - 1];
        if (!sec || sec.h !== person.section) {
          sec = { h: person.section, n: 0, ppl: [] };
          sections.push(sec);
        }
        if (!request.strict && person.name === p.droppedZeroShift) continue; // left out and not counted
        sec.n++;
        if (!request.strict && person.name === p.dropped) continue;
        const cells = rowReadCells(truth, person.name, person.cells ?? truth.week.dates.map(() => ''), p);
        if (!request.strict && p.cutOffLast && page === lastPage && i === onPage.length) {
          unread.push({ r: i, x: [person.name, ...cells].join(' | '), w: 'cut off at the bottom of the page' });
          continue;
        }
        const copied = p.combinedCopied.includes(person.name) ? (truth.printed.combined === 'slash' ? `${person.name} / ${person.role}` : `${person.name} (${person.role})`) : null;
        const name = copied ?? (p.misread?.name === person.name ? p.misread.as : p.faint?.name === person.name ? p.faint.as : person.name);
        const title = copied ? null : truth.family === 'B' ? person.role || null : null;
        const unsure = p.faded.unsure.filter((f) => f.name === person.name).map((f) => f.day);
        const q = unsure.length ? { q: unsure } : {};
        sec.ppl.push(p.swapNameTitle && title ? { nm: title, t: name, i, c: cells, ...q } : { nm: name, t: title, i, c: cells, ...q });
      }
      if (p.footerAsPerson && page === lastPage && !request.focus?.rows?.to) {
        const sec = sections[sections.length - 1] ?? (sections[0] = { h: null, n: 0, ppl: [] });
        sec.ppl.push({ nm: p.footerAsPerson.label, t: null, i: onPage.length + 1, c: p.footerAsPerson.cells });
      }
      const rows = onPage.length - (!request.strict && onPage.some((x) => x.name === p.droppedZeroShift) ? 1 : 0);
      return { p: page, rows, sec: sections, unread };
    });
  return JSON.stringify({ title: truth.printed.title, days: truth.printed.dayLabels, key: [], pages: outPages });
}
