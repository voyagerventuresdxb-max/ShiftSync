import type { TemplateDefinition, TemplateField } from './types.js';

/** Lowercase, strip punctuation, collapse whitespace. Used to fuzzy-match headers. */
export function normalizeHeader(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
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
