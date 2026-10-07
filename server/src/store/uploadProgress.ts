import type { ReadProgressEvent } from '../parsing/readProgress.js';

/**
 * Where a roster upload is while it is being read, so the review screen can show real steps
 * ("Reading page 1 of 2") instead of a bare wait. The client picks a random id per upload
 * (`X-Upload-Id`, a UUID) and polls GET /api/schedules/upload-progress/:id while its upload
 * request is open.
 *
 * In memory, in this process only: a single API instance is assumed (as for uploadCache.ts).
 * Behind several instances a poll could reach one that never saw the upload and get a 404; the
 * client then falls back to its elapsed-time wording. Nothing is persisted, and nothing in here
 * names a person or holds file content: stages and page counts only. An entry belongs to the
 * venue and session that started the upload; it is dropped TTL_MS after its last change (sooner
 * once the upload has answered), and at most MAX_ENTRIES are kept.
 */

/** The steps of a read, in the order they run. A step a file doesn't need is skipped, never shown done. */
export const UPLOAD_STAGES = ['uploading', 'reading_text', 'reading_pages', 'cross_checking', 'matching', 'done'] as const;
export type UploadStage = (typeof UPLOAD_STAGES)[number] | 'failed';

export interface UploadProgressView {
  stage: UploadStage;
  /** Stages already finished, in the order they ran. */
  passed: UploadStage[];
  /** The AI reader's pages once it started: how many there are, how many answered, and any read again. */
  pages: { total: number; done: number; again: number; againDone: number } | null;
  /** A photo or scan's second reading (it runs alongside the first): null when there is none. */
  secondRead: 'running' | 'done' | null;
}

export type UploadProgressRead = { status: 'ok'; view: UploadProgressView } | { status: 'not_found' } | { status: 'forbidden' };

/** Who started an upload: only the same venue and the same session may read its progress. */
export interface UploadOwner {
  locationId: string;
  sessionKey: string;
}

export const UPLOAD_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UPLOAD_PROGRESS_TTL_MS = 10 * 60 * 1000;
/** How long a finished upload's last state stays readable (a poll may still be in flight). */
export const UPLOAD_PROGRESS_FINISHED_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 1000;

interface Entry extends UploadOwner {
  stage: UploadStage;
  passed: UploadStage[];
  pagesTotal: number;
  pagesDone: Set<number>;
  again: number;
  againDone: number;
  secondRead: 'running' | 'done' | null;
  expiresAt: number;
}

const order = (stage: UploadStage) => (stage === 'failed' ? UPLOAD_STAGES.length : UPLOAD_STAGES.indexOf(stage));

export class UploadProgressStore {
  private entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts tracking an upload. False (nothing tracked) for a malformed id or one another venue or session holds. */
  start(id: string, owner: UploadOwner): boolean {
    if (!UPLOAD_ID_SHAPE.test(id)) return false;
    this.sweep();
    const held = this.entries.get(id);
    if (held && (held.locationId !== owner.locationId || held.sessionKey !== owner.sessionKey)) return false;
    this.entries.delete(id);
    while (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(id, {
      ...owner,
      stage: 'uploading',
      passed: [],
      pagesTotal: 0,
      pagesDone: new Set(),
      again: 0,
      againDone: 0,
      secondRead: null,
      expiresAt: this.now() + UPLOAD_PROGRESS_TTL_MS,
    });
    return true;
  }

  /** Records what the reader reported. Unknown ids are ignored. */
  report(id: string, event: ReadProgressEvent): void {
    const entry = this.live(id);
    if (!entry) return;
    if (event.kind === 'text') this.enter(entry, 'reading_text');
    else if (event.kind === 'cross_check') this.enter(entry, 'cross_checking');
    else if (event.kind === 'second_read') entry.secondRead = event.state === 'started' ? 'running' : 'done';
    else {
      this.enter(entry, 'reading_pages');
      entry.pagesTotal = Math.max(entry.pagesTotal, event.of);
      if (event.again) {
        if (event.state === 'started') entry.again++;
        else entry.againDone++;
      } else if (event.state === 'finished') entry.pagesDone.add(event.page);
    }
    this.touch(entry);
  }

  /** Moves an upload on to a later stage (the route's own steps: matching, then done or failed). */
  advance(id: string, stage: UploadStage): void {
    const entry = this.live(id);
    if (!entry) return;
    this.enter(entry, stage);
    if (stage === 'done' || stage === 'failed') entry.expiresAt = this.now() + UPLOAD_PROGRESS_FINISHED_TTL_MS;
    else this.touch(entry);
  }

  read(id: string, reader: UploadOwner): UploadProgressRead {
    const entry = this.live(id);
    // Another venue's upload is indistinguishable from no upload at all.
    if (!entry || entry.locationId !== reader.locationId) return { status: 'not_found' };
    if (entry.sessionKey !== reader.sessionKey) return { status: 'forbidden' };
    return {
      status: 'ok',
      view: {
        stage: entry.stage,
        passed: [...entry.passed],
        pages: entry.pagesTotal ? { total: entry.pagesTotal, done: entry.pagesDone.size, again: entry.again, againDone: entry.againDone } : null,
        secondRead: entry.secondRead,
      },
    };
  }

  /** Test seam: how many uploads are tracked right now (after dropping expired ones). */
  size(): number {
    this.sweep();
    return this.entries.size;
  }

  private live(id: string): Entry | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  /** Steps only go forward: a report that arrives late never moves an upload back. */
  private enter(entry: Entry, stage: UploadStage): void {
    if (entry.stage === stage || order(stage) < order(entry.stage)) return;
    entry.passed.push(entry.stage);
    entry.stage = stage;
  }

  private touch(entry: Entry): void {
    if (entry.stage !== 'done' && entry.stage !== 'failed') entry.expiresAt = this.now() + UPLOAD_PROGRESS_TTL_MS;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }
}

export const uploadProgress = new UploadProgressStore();
