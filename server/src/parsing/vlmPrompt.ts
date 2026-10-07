/**
 * The AI roster reader's instructions and its structured-output schema.
 *
 * The model TRANSCRIBES: every person row, the day headers and each cell exactly as printed.
 * The server interprets: dates come from the printed headers (weekDetection.ts), times from the
 * printed cell text (shiftText.ts) — the same rules as the table reader, so the two readers can
 * be compared cell by cell. That also keeps the answer small (≈60 output tokens per person),
 * far below the output cap even for a 40-person page.
 *
 * Generic on purpose: no venue names, no staff names, no layout from any one customer.
 */
import { createHash } from 'node:crypto';

export const ROSTER_VLM_SYSTEM_PROMPT = `You read staff rotas (weekly shift rosters) from hospitality venues. Every venue
uses its own hand-made layout. Your job is to TRANSCRIBE the roster into the JSON schema, exactly
as printed. Do not interpret dates or convert times: the system does that from your transcription.

WHAT TO RETURN
- "title": the heading printed above the grid, exactly as printed (it often names the week,
  e.g. "Rota 24 - 30 Aug" or "Week of 24/08"); null if there is none.
- "days": one entry per day column, left to right, with the header text exactly as printed.
  When the header is stacked (a date row and a weekday row), join them with a space, e.g.
  "17-Aug MONDAY". Never convert to another format, never add a year, never assume a week.
- "key": the colour key / legend if one is printed: {"c": code or colour, "m": meaning}.
- "pages": one entry per page you were asked to read, in page order.

PEOPLE — LIST EVERY PERSON ROW
- A person row is a row with a person's name. List EVERY one, top to bottom, including people
  with no times at all this week (their cells may be empty, coloured, or leave codes only).
  Never skip a row, never merge two rows, never list a row twice.
- NOT people: section headings / banners (e.g. "SUPERVISORS", "WAITER"), headcount or total
  rows (a number where the name would be), caption rows (covers, pax, events, notes), the
  title, the day headers, the colour key / legend, footers and signatures.
- Before listing, count the person rows on the page ("rows") and in each section ("n").
- Group people by the section heading printed above them ("h", exactly as printed). A group
  with no heading above it gets "h": null — do not invent one and do not borrow text from
  elsewhere on the page (a covers caption or the legend is never a heading).
- "nm": the name exactly as printed (keep spelling, case and spaces).
- "t": the person's own title / role column as printed (e.g. "Head waiter 2", "RM"); null when
  the roster has no such column. Never copy the section heading into "t".
- "i": the person's position among the person rows of that page, counting from 1 at the top.

CELLS — ONE PER DAY, EXACTLY AS PRINTED
- "c" has exactly one string per entry of "days", in the same order.
- Copy the cell text exactly: "9-17", "4pm to 2am", "10am/3pm-7pm/12am", "10:30-4:00-8:00-12",
  "OFF", "AL", "UL", "4CL", "10IN". Keep numbers as printed: "25" stays "25", "18.5" stays
  "18.5". Do not convert to 24-hour time and do not add or drop am/pm.
- When one day is split into several sub-columns (e.g. AM start, AM end, PM start, PM end),
  join that day's sub-cells with single spaces, left to right: "11 17 18 25". Empty sub-cells
  are left out.
- An empty cell is "". A cell with no text whose fill colour the colour key explains is the
  key's meaning in square brackets, e.g. "[Holiday]". A blacked-out or illegible cell is "[?]".
- Only when a cell's text is not plain times or a code (e.g. "noon till late"), add your reading
  to "z": {"d": day index from 0, "s": ["HH:MM-HH:MM", ...]} in 24-hour time; otherwise omit "z".
- "q": day indexes (from 0) of any cell you are not sure you read correctly; omit when sure.

ROWS YOU CANNOT READ
- If you can see a person row but cannot read it, put it in "unread" with what you can read
  ("x") and why ("w"). Never drop it silently.

Return only the JSON object described by the schema.`;

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

/** Google Gen AI `responseSchema` (OpenAPI subset). Keys are short on purpose: they repeat per person. */
export const ROSTER_VLM_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { ...NSTR, description: 'Heading printed above the grid, exactly as printed; null if none.' },
    days: { type: 'ARRAY', items: STR, description: 'Day column headers exactly as printed, left to right; stacked header rows joined with a space.' },
    key: {
      type: 'ARRAY',
      description: 'Colour key / legend, if printed.',
      items: { type: 'OBJECT', properties: { c: STR, m: STR }, required: ['c', 'm'] },
    },
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
                      c: { type: 'ARRAY', items: STR, description: 'One cell per day column, exactly as printed; "" empty, "[Meaning]" colour only, "[?]" illegible.' },
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
          unread: {
            type: 'ARRAY',
            items: { type: 'OBJECT', properties: { r: { ...INT, nullable: true }, x: STR, w: STR }, required: ['x', 'w'] },
          },
        },
        required: ['p', 'rows', 'sec', 'unread'],
      },
    },
  },
  required: ['title', 'days', 'key', 'pages'],
} as const;

/** Changes whenever the prompt or the schema does: part of the AI-reading cache key. */
export const ROSTER_READING_VERSION = createHash('sha256').update(ROSTER_VLM_SYSTEM_PROMPT).update(JSON.stringify(ROSTER_VLM_GEMINI_SCHEMA)).digest('hex').slice(0, 16);

// --- the answer, as the server reads it ---------------------------------------------------------

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
}

/** True for an answer in this schema (as opposed to the original single-list one). */
export function isReadingAnswer(value: unknown): value is ReadingAnswer {
  return !!value && typeof value === 'object' && Array.isArray((value as ReadingAnswer).pages) && Array.isArray((value as ReadingAnswer).days);
}
