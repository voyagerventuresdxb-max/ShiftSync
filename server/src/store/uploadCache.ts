import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreviewRow, TemplateDefinition } from '../parsing/types.js';

interface CachedBatch {
  locationId: string;
  templateId: TemplateDefinition['id'] | null;
  rows: PreviewRow[];
  createdAt: number;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes — long enough for a manager to review a preview

// Default persistence file lives in the server directory so upload batches
// survive server restarts and `tsx watch` hot-reloads during development.
// Override with UPLOAD_CACHE_FILE if a different location is preferred.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_FILE = join(__dirname, '..', '..', '.upload-cache.json');
const CACHE_FILE = process.env.UPLOAD_CACHE_FILE || DEFAULT_CACHE_FILE;

/**
 * Short-lived store bridging POST /upload (preview) and
 * POST /upload/:batchId/confirm (commit) so the manager doesn't have to
 * re-upload the file after reviewing the preview.
 *
 * Batches are persisted to a local JSON file (see CACHE_FILE) so they survive
 * server restarts and hot-reloads during development. The file is rewritten
 * on every mutation and swept of expired entries on each access. This is a
 * single-instance, single-process design — swap for Redis (or similar) before
 * running multiple server replicas.
 */
class UploadCache {
  private batches = new Map<string, CachedBatch>();

  constructor() {
    this.load();
  }

  put(locationId: string, templateId: TemplateDefinition['id'] | null, rows: PreviewRow[]): string {
    this.sweep();
    const batchId = randomUUID();
    this.batches.set(batchId, { locationId, templateId, rows, createdAt: Date.now() });
    this.save();
    return batchId;
  }

  get(batchId: string): CachedBatch | null {
    this.sweep();
    return this.batches.get(batchId) ?? null;
  }

  delete(batchId: string): void {
    this.batches.delete(batchId);
    this.save();
  }

  /** Load persisted batches from disk, dropping any that are already expired. */
  private load(): void {
    try {
      if (!existsSync(CACHE_FILE)) return;
      const raw = readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, CachedBatch>;
      const now = Date.now();
      for (const [id, batch] of Object.entries(parsed)) {
        if (batch && typeof batch.createdAt === 'number' && now - batch.createdAt <= TTL_MS) {
          this.batches.set(id, batch);
        }
      }
    } catch (err) {
      // A corrupt/unreadable cache file should never crash the server — start
      // with an empty cache and let the next upload repopulate it.
      console.error('[uploadCache] failed to load cache file, starting empty:', err);
    }
  }

  /** Persist the current in-memory batches to disk. */
  private save(): void {
    try {
      const dir = dirname(CACHE_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(this.batches), null, 2), 'utf8');
    } catch (err) {
      // Persistence is best-effort — a write failure shouldn't break the
      // upload/confirm flow, just log it.
      console.error('[uploadCache] failed to persist cache file:', err);
    }
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, batch] of this.batches) {
      if (now - batch.createdAt > TTL_MS) {
        this.batches.delete(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

export const uploadCache = new UploadCache();
