#!/usr/bin/env node
/**
 * Secret scanner for the working tree. No dependencies.
 *
 *   npm run scan:secrets
 *
 * Scans every file git tracks plus untracked files that are not ignored (i.e. everything
 * that could end up in a commit). Prints `path:line  rule` for each hit and exits 1 if
 * there is any. It NEVER prints the matched text — the output is safe to paste into a
 * PR, a CI log or chat.
 *
 * A line that legitimately needs one of these shapes (e.g. a test building a fake key)
 * can carry the marker `scan-secrets: allow` to skip it. Prefer building such strings at
 * runtime instead, so the file never contains the shape at all.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RULES = [
  // Google API keys (Gemini Developer API, Maps, Firebase …). A prefix plus a few
  // characters is enough: a quoted fragment of a real key is still a leak.
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{3,}/ },
  // Newer Google auth key / token format.
  { name: 'google-aq-key', re: /\bAQ\.[0-9A-Za-z_-]{3,}/ },
  { name: 'private-key-block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'service-account-key-id', re: /"private_key_id"\s*:\s*"[0-9a-f]{16,}"/ },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9_\-.=+/]{20,}/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe-live-key', re: /\b[rs]k_live_[0-9A-Za-z]{16,}/ },
  { name: 'openai-anthropic-key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/ },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  // A connection string with an inline password to anything but the local docker DB.
  // Placeholders (`<password>`, `${…}`, `***`) and the classic test password `hunter2` are not hits.
  {
    name: 'db-url-with-password',
    re: /\bpostgres(?:ql)?:\/\/[^:\s/'"`]+:(?![<${*]|password\b|pass\b|hunter2@)[^@\s'"`]+@(?!localhost\b|127\.0\.0\.1\b)[^\s'"`]+/,
  },
];

const ALLOW_MARKER = 'scan-secrets: allow';
// Vendored third-party agent tooling: its redaction tests carry fake secrets by design.
const EXCLUDED_PREFIXES = ['.ai/skills/'];
const MAX_BYTES = 2 * 1024 * 1024;

/** Returns [{ line, rule }] for every rule hit in `text`. Never returns the matched text. */
export function scanText(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER)) continue;
    for (const rule of RULES) {
      if (rule.re.test(line)) hits.push({ line: i + 1, rule: rule.name });
    }
  }
  return hits;
}

function candidateFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter(Boolean))];
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const self = relative(root, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
  let scanned = 0;
  const findings = [];
  for (const file of candidateFiles(root)) {
    if (file === self || EXCLUDED_PREFIXES.some((p) => file.startsWith(p))) continue;
    const abs = join(root, file);
    let buf;
    try {
      if (statSync(abs).size > MAX_BYTES) continue;
      buf = readFileSync(abs);
    } catch {
      continue; // deleted in the working tree, or a directory entry (submodule)
    }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    scanned++;
    for (const hit of scanText(buf.toString('utf8'))) findings.push(`${file}:${hit.line}  ${hit.rule}`);
  }
  if (findings.length) {
    console.error(`[scan-secrets] ${findings.length} possible secret(s) in ${scanned} files (matched text not shown):`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`[scan-secrets] clean: ${scanned} files scanned, no secret-shaped strings.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
