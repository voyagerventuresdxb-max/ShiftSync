import type { UploadProgress, UploadStage } from '../../api/schedules';

/**
 * The stepped "reading your roster" state: which steps to show, and what each says, from the
 * server's real progress (src/api/schedules.ts fetchUploadProgress). Pure, so it is unit-tested.
 */

export type RosterFileKind = 'sheet' | 'pdf' | 'image';

export function rosterFileKind(file: { name: string; type?: string }): RosterFileKind {
  if (file.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic)$/i.test(file.name)) return 'image';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  return 'sheet';
}

const ORDER: UploadStage[] = ['uploading', 'reading_text', 'reading_pages', 'cross_checking', 'matching', 'done'];

/**
 * The steps each kind of file is expected to take. Only a guess for the steps still ahead: one the
 * file turns out not to need (a scanned PDF has no text to read) is dropped once the read passes
 * it, and one it does need (a spreadsheet the AI reader is asked to read) appears when it starts.
 */
const PLAN: Record<RosterFileKind, UploadStage[]> = {
  sheet: ['uploading', 'reading_text', 'matching'],
  pdf: ['uploading', 'reading_text', 'reading_pages', 'cross_checking', 'matching'],
  image: ['uploading', 'reading_pages', 'cross_checking', 'matching'],
};

export type StepState = 'done' | 'current' | 'upcoming';

export interface ProgressStep {
  stage: UploadStage;
  state: StepState;
  label: string;
}

function readingPagesLabel(progress: UploadProgress | null, state: StepState, kind: RosterFileKind): string {
  const pages = progress?.pages;
  if (state === 'upcoming' || !pages) return kind === 'image' ? 'Reading the photo' : 'Reading the pages';
  if (state === 'done') return pages.total > 1 ? `Read all ${pages.total} pages` : 'Read by the AI reader';
  if (pages.done < pages.total) return pages.total > 1 ? `Reading page ${pages.done + 1} of ${pages.total}` : 'Reading your roster with the AI reader';
  if (pages.again > pages.againDone) return 'Taking a second, closer look';
  if (progress?.secondRead === 'running') return 'Reading it a second time, column by column';
  return 'Finishing the reading';
}

function label(stage: UploadStage, state: StepState, progress: UploadProgress | null, kind: RosterFileKind): string {
  switch (stage) {
    case 'uploading':
      return state === 'done' ? 'Uploaded' : 'Uploading';
    case 'reading_text':
      return state === 'done' ? "Read the file's text" : "Reading the file's text";
    case 'reading_pages':
      return readingPagesLabel(progress, state, kind);
    case 'cross_checking':
      return state === 'done' ? 'Cross-checked the two readings' : 'Cross-checking the two readings';
    case 'matching':
      return state === 'done' ? 'Matched people to your staff' : 'Matching people to your staff';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Stopped';
  }
}

/** Steps already done (as the server ran them), the current one, then those still expected. */
export function progressSteps(progress: UploadProgress | null, kind: RosterFileKind): ProgressStep[] {
  const current = progress?.stage ?? 'uploading';
  const passed = progress?.passed ?? [];
  const step = (stage: UploadStage, state: StepState): ProgressStep => ({ stage, state, label: label(stage, state, progress, kind) });
  const done = passed.map((stage) => step(stage, 'done'));
  if (current === 'done' || current === 'failed') return done;
  const ahead = PLAN[kind].filter((stage) => ORDER.indexOf(stage) > ORDER.indexOf(current) && !passed.includes(stage));
  return [...done, step(current, 'current'), ...ahead.map((stage) => step(stage, 'upcoming'))];
}

/** A random id for one upload (a UUID): `crypto.randomUUID` where the browser has it. */
export function newUploadId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
