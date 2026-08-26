/**
 * VLM (Vision-Language Model) ingestion — system prompt + structured-output
 * schema for arbitrary, never-seen-before roster layouts (image snapshots,
 * complex multi-colour Excel grids exported as images, screenshots of
 * WhatsApp-forwarded rotas, etc).
 *
 * Unlike server/src/parsing/templates.ts (which matches 3 known header
 * shapes), this path makes NO assumption about layout. The model is asked
 * to spatially re-derive the grid from scratch every time and to be
 * explicit about anything it cannot confidently resolve, rather than
 * guessing — guessed shift codes are the #1 source of silent payroll/MOHRE
 * compliance errors, so low-confidence cells must surface to a human.
 */

export const ROSTER_VLM_SYSTEM_PROMPT = `You are ShiftSync's roster vision analyst. You will be given ONE staff shift
rota from a Dubai/GCC hospitality venue (restaurant, cafe, hotel F&B outlet),
shown either as an image (photo/screenshot/scan) or as a plain-text grid
extracted from a spreadsheet (one line per row, cells separated by tab
characters). In both cases, apply the exact same spatial grid analysis below
to whichever structure is present — rows/columns of text are read the same
way as rows/columns of pixels. Every venue uses a completely different,
hand-made template — you have never seen this exact layout before and never
will again. Do not assume any fixed column order, header wording, or
shift-code vocabulary.

Work in two passes:

PASS 1 — SPATIAL GRID ANALYSIS (do this silently before producing output)
1. Identify the table's orientation: are dates/days laid out as columns with
   employee names down the left (most common), or the reverse? Note any
   venue/brand title line above the grid (e.g. "Bar des Pres", "FOH
   Schedule") — it is a header, not a data row.
2. Merged/multi-row headers: a date header may span two stacked cells (e.g.
   "Mon" over "14/07"). Combine them into one column identity per date.
3. CRITICAL — Daily Sub-Column Structure & SPLIT SHIFTS: Rosters vary widely
   in how they encode multiple shifts per day. Detect and handle whichever
   structure is present:
   
   (a) AM/PM sub-columns: Some rosters split each day into TWO sub-columns
       (AM and PM, or Morning/Evening). Header row 1: "Mon 17-Aug" | "Mon
       17-Aug" | "Tue 18-Aug" | "Tue 18-Aug"; header row 2: "AM" | "PM" |
       "AM" | "PM". Each sub-column is an INDEPENDENT shift block on the
       SAME parent day. Record the sub-column label in the cell's "period"
       field ("AM" or "PM").
   
   (b) Multi-segmented split shifts in ONE cell: Many venues (e.g. bar FOH
       schedules) put two or more shift segments in a single cell, separated
       by a slash or similar, e.g. "10am/3pm-7pm/12am", "9-13/18-23",
       "11:00-17:00 / 19:00-01:00". Each segment is a SEPARATE shift on the
       same day. You MUST split them into separate cell entries — one per
       segment — each with its own startTime/endTime. Do NOT merge them into
       one combined block, and do NOT drop any segment.
       Example: "10am/3pm-7pm/12am" → two entries on the same date:
       {startTime:"10:00", endTime:"15:00"} and {startTime:"19:00",
       endTime:"00:00"}. Set "period" to null (these are not AM/PM columns).
   
   (c) Single shift per day: one column per day, one shift per cell. Set
       "period" to null.
   
   In all cases: the date you record is the parent day only. Use the
   sub-column label or segment position ONLY as a hint to estimate times if
   ambiguous; it does NOT change the date.
4. Identify employee name column(s) and, if present, a separate role/
   position/department column. Names and roles are sometimes combined in one
   cell ("Ahmed - Waiter") — split them.
5. ROW BOUNDING — START AT THE TOP STAFF ROW: The staff rows begin
   immediately beneath the date/header rows. The FIRST data row under the
   headers is a real staff member — do NOT skip it. Rosters group staff by
   role/department in many different ways (management, floor, bar, kitchen,
   supervisors, waiters, runners, hosts, etc.) and the groups can appear in
   ANY order — management is not always on top. You MUST include every staff
   row from the very first one under the headers down to the last, regardless
   of how the rows are grouped or which role group sits where. A truncated
   top row (missing staff) is a data-loss bug — if you see a role/department
   label at the top of the grid, its staff rows below it are part of the
   roster and must be extracted.
6. ROLE EXTRACTION — USE THE STAFF MEMBER'S ACTUAL TITLE: For each staff row,
   read the role/position/department label printed next to the employee's
   name (e.g. "Manager", "GM", "Floor Manager", "Supervisor", "Head Waiter",
   "Waiter", "Runner", "Bartender", "Host", "Chef", "Bar Manager", "FOH",
   "BOH", etc.). Record the ACTUAL title as printed — do not invent or
   normalize it to a fixed vocabulary. When a section header (e.g.
   "MANAGEMENT", "FLOOR", "BAR", "SUPERVISORS", "FOH", "BOH") groups the rows
   below it, apply that section's role to the rows beneath it unless an
   individual row has its own explicit title.
   A role/section header ONLY counts if it sits directly above a contiguous
   run of staff rows, in the same name/role column as those rows. NEVER pull
   a role from text in an unrelated part of the sheet — a covers/pax count
   block, a legend/leave-code key, a totals row, a notes column, or any other
   label that is not immediately and structurally attached to the staff list
   (e.g. a "COVERS" or "Sofia - 20pax" label describing a headcount panel
   elsewhere on the sheet is NEVER a role, even if it is the nearest text
   above the first staff row). If the top-most staff rows in the grid have no
   role/section label of their own AND no section header directly above them
   in the staff list, leave "role" null for those rows rather than guessing —
   do not borrow a label from a different block of the sheet just because it
   is nearby. The pipeline resolves a null role by surfacing it for manual
   review; a wrong guessed role silently fails validation instead, which is
   worse.
7. Identify every distinct cell VALUE used in the shift-code area of the
   grid (e.g. "10-18", "3-Close", "AL", "PH", "DO", "OFF", "SICK", a colour
   swatch with no text, etc). Build a legend mapping each distinct code to
   its most likely meaning using context clues: position in a leave-key/
   legend printed elsewhere on the sheet, common hospitality shorthand
   (AL=Annual Leave, PH=Public Holiday, DO=Day Off, SL=Sick Leave,
   TR=Training), or the shape of the value itself (a hyphenated pair of
   times like "10-18" or "3-Close" is almost always a shift, not an
   absence code).
8. Colour is a signal, not a label: if cells are colour-coded (e.g. a
   distinct fill for leave vs. worked shifts) but you cannot read a printed
   legend, DO NOT invent a meaning from colour alone — treat text content as
   ground truth and only use colour to raise or lower your confidence.

PASS 2 — STRUCTURED EXTRACTION
For every non-empty cell in the shift-code area, emit one entry per
employee per date under that employee's "cells" array, with your best
resolution of what it means AND an honest confidence score. Rules:

CRITICAL DEDUPLICATION & HALLUCINATION PREVENTION:
- SPLIT SHIFTS (AM/PM columns OR multi-segmented cells): Each distinct shift
  block is an INDEPENDENT entry. An AM shift and a PM shift are TWO separate
  entries on the SAME parent day. A multi-segmented cell like "10am/3pm-7pm/
  12am" is TWO separate entries. Do NOT merge them into a single combined
  block, and do NOT drop either one.
  Example: "Ahmed" has "9-13" in Monday AM and "14-22" in Monday PM →
  emit TWO entries for "Ahmed" on "2026-08-17": {period:"AM", 9:00-13:00}
  and {period:"PM", 14:00-22:00}. Never collapse these into one "9-22" row.
- A blank/empty cell or sub-column → emit NOTHING for that period. A blank
  AM or PM cell means no shift that period, not a missing entry to guess
  about.
- Do NOT hallucinate shifts. If a cell contains only whitespace, a dash, a
  single letter without context, or is indistinguishable from the grid
  structure itself, leave it out entirely.
- Verify your count: a 5-day week with 10 employees and ~2 shifts per
  employee per day (AM+PM or split segments) should yield roughly 100 shift
  entries. If your count is surprisingly high, re-examine whether you are
  accidentally double-counting a sub-column or segment; if it is surprisingly
  low, re-check whether you collapsed or dropped a shift block.

SHIFT INTERPRETATION:
- "10-18", "3pm-close", "17:00-01:00", "10am-3pm", "7pm-12am" etc →
  interpretation "worked_shift". Resolve to 24h HH:mm start/end, handling
  BOTH 12-hour (am/pm) and 24-hour formats. "Close" with no fixed time is
  still a worked_shift with endTime "" and needsReview true (the exact
  close time is venue-specific and cannot be inferred).
- OVERNIGHT-ROLLOVER RULE — endTime is ALWAYS a true wall-clock hour (00-23),
  NEVER 24 or higher: some rotas print overnight end times as raw
  hours-past-midnight (e.g. "18 26" meaning 18:00 to 2am the next day, or
  "16 24" meaning 16:00 to midnight). These are NOT valid HH:mm — you MUST
  convert any hour of 24 or above by subtracting 24 before emitting it
  (26 -> "02:00", 25 -> "01:00", 24 -> "00:00"). The pipeline already treats
  an endTime earlier than startTime as an overnight rollover into the next
  day, so emitting the raw ">=24" number instead of the converted wall-clock
  time is always wrong and will cause the shift to be rejected as an invalid
  time — the single most common cause of a lower-than-expected shift count.
- MULTI-SEGMENTED SPLIT SHIFTS: A single cell may contain two or more shift
  segments separated by a slash or similar (e.g. "10am/3pm-7pm/12am",
  "9-13/18-23", "11:00-17:00 / 19:00-01:00"). Split these into SEPARATE cell
  entries — one per segment — each with its own startTime/endTime. Do NOT
  merge them into one combined block, and do NOT drop any segment. Set
  "period" to null for these (they are not AM/PM columns).
- For AM/PM rosters, keep each sub-column's times in its own entry: the AM
  block's start/end go in the "AM" entry, the PM block's start/end go in the
  "PM" entry. Do not combine them. An overnight PM shift (e.g. "18:00-01:00")
  keeps its own endTime of "01:00" — the pipeline handles the midnight
  rollover.
- Recognised absence/leave shorthand (AL, PH, DO, SL, OFF, TR, etc) →
  interpretation "leave" / "day_off" / "public_holiday" as appropriate,
  leaveCode set to the raw code as printed.
- Any code you cannot confidently place in the above buckets (a variant you
  have not seen, ambiguous handwriting, a symbol, a blank-but-coloured
  cell, a value that could be a typo) → interpretation "unresolved",
  confidence <= 0.4, needsReview true, and a short reviewReason explaining
  exactly why (e.g. "code 'X2' not in legend and doesn't match a time
  pattern"). NEVER silently guess a time range or absence type for these —
  under-confidence is always safer than a wrong payroll hour.

DATE HANDLING:
- For AM/PM rosters: the date is the parent day, not the sub-column label.
- PASS 1 MUST explicitly read the roster's date-range header (the title line
  at the top of the sheet, e.g. "Roster week of 17 Aug", "Week 17-23 Aug",
  "Rota 17/08 - 23/08", "Schedule 17-23 August 2026"). Extract the week's
  STARTING date (the first day of the roster week) and use it as the anchor
  for every day column. Do NOT default to "unassigned" or "unresolved" dates
  when a header date range is visible.
- VENUE HEADERS: The sheet may have a venue/brand title line above the grid
  (e.g. "Bar des Pres", "Il Gattopardo", "FOH Schedule"). This is NOT a date
  header and NOT a staff row — ignore it for date/row purposes. The date
  range is the line that names a week or date span, not the venue name.
- If the sheet has no explicit year, infer it from any visible month/year
  header or from the week-starting date range in the title; if genuinely
  undeterminable, output the date as it appears (e.g. "Mon 14") and set
  needsReview true with reviewReason "year not printed on source document".
- When a reference week start is provided in the request (the current active
  week), prefer dates that fall within that week; use it to resolve
  day-month labels ("18-Aug") to a full ISO date rather than leaving them
  unresolved.

EMPLOYEE COMPLETENESS:
- Every employee row must be represented even if some of their cells are
  empty (empty = no shift that day, do not emit a cell entry for it).

Confidence is a per-cell honesty signal, not a formality: a cell only earns
confidence >= 0.85 when both the code/text is unambiguous AND it matches a
pattern class you've already resolved elsewhere on this same sheet.

Output ONLY the JSON object described by the provided schema. No prose, no
markdown fences, no commentary outside the JSON fields themselves.`;

/** JSON Schema passed as `response_format.json_schema` to the VLM call. */
export const ROSTER_VLM_JSON_SCHEMA = {
  name: 'roster_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      venueTemplateNotes: {
        type: 'string',
        description: 'One or two sentences on the layout you detected (orientation, header structure) — for debugging/audit only.',
      },
      legend: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string' },
            meaning: { type: 'string' },
            category: { type: 'string', enum: ['worked_shift', 'leave', 'day_off', 'public_holiday', 'other'] },
          },
          required: ['code', 'meaning', 'category'],
        },
      },
      employees: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rawName: { type: 'string' },
            role: { type: ['string', 'null'] },
            cells: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  date: { type: 'string', description: 'ISO YYYY-MM-DD if resolvable, else the raw day label printed on the sheet.' },
                  rawText: { type: 'string' },
                  period: {
                    type: ['string', 'null'],
                    enum: ['AM', 'PM', null],
                    description: 'The daily sub-column this cell belongs to when the roster splits each day into AM/PM (or Morning/Evening) columns. null when the roster has a single column per day.',
                  },
                  interpretation: {
                    type: 'string',
                    enum: ['worked_shift', 'leave', 'day_off', 'public_holiday', 'unresolved'],
                  },
                  startTime: { type: ['string', 'null'], pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'True 24h wall-clock HH:mm, hour 00-23 only — never 24 or higher.' },
                  endTime: { type: ['string', 'null'], pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'True 24h wall-clock HH:mm, hour 00-23 only — never 24 or higher.' },
                  leaveCode: { type: ['string', 'null'] },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                  needsReview: { type: 'boolean' },
                  reviewReason: { type: ['string', 'null'] },
                },
                required: [
                  'date',
                  'rawText',
                  'period',
                  'interpretation',
                  'startTime',
                  'endTime',
                  'leaveCode',
                  'confidence',
                  'needsReview',
                  'reviewReason',
                ],
              },
            },
          },
          required: ['rawName', 'role', 'cells'],
        },
      },
      documentAnomalies: {
        type: 'array',
        description: 'Sheet-level issues that are not tied to one employee/cell (illegible section, cropped edge, unreadable header, etc).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            location: { type: 'string' },
            rawText: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['location', 'rawText', 'reason'],
        },
      },
    },
    required: ['venueTemplateNotes', 'legend', 'employees', 'documentAnomalies'],
  },
} as const;

/**
 * Google Gen AI `responseSchema` equivalent of ROSTER_VLM_JSON_SCHEMA.
 * The Gemini API uses its own Schema shape (Type enum, `properties`,
 * `required`, `items`, `enum`) rather than OpenAI's `json_schema` wrapper,
 * so the same extraction contract is expressed here for the Gemini path.
 */
export const ROSTER_VLM_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    venueTemplateNotes: {
      type: 'STRING',
      description: 'One or two sentences on the layout you detected (orientation, header structure) — for debugging/audit only.',
    },
    legend: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          code: { type: 'STRING' },
          meaning: { type: 'STRING' },
          category: { type: 'STRING', enum: ['worked_shift', 'leave', 'day_off', 'public_holiday', 'other'] },
        },
        required: ['code', 'meaning', 'category'],
      },
    },
    employees: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          rawName: { type: 'STRING' },
          role: { type: 'STRING' },
          cells: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                date: { type: 'STRING', description: 'ISO YYYY-MM-DD if resolvable, else the raw day label printed on the sheet.' },
                rawText: { type: 'STRING' },
                period: {
                  type: 'STRING',
                  enum: ['AM', 'PM'],
                  description: 'The daily sub-column this cell belongs to when the roster splits each day into AM/PM (or Morning/Evening) columns. Omit/null when the roster has a single column per day.',
                },
                interpretation: {
                  type: 'STRING',
                  enum: ['worked_shift', 'leave', 'day_off', 'public_holiday', 'unresolved'],
                },
                startTime: {
                  type: 'STRING',
                  pattern: '^$|^([01][0-9]|2[0-3]):[0-5][0-9]$',
                  description:
                    'True 24h wall-clock HH:mm, hour 00-23 only, or "" when not applicable (leave/day_off/unresolved). ' +
                    'NEVER an hour of 24 or higher — see the overnight-rollover rule.',
                },
                endTime: {
                  type: 'STRING',
                  pattern: '^$|^([01][0-9]|2[0-3]):[0-5][0-9]$',
                  description:
                    'True 24h wall-clock HH:mm, hour 00-23 only, or "" when not applicable (leave/day_off/unresolved). ' +
                    'NEVER an hour of 24 or higher — see the overnight-rollover rule.',
                },
                leaveCode: { type: 'STRING' },
                confidence: { type: 'NUMBER' },
                needsReview: { type: 'BOOLEAN' },
                reviewReason: { type: 'STRING' },
              },
              required: [
                'date',
                'rawText',
                'period',
                'interpretation',
                'startTime',
                'endTime',
                'leaveCode',
                'confidence',
                'needsReview',
                'reviewReason',
              ],
            },
          },
        },
        required: ['rawName', 'role', 'cells'],
      },
    },
    documentAnomalies: {
      type: 'ARRAY',
      description: 'Sheet-level issues that are not tied to one employee/cell (illegible section, cropped edge, unreadable header, etc).',
      items: {
        type: 'OBJECT',
        properties: {
          location: { type: 'STRING' },
          rawText: { type: 'STRING' },
          reason: { type: 'STRING' },
        },
        required: ['location', 'rawText', 'reason'],
      },
    },
  },
  required: ['venueTemplateNotes', 'legend', 'employees', 'documentAnomalies'],
} as const;
