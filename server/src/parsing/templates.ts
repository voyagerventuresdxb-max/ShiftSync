import type { TemplateDefinition, TemplateField } from './types.js';

/**
 * Lowercase, strip punctuation, collapse whitespace. Used to fuzzy-match
 * headers AND (via `nameKey` in resolveRows.ts) to key employee/role name
 * lookups against the database.
 *
 * Uses Unicode property escapes (`\p{L}` = any letter in any script, `\p{N}`
 * = any number) rather than an ASCII-only `[a-z0-9]` class. This is
 * deliberate: an ASCII-only class strips every character of a non-Latin
 * name (Arabic, etc.) to nothing, so two DIFFERENT people/roles with
 * different Arabic names both normalize to the same empty/whitespace key —
 * a real collision that silently matches one person's roster row to a
 * DIFFERENT person's DB record. Preserving `\p{L}` keeps each script's
 * actual letters in the key, so distinct non-Latin strings normalize to
 * distinct, non-empty keys. `\p{L}`/`\p{N}` are supersets of `a-z`/`0-9`,
 * so plain-ASCII/English/French-service header and role matching (e.g.
 * "Employee Name", "Chef de Rang") is completely unaffected — this only
 * widens what's KEPT, it never changes how already-ASCII input normalizes.
 * `.toLowerCase()` is a case-mapping no-op on scripts without case (Arabic,
 * CJK, etc.), so it doesn't need special-casing here either.
 *
 * DELIBERATELY DOES NOT fold/strip Unicode combining marks (accents,
 * Arabic tashkeel, etc.) — an `.normalize('NFKD') + strip \p{M}` approach
 * was tried and reverted after review: it does fold Arabic diacritics and
 * Latin accents correctly, but it ALSO strips the tone marks that make two
 * DIFFERENT Vietnamese names distinct ("Nguyễn" vs "Nguyên" both -> "nguyen",
 * verified empirically) — reintroducing the exact silent-collision bug
 * this function exists to prevent, just for a different script. Since a
 * blanket mark-strip isn't provably safe across every script without a much
 * more careful, script-aware pass, the safer, narrower fix was kept: two
 * different Arabic names still never collide (they keep their own distinct
 * base letters), but the SAME Arabic name spelled with vs. without
 * diacritics currently produces two different keys, which fails safe (an
 * unmatched/new_employee prompt for manual review) rather than failing
 * dangerous (a silent wrong-person match). See MEMORY.md for the full
 * investigation and the Devanagari dependent-vowel-sign collision risk
 * this function was found to ALSO carry independent of this decision.
 */
export function normalizeHeader(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * ShiftSync's 3 supported master roster templates.
 *
 * TEMPLATE 1 (STANDARD)   — separate Start Time / End Time columns, 24h or 12h.
 * TEMPLATE 2 (COMPACT)    — abbreviated headers used by smaller independents
 *                           ("Staff", "Position", "Time In" / "Time Out").
 * TEMPLATE 3 (TIME_RANGE) — a single "Shift Time" column with a combined
 *                           range, e.g. "9:00 AM - 5:00 PM" or "17:00-01:00".
 */
export const TEMPLATES: TemplateDefinition[] = [
  {
    id: 'STANDARD',
    label: 'Standard Roster Export',
    combinedTimeRange: false,
    requiredFields: ['employeeName', 'role', 'date', 'startTime', 'endTime'],
    aliases: {
      employeeName: ['employee name', 'staff name', 'name', 'full name'],
      role: ['role', 'position', 'job role', 'job title'],
      date: ['date', 'shift date', 'work date'],
      startTime: ['start time', 'shift start', 'start'],
      endTime: ['end time', 'shift end', 'end'],
      managerNotes: ['manager floor notes', 'manager notes', 'floor notes', 'notes', 'side work notes'],
      breakMinutes: ['break minutes', 'break mins', 'break', 'break duration'],
    },
  },
  {
    id: 'COMPACT',
    label: 'Compact Weekly Grid',
    combinedTimeRange: false,
    requiredFields: ['employeeName', 'role', 'date', 'startTime', 'endTime'],
    aliases: {
      employeeName: ['staff', 'employee', 'name'],
      role: ['position', 'dept', 'department', 'role'],
      date: ['shift date', 'date'],
      startTime: ['time in', 'clock in', 'start'],
      endTime: ['time out', 'clock out', 'end'],
      managerNotes: ['notes', 'remarks', 'floor notes'],
      breakMinutes: ['break', 'break mins'],
    },
  },
  {
    id: 'TIME_RANGE',
    label: 'Combined Time-Range Export',
    combinedTimeRange: true,
    requiredFields: ['employeeName', 'role', 'date', 'startTime'],
    aliases: {
      employeeName: ['name', 'employee name', 'staff name'],
      role: ['role', 'position'],
      date: ['date'],
      // combinedTimeRange templates hold "start-end" in the startTime column
      startTime: ['shift time', 'time', 'shift', 'hours'],
      endTime: [],
      managerNotes: ['floor notes', 'manager floor notes', 'notes'],
      breakMinutes: ['break minutes', 'break'],
    },
  },
];

const ALL_FIELDS: TemplateField[] = [
  'employeeName',
  'role',
  'date',
  'startTime',
  'endTime',
  'managerNotes',
  'breakMinutes',
];

export interface ColumnMap {
  field: TemplateField;
  columnHeader: string;
}

export interface TemplateMatch {
  template: TemplateDefinition;
  columnMap: ColumnMap[];
}

/**
 * Attempts to match a spreadsheet's header row against each of the 3 master
 * templates, in order. Returns the first template whose `requiredFields` all
 * resolve to a present column, plus the resolved header->field mapping.
 */
export function detectTemplate(headerRow: unknown[]): TemplateMatch | null {
  const normalizedHeaders = headerRow.map((h) => ({ raw: String(h ?? ''), normalized: normalizeHeader(h) }));

  for (const template of TEMPLATES) {
    const columnMap: ColumnMap[] = [];
    let matchesAllRequired = true;

    for (const field of ALL_FIELDS) {
      const aliases = template.aliases[field];
      const found = normalizedHeaders.find((h) => aliases.includes(h.normalized));
      if (found) {
        columnMap.push({ field, columnHeader: found.raw });
      } else if (template.requiredFields.includes(field)) {
        matchesAllRequired = false;
      }
    }

    if (matchesAllRequired) {
      return { template, columnMap };
    }
  }

  return null;
}

/** Human-readable summary of what each template expects, for error messages. */
export function describeExpectedTemplates(): string {
  return TEMPLATES.map((t) => {
    const cols = t.requiredFields.map((f) => t.aliases[f][0] ?? f).join(', ');
    return `${t.label}: requires columns like [${cols}]`;
  }).join(' | ');
}
