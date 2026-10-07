/**
 * The AI roster reader's instructions and its structured-output schemas.
 *
 * The model TRANSCRIBES: every person row, the day headers and each cell exactly as printed.
 * The server interprets: dates come from the printed headers (weekDetection.ts), times from the
 * printed cell text (shiftText.ts) — the same rules as the table reader, so readers can be
 * compared cell by cell. That also keeps the answer small (≈60 output tokens per person), far
 * below the output cap even for a 40-person page.
 *
 * Two framings of the same transcription, so a photo or scan (which has no text layer for the
 * table reader) still gets an independent cross-check:
 *  - rows    (ROSTER_VLM_SYSTEM_PROMPT / ROSTER_VLM_GEMINI_SCHEMA): person by person, each with
 *            one cell per day — the primary read;
 *  - columns (ROSTER_VLM_COLUMN_PROMPT / ROSTER_VLM_COLUMN_SCHEMA): the list of people, then day
 *            column by day column, each cell keyed by the person's row — a second read whose
 *            mistakes (a value slipping into a neighbouring day) don't line up with the first's.
 *
 * Generic on purpose: no venue names, no staff names, no layout from any one customer.
 */
import { createHash } from 'node:crypto';

const INTRO = `You read staff rotas (weekly shift rosters) from hospitality venues. Every venue
uses its own hand-made layout. Your job is to TRANSCRIBE the roster into the JSON schema, exactly
as printed. Do not interpret dates or convert times: the system does that from your transcription.`;

const HEADINGS = `- "title": the heading printed above the grid, exactly as printed (it often names the week,
  e.g. "Rota 24 - 30 Aug" or "Week of 24/08"); null if there is none.
- "days": one entry per day column, left to right, with the header text exactly as printed.
  When the header is stacked (a date row and a weekday row), join them with a space, e.g.
  "17-Aug MONDAY". Never convert to another format, never add a year, never assume a week.
- "key": the colour key / legend if one is printed: {"c": code or colour, "m": meaning}.
- "pages": one entry per page you were asked to read, in page order.`;

const PEOPLE = `PEOPLE — LIST EVERY PERSON ROW
- A person row is a row with a person's name. List EVERY one, top to bottom, including people
  with no times at all this week (their cells may be empty, coloured, or leave codes only).
  Never skip a row, never merge two rows, never list a row twice.
- A row whose name you can read is a person: list it, with "[?]" in any cell you can't read.
  A row is cut off only when the page edge actually cuts through it.
- NOT people: section headings / banners (e.g. "SUPERVISORS", "WAITER", "BAR", "HOSTS",
  "MANAGEMENT"), column headings ("NAME", "TITLE", "#", "No.", "POSITION"), headcount, count or
  total lines (a number where the name would be, or "Total staff …", "Headcount"), caption rows
  (covers, pax, events, notes), the title, the day headers, the colour key / legend, footers,
  "Prepared by" / "Printed on" / "issued" / "generated" lines and signatures.
- Before listing, count the person rows on the page ("rows").
- "nm": the person's NAME exactly as printed (keep spelling, case and spaces). The name column
  and a title / role column can come in either order; job titles such as "Waiter 3", "Head
  waiter 1", "RM", "AGM", "Supervisor" or "Ops Manager" are titles, never names. Never join the
  title or a row number onto the name: "Ana Silva" with "RM" beside it is "nm": "Ana Silva",
  "t": "RM". A "#" / "No." / "S/N" column holds row numbers, never names.
- "t": the person's own title / role column as printed; null when the roster has no such column.
  Never copy the section heading into "t".
- "i": the person's position among the person rows of that page, counting from 1 at the top.`;

const CELL_TEXT = `- Copy the cell text exactly: "9-17", "4pm to 2am", "10am/3pm-7pm/12am", "10:30-4:00-8:00-12",
  "OFF", "AL", "UL", "4CL", "10IN". Keep numbers as printed: "25" stays "25", "18.5" stays
  "18.5", "18" stays "18". Do not convert to 24-hour time and do not add or drop am/pm.
- When one day is split into several sub-columns (e.g. AM start, AM end, PM start, PM end),
  join that day's sub-cells with single spaces, left to right: "11 17 18 25". Empty sub-cells
  are left out. Each value belongs to the day whose header is above it: a day with only PM
  times stays on that day.
- A cell's TEXT always wins over its colour: a cell that shows numbers or times is copied as
  numbers or times, whatever its fill colour. Only a cell with NO text at all whose fill colour
  the colour key explains is written as the key's meaning in square brackets, e.g. "[Holiday]".
- An empty cell is "". A blacked-out or illegible cell is "[?]".`;

const UNREAD = `ROWS YOU CANNOT READ
- If you can see a person row but cannot read its name, put it in "unread" with what you can
  read ("x") and why ("w"). Never drop it silently.

Return only the JSON object described by the schema.`;

export const ROSTER_VLM_SYSTEM_PROMPT = `${INTRO}

WHAT TO RETURN
${HEADINGS}

${PEOPLE}
- Group people by the section heading printed above them ("h", exactly as printed) and count
  the person rows in each section ("n"). A group with no heading above it gets "h": null — do
  not invent one and do not borrow text from elsewhere on the page (a covers caption or the
  legend is never a heading).

CELLS — ONE PER DAY, EXACTLY AS PRINTED
- "c" has exactly one string per entry of "days", in the same order.
${CELL_TEXT}
- Only when a cell's text is not plain times or a code (e.g. "noon till late"), add your reading
  to "z": {"d": day index from 0, "s": ["HH:MM-HH:MM", ...]} in 24-hour time; otherwise omit "z".
- "q": day indexes (from 0) of any cell you are not sure you read correctly; omit when sure.

${UNREAD}`;

export const ROSTER_VLM_COLUMN_PROMPT = `${INTRO}
Work COLUMN BY COLUMN: first list the people, then go down one day column at a time.

WHAT TO RETURN
${HEADINGS}

${PEOPLE}
- "h": the section heading printed above the person (exactly as printed); null when none.

CELLS — DAY COLUMN BY DAY COLUMN
- "cols" has one entry per entry of "days" ("d" = day index from 0, left to right). Go down that
  day's column from the top and, for every person row whose cell in that column is not empty,
  give {"i": the person's "i", "x": the cell exactly as printed}. Leave out empty cells.
- Read each column under its own header: check the header above every value you write.
- Half days: when a day is split into AM and PM sub-columns, go down that day's AM and PM
  sub-columns before moving on to the next day, and write the day's values left to right in
  one "x" ("10.5 15 18 23.5"). A person with only PM values that day ("18 23.5"), or only AM
  values, keeps them on THAT day: never move a value into the next or the previous day.
- Keep every half hour exactly: "10.5" stays "10.5" and "23.5" stays "23.5" — never drop,
  round or shorten the ".5". Write every value in the cell, in the order printed.
${CELL_TEXT}

${UNREAD}`;

/** Extra instruction for a focused read: one page, or part of one (the second, stricter pass). */
export function focusInstruction(page: number, rows?: { from: number; to: number | null }, strict = false): string {
  const span = rows
    ? rows.to
      ? `only person rows ${rows.from} to ${rows.to} (counted from the top of the page; keep their "i")`
      : `only person rows ${rows.from} to the last one (counted from the top of the page; keep their "i")`
    : 'every person row on it';
  const check = strict
    ? ' Go row by row from the top; for each person row check that it is in your answer before moving on. ' +
      'Include people with no times this week. Count the person rows again at the end ("rows") and make sure your list has that many people.'
    : '';
  return `Read ONLY page ${page}, and ${span}. Return exactly one entry in "pages" (p = ${page}).${check}`;
}

const STR = { type: 'STRING' };
const NSTR = { type: 'STRING', nullable: true };
const INT = { type: 'INTEGER' };

const TOP = {
  title: { ...NSTR, description: 'Heading printed above the grid, exactly as printed; null if none.' },
  days: { type: 'ARRAY', items: STR, description: 'Day column headers exactly as printed, left to right; stacked header rows joined with a space.' },
  key: {
    type: 'ARRAY',
    description: 'Colour key / legend, if printed.',
    items: { type: 'OBJECT', properties: { c: STR, m: STR }, required: ['c', 'm'] },
  },
} as const;
const UNREAD_SCHEMA = {
  type: 'ARRAY',
  items: { type: 'OBJECT', properties: { r: { ...INT, nullable: true }, x: STR, w: STR }, required: ['x', 'w'] },
} as const;

/** Google Gen AI `responseSchema` (OpenAPI subset). Keys are short on purpose: they repeat per person. */
export const ROSTER_VLM_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ...TOP,
    pages: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          p: { ...INT, description: 'Page number, from 1.' },
          rows: { ...INT, description: 'Person rows visible on this page (every person, including people with no times).' },
          sec: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                h: { ...NSTR, description: 'Section heading as printed above this group; null when none.' },
                n: { ...INT, description: 'Person rows in this section.' },
                ppl: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      nm: { ...STR, description: 'Name exactly as printed.' },
                      t: { ...NSTR, description: "The person's own title/role column as printed; null when there is none." },
                      i: { ...INT, description: 'Position among the person rows of the page, from 1 at the top.' },
                      c: { type: 'ARRAY', items: STR, description: 'One cell per day column, exactly as printed; "" empty, "[Meaning]" colour only (no text), "[?]" illegible.' },
                      z: {
                        type: 'ARRAY',
                        description: 'Only for cells whose text is not plain times or a code: your reading in 24h time.',
                        items: { type: 'OBJECT', properties: { d: INT, s: { type: 'ARRAY', items: STR } }, required: ['d', 's'] },
                      },
                      q: { type: 'ARRAY', items: INT, description: 'Day indexes of cells you are unsure about.' },
                    },
                    required: ['nm', 't', 'i', 'c'],
                  },
                },
              },
              required: ['h', 'n', 'ppl'],
            },
          },
          unread: UNREAD_SCHEMA,
        },
        required: ['p', 'rows', 'sec', 'unread'],
      },
    },
  },
  required: ['title', 'days', 'key', 'pages'],
} as const;

/** The column-by-column framing of the same transcription (the second, independent read). */
export const ROSTER_VLM_COLUMN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ...TOP,
    pages: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          p: { ...INT, description: 'Page number, from 1.' },
          rows: { ...INT, description: 'Person rows visible on this page (every person, including people with no times).' },
          ppl: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                i: { ...INT, description: 'Position among the person rows of the page, from 1 at the top.' },
                nm: { ...STR, description: 'Name exactly as printed.' },
                t: { ...NSTR, description: "The person's own title/role column as printed; null when there is none." },
                h: { ...NSTR, description: 'Section heading printed above the person; null when none.' },
              },
              required: ['i', 'nm', 't', 'h'],
            },
          },
          cols: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                d: { ...INT, description: 'Day index, from 0, left to right.' },
                c: {
                  type: 'ARRAY',
                  description: 'Non-empty cells of this day column, top to bottom.',
                  items: { type: 'OBJECT', properties: { i: INT, x: STR }, required: ['i', 'x'] },
                },
              },
              required: ['d', 'c'],
            },
          },
          unread: UNREAD_SCHEMA,
        },
        required: ['p', 'rows', 'ppl', 'cols', 'unread'],
      },
    },
  },
  required: ['title', 'days', 'key', 'pages'],
} as const;

/** Changes whenever a prompt or a schema does: part of the AI-reading cache key. */
export const ROSTER_READING_VERSION = createHash('sha256')
  .update(ROSTER_VLM_SYSTEM_PROMPT)
  .update(JSON.stringify(ROSTER_VLM_GEMINI_SCHEMA))
  .update(ROSTER_VLM_COLUMN_PROMPT)
  .update(JSON.stringify(ROSTER_VLM_COLUMN_SCHEMA))
  .digest('hex')
  .slice(0, 16);

// --- the answers, as the server reads them -------------------------------------------------------

export interface ReadingAnswerPerson {
  nm: string;
  t: string | null;
  i: number;
  c: string[];
  z?: { d: number; s: string[] }[];
  q?: number[];
}
export interface ReadingAnswerPage {
  p: number;
  rows: number;
  sec: { h: string | null; n: number; ppl: ReadingAnswerPerson[] }[];
  unread: { r?: number | null; x: string; w: string }[];
}
export interface ReadingAnswer {
  title: string | null;
  days: string[];
  key: { c: string; m: string }[];
  pages: ReadingAnswerPage[];
  /** Cached only: the second, column-by-column reading of the same file (a photo or scan). */
  cross?: ReadingAnswer;
}

export interface ColumnAnswer {
  title: string | null;
  days: string[];
  key: { c: string; m: string }[];
  pages: {
    p: number;
    rows: number;
    ppl: { i: number; nm: string; t: string | null; h: string | null }[];
    cols: { d: number; c: { i: number; x: string }[] }[];
    unread: { r?: number | null; x: string; w: string }[];
  }[];
}

/** True for an answer in the row schema (as opposed to the original single-list one). */
export function isReadingAnswer(value: unknown): value is ReadingAnswer {
  return !!value && typeof value === 'object' && Array.isArray((value as ReadingAnswer).pages) && Array.isArray((value as ReadingAnswer).days);
}

/** True for an answer in the column schema. */
export function isColumnAnswer(value: unknown): value is ColumnAnswer {
  return isReadingAnswer(value) && (value as unknown as ColumnAnswer).pages.every((p) => Array.isArray(p.cols) && Array.isArray(p.ppl));
}

/** The column-by-column answer laid out person by person, so both reads map the same way. */
export function columnsToRows(answer: ColumnAnswer): ReadingAnswer {
  const days = answer.days ?? [];
  return {
    title: answer.title ?? null,
    days,
    key: answer.key ?? [],
    pages: (answer.pages ?? []).map((page) => {
      const sec: ReadingAnswerPage['sec'] = [];
      for (const person of [...(page.ppl ?? [])].sort((a, b) => a.i - b.i)) {
        const cells = days.map((_, d) => page.cols?.find((col) => col.d === d)?.c?.find((cell) => cell.i === person.i)?.x ?? '');
        let current = sec[sec.length - 1];
        if (!current || current.h !== (person.h ?? null)) {
          current = { h: person.h ?? null, n: 0, ppl: [] };
          sec.push(current);
        }
        current.n++;
        current.ppl.push({ nm: person.nm, t: person.t ?? null, i: person.i, c: cells });
      }
      return { p: page.p, rows: page.rows, sec, unread: page.unread ?? [] };
    }),
  };
}
