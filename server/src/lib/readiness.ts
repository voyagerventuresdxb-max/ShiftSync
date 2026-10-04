import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';

export interface Readiness {
  ok: boolean;
  db: 'ok' | 'unreachable';
  /** Counts only — migration names stay out of a public response. null when the DB is unreachable. */
  migrations: { expected: number; applied: number; pending: number } | null;
}

const DEFAULT_MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * GET /api/health/ready: the database answers, and every migration folder shipped with this
 * build is applied (Prisma's `_prisma_migrations`, finished and not rolled back). `/api/health`
 * stays a pure liveness check that never touches the database.
 */
export async function checkReadiness(
  db: Pick<PrismaClient, '$queryRaw'> = prisma,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
  timeoutMs = 3000,
): Promise<Readiness> {
  const expected = existsSync(migrationsDir)
    ? readdirSync(migrationsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(migrationsDir, d.name, 'migration.sql')))
        .map((d) => d.name)
    : [];
  let applied: string[];
  try {
    const rows = await withTimeout(
      db.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      timeoutMs,
    );
    applied = rows.map((r) => r.migration_name);
  } catch (err) {
    console.error(`[health.ready] database check failed: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'}`);
    return { ok: false, db: 'unreachable', migrations: null };
  }
  const appliedSet = new Set(applied);
  const pending = expected.filter((name) => !appliedSet.has(name)).length;
  return { ok: pending === 0, db: 'ok', migrations: { expected: expected.length, applied: applied.length, pending } };
}
