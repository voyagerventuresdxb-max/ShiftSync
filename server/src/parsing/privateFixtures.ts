import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Real venue rosters are kept OUT of the repository (they carry real staff names). Tests that
 * want them read them from a gitignored directory — `server/test-fixtures/private/` by default,
 * or `SHIFTSYNC_PRIVATE_FIXTURES_DIR` — and skip with a clear message when they're absent, so
 * the public suite never depends on them. Synthetic equivalents (fake names, same layouts) keep
 * those layouts covered for everyone. See docs/test-fixtures.md.
 */
export function privateFixturesDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIFTSYNC_PRIVATE_FIXTURES_DIR?.trim() || join('server', 'test-fixtures', 'private');
}

/** Path to a private fixture, or null when it isn't on this machine. */
export function privateFixture(name: string): string | null {
  const path = join(privateFixturesDir(), name);
  return existsSync(path) ? path : null;
}

export function privateFixtureSkipMessage(name: string): string {
  return `private fixture "${name}" is not on this machine (${privateFixturesDir()}) — skipped; see docs/test-fixtures.md`;
}
