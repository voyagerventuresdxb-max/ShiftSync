import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { ROSTER_READING_VERSION, isReadingAnswer, type ReadingAnswer } from './vlmPrompt.js';

/**
 * The AI reading of a file, kept per venue by the sha256 of the file's bytes and the reader's
 * prompt/schema version (RosterReadingCache). Re-uploading the same file reuses it: no model
 * call, nothing billed, no allowance used. Only the reading is stored, never the file; only a
 * COMPLETE reading is stored (every page read), so an incomplete one is retried next time.
 */
export interface ReadingCache {
  get(locationId: string, fileSha256: string): Promise<ReadingAnswer | null>;
  put(locationId: string, fileSha256: string, reading: ReadingAnswer): Promise<void>;
}

export function fileSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const prismaReadingCache: ReadingCache = {
  async get(locationId, sha) {
    const row = await prisma.rosterReadingCache.findUnique({
      where: { locationId_fileSha256_version: { locationId, fileSha256: sha, version: ROSTER_READING_VERSION } },
      select: { reading: true },
    });
    return row && isReadingAnswer(row.reading) ? (row.reading as unknown as ReadingAnswer) : null;
  },
  async put(locationId, sha, reading) {
    await prisma.rosterReadingCache.upsert({
      where: { locationId_fileSha256_version: { locationId, fileSha256: sha, version: ROSTER_READING_VERSION } },
      create: { locationId, fileSha256: sha, version: ROSTER_READING_VERSION, reading: reading as never },
      update: { reading: reading as never, createdAt: new Date() },
    });
  },
};

/** In-memory cache for tests and the eval harness. */
export function memoryReadingCache(): ReadingCache & { size(): number } {
  const store = new Map<string, ReadingAnswer>();
  return {
    async get(locationId, sha) {
      return store.get(`${locationId}|${sha}|${ROSTER_READING_VERSION}`) ?? null;
    },
    async put(locationId, sha, reading) {
      store.set(`${locationId}|${sha}|${ROSTER_READING_VERSION}`, reading);
    },
    size: () => store.size,
  };
}
