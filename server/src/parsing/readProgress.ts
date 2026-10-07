/**
 * What a roster read reports while it runs (readUpload.ts, and aiReadRoster in rosterReading.ts),
 * so the upload route can show the manager which step it is on (store/uploadProgress.ts).
 * Stages and page numbers only — never a name, a cell or any other content of the file.
 */
export type ReadProgressEvent =
  /** The built-in reader is reading the file's own text (a spreadsheet's cells, a PDF's text layer). */
  | { kind: 'text' }
  /** One AI call on one page started or answered; `again` = the stricter re-read of a short or missing page. */
  | { kind: 'page'; page: number; of: number; state: 'started' | 'finished'; again?: boolean }
  /** A photo or scan's second, column-by-column AI reading (it runs alongside the first). */
  | { kind: 'second_read'; state: 'started' | 'finished' }
  /** Two readings are being compared (AI vs the file's text, or the two AI readings of a photo). */
  | { kind: 'cross_check' };

export type OnReadProgress = (event: ReadProgressEvent) => void;

/** Calls `listener` with `event`, never letting a progress listener break the read itself. */
export function emitReadProgress(listener: OnReadProgress | undefined, event: ReadProgressEvent): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    // Progress is a courtesy; the reading goes on without it.
  }
}
