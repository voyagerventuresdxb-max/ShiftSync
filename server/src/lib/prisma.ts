import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';

// Reuse a single client across hot-reloads in dev (tsx watch) to avoid
// exhausting Postgres connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Defense-in-depth for scripts/with-branch-schema.mjs: that wrapper already
 * rewrites DATABASE_URL's `schema` query param per-branch before this
 * process starts, for anything invoked through the npm scripts. This
 * fallback re-derives the same schema name directly (same algorithm,
 * duplicated rather than imported to avoid this hot path depending on a
 * devops script) in case DATABASE_URL somehow reaches this process
 * unscoped — e.g. a raw `node server/src/index.ts` invocation that skipped
 * the wrapper. In production (no `.git`, fixed DATABASE_URL) this silently
 * no-ops back to whatever DATABASE_URL already names.
 */
function datasourceUrlForCurrentBranch(): string | undefined {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  if (process.env.NODE_ENV === 'production') return base;
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const schema = 'dev_' + branch.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    const url = new URL(base);
    if (!url.searchParams.get('schema')) url.searchParams.set('schema', schema.slice(0, 63));
    return url.toString();
  } catch {
    return base;
  }
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ datasourceUrl: datasourceUrlForCurrentBranch() });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
