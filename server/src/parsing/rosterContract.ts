/**
 * Roster import contract: upload preview → review screen → confirm.
 *
 * The readers (table reader = deterministic parsers, AI reader = vision) produce
 * `ParsedShiftRow`s plus the people they saw; the preview turns them into one entry per
 * person; the review screen lets the manager decide; confirm creates or links staff and
 * writes shifts. Nothing a reader saw is ever dropped silently: it becomes a row, a person,
 * an unread row, or a flag the manager sees.
 *
 * Types only. The client keeps its own copy in src/api/schedules.ts.
 */

/** Which reader found a row or a person. */
export type ReaderSource = 'ai' | 'table' | 'both';

/** Per-shift flags shown on the review screen. */
export type RowFlag =
  /** Found by the AI reader only. */
  | 'ai_only'
  /** Found by the table reader only. */
  | 'table_only'
  /** Both readers found this shift but read different times; both are in `alternatives`. */
  | 'times_differ'
  /** A reader was unsure about this cell. */
  | 'low_confidence';

export interface ShiftAlternative {
  reader: 'ai' | 'table';
  startTime: string;
  endTime: string;
  overnight: boolean;
}

/** Extra fields on ParsedShiftRow / PreviewRow (all optional so older parsers still type-check). */
export interface RowReadingInfo {
  /** Groups every shift of one person in this file (normalized name + first source row). */
  personKey?: string;
  /** Section / group header the person was listed under, as printed (e.g. "HEAD WAITERS"). */
  section?: string | null;
  /** 1-based page of the source file (PDF/photo), null for spreadsheets. */
  sourcePage?: number | null;
  readerSource?: ReaderSource;
  flags?: RowFlag[];
  alternatives?: ShiftAlternative[];
}

/** A person a reader saw on the roster, including people with no shifts that week. */
export interface ReadPerson {
  personKey: string;
  /** Name as printed. */
  name: string;
  /** Role / title column or section header as printed; null when the roster shows none. */
  roleLabel: string | null;
  section: string | null;
  sourcePage: number | null;
  /** 1-based row within the page / sheet. */
  sourceRow: number | null;
  readerSource: ReaderSource;
  /**
   * Other spellings the readers gave this person (e.g. the AI read "Okafar" where the file's own
   * text says "Okafor"); `name` is the one kept. Absent when the readers agree.
   */
  nameAlternatives?: { reader: 'ai' | 'table'; name: string }[];
}

/** A row that looks like it belongs to the roster but could not be read into a person or shifts. */
export interface UnreadRow {
  page: number | null;
  row: number | null;
  /** Raw text as printed (logs never carry it; only the review screen shows it). */
  text: string;
  /** Plain-language reason for the manager. */
  reason: string;
}

export interface WeekDetection {
  /** ISO Monday of the week the shifts are dated in. */
  weekStart: string;
  /** ISO Sunday. */
  weekEnd: string;
  /** printed_dates: day headers carry dates; title: a title like "Rota 24 - 30 Aug"; weekday_only: only weekday names; none: nothing printed. */
  source: 'printed_dates' | 'title' | 'weekday_only' | 'none';
  /** What the roster printed, e.g. "24-Aug … 30-Aug". */
  printedLabel: string | null;
  /** True when the year or the week is ambiguous: the review screen must ask before confirm. */
  needsConfirmation: boolean;
  /** Plain-language reason when needsConfirmation is true. */
  reason: string | null;
}

export interface ReadingReport {
  ai: 'used' | 'cached' | 'not_used' | 'declined' | 'unavailable' | 'paused';
  table: 'used' | 'not_applicable' | 'failed';
  /** Person-like rows the table reader saw (null when there is no table reader for this file). */
  rowsDetected: number | null;
  peopleFound: number;
  /** Pages re-read once by the self-consistency pass. */
  rereadPages: number[];
  /** Reader disagreements turned into flags. */
  disagreements: number;
  /** "Read from previous upload": the AI reading came from the per-venue cache; nothing was billed. */
  fromCache: boolean;
  /** How the reading was checked, in plain words (e.g. a photo has no table reader to cross-check against). */
  note?: string;
}

export type PersonStatus = 'matched' | 'new' | 'needs_decision';

export type PersonFlag =
  /** Close to an existing staff member (nickname, first name only, spelling): same person? */
  | { kind: 'possible_match'; candidates: { userId: string; fullName: string }[] }
  /** The same name appears on more than one row of this file. */
  | { kind: 'duplicate_name'; personKeys: string[] }
  /** The same name is listed under two or more sections. */
  | { kind: 'two_sections'; sections: string[] }
  | { kind: 'ai_only' }
  | { kind: 'table_only' }
  /** No role could be resolved; non-blocking (the manager can assign one in bulk). */
  | { kind: 'role_unresolved' };

/** One entry per person on the roster (the review screen's unit). */
export interface PersonPreview {
  personKey: string;
  name: string;
  normalizedName: string;
  roleLabel: string | null;
  resolvedRoleId: string | null;
  section: string | null;
  status: PersonStatus;
  matchedUserId: string | null;
  flags: PersonFlag[];
  shiftCount: number;
  /** Preview rowNumbers of this person's shifts. */
  rowNumbers: number[];
  sourceRows: { page: number | null; row: number | null }[];
  /** The review screen's preselected decision (the manager can change it). Absent from older previews. */
  suggestedAction?: 'create' | 'link';
  /** With suggestedAction 'link': who. */
  suggestedUserId?: string | null;
}

export interface PeopleSummary {
  total: number;
  matched: number;
  new: number;
  needsDecision: number;
  roleUnresolved: number;
}

/** What the manager decided for one person on the review screen. */
export interface ConfirmPersonDecision {
  personKey: string;
  /** create: new staff member; link: an existing staff member (userId); skip: don't import this person. */
  action: 'create' | 'link' | 'skip';
  userId?: string;
  /** Edited name (create only). */
  name?: string;
  /** Edited or bulk-assigned role name; null = leave unassigned. */
  roleName?: string | null;
}

/** A person the manager added by hand on the review screen ("add missing person"). */
export interface AddedPerson {
  name: string;
  roleName: string | null;
}

/** A shift the confirm did not write because the person already works something overlapping then. */
export interface ImportOverlap {
  personKey: string;
  name: string;
  /** ISO date of the shift that was not written (after any week change). */
  date: string;
  startTime: string;
  endTime: string;
  /** The shift already on the rota, in the venue's wall-clock time. */
  existing: { date: string; startTime: string; endTime: string };
}

/** One person's outcome on confirm. */
export interface ConfirmedPerson {
  personKey: string;
  name: string;
  /** created: a new staff member; linked: an existing one; skipped: not imported. */
  outcome: 'created' | 'linked' | 'skipped';
  userId: string | null;
  roleName: string | null;
  shiftsCreated: number;
}

/** POST /upload/:batchId/confirm response (the older createdCount/skippedCount/rows fields are kept alongside). */
export interface ConfirmImportResult {
  createdPeople: number;
  linkedPeople: number;
  skippedPeople: number;
  createdShifts: number;
  /** Identical shifts (same person, date, start, end) already on the rota: not written again. */
  skippedDuplicates: number;
  overlaps: ImportOverlap[];
  people: ConfirmedPerson[];
  /** The Monday of the week the shifts were written into. Null when nothing was dated. */
  weekStart: string | null;
}
