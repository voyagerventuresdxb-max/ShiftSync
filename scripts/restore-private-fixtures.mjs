#!/usr/bin/env node
/**
 * npm run fixtures:restore-private
 *
 * Puts the real-venue roster fixtures back into the gitignored private directory
 * (server/test-fixtures/private/, or SHIFTSYNC_PRIVATE_FIXTURES_DIR) from the last commit that
 * still had them in the repository. Files already present are left alone. Prints file names and
 * sizes only — never any content.
 *
 * This works only while that commit still exists. If the repository history is ever rewritten
 * to remove these files, run this (or copy the files somewhere safe) BEFORE rewriting.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The last master commit that tracked these files (the merge of #90, 2026-10-04).
const SOURCE_COMMIT = '64de66033ef4b6b7a45d3d6da4c82023de7cbabe';
const FILES = ['real-roster.pdf', 'real-roster.png', 'rendered-page-1.png', 'bar-des-pres-roster.pdf'];

const dir = process.env.SHIFTSYNC_PRIVATE_FIXTURES_DIR?.trim() || join('server', 'test-fixtures', 'private');
mkdirSync(dir, { recursive: true });

let failed = 0;
for (const name of FILES) {
  const target = join(dir, name);
  if (existsSync(target)) {
    console.log(`[fixtures] ${name}: already present`);
    continue;
  }
  try {
    const bytes = execFileSync('git', ['show', `${SOURCE_COMMIT}:server/test-fixtures/${name}`], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    writeFileSync(target, bytes);
    console.log(`[fixtures] ${name}: restored (${bytes.length} bytes)`);
  } catch {
    failed++;
    console.error(`[fixtures] ${name}: not found in commit ${SOURCE_COMMIT.slice(0, 7)} (history rewritten, or a shallow clone?) — copy it into ${dir} by hand.`);
  }
}
process.exitCode = failed ? 1 : 0;
