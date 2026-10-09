import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAllowlist, checkTokens, findLiterals, runGuard } from './palette.mjs';

/** Writes `files` ({ name: text }) into a temp dir and runs the literal finder over them. */
function scan(files) {
  const dir = mkdtempSync(join(tmpdir(), 'palette-'));
  const paths = Object.entries(files).map(([name, text]) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  });
  return findLiterals({ root: dir, files: paths });
}

test('the app has no hard-coded colour outside tokens.css, every token sits in the reference ranges, and the allowlist has no stale entries', () => {
  const { left, stale, tokenProblems } = runGuard();
  assert.deepEqual(left.map((h) => `${h.file}:${h.line} ${h.literal}`), []);
  assert.deepEqual(stale, []);
  assert.deepEqual(tokenProblems, []);
});

test('finds hex, colour functions, 0x colours, named colours and Tailwind palette classes', () => {
  const hits = scan({
    'a.tsx': [
      "const a = { color: '#e5a93c' };",
      "const b = 'rgba(0, 0, 0, 0.5)';",
      'const c = 0x4fb8e0;',
      "const d = <i className='text-blue-500 bg-white' />;",
      "const e = { background: 'oklch(0.7 0.1 250)' };",
    ].join('\n'),
    'b.css': '.x { color: white; border-color: #abc; }',
  });
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line} ${h.kind}`).sort(),
    [
      'a.tsx:1 hex',
      'a.tsx:2 colour function',
      'a.tsx:3 hex-number',
      'a.tsx:4 tailwind palette class',
      'a.tsx:4 tailwind palette class',
      'a.tsx:5 colour function',
      'b.css:1 hex',
      'b.css:1 named colour',
    ].sort(),
  );
});

test('ignores comments, var() references, color-mix over tokens, URL fragments and HTML entities', () => {
  const hits = scan({
    'a.tsx': [
      '// the old accent was #e5a93c',
      "const a = { color: 'var(--accent)', background: 'color-mix(in srgb, var(--bone) 10%, transparent)' };",
      "const link = `/kiosk?venue=1#k=${'abc'}`;",
      "const q = 'Don&#39;t';",
      "const cls = 'bg-surface text-muted-foreground border-border/60';",
    ].join('\n'),
    'b.css': '/* #ffffff */\n.x { color: var(--text); }',
  });
  assert.deepEqual(hits, []);
});

test('an allowlist entry covers only its own file and literal; an entry that matches nothing is stale', () => {
  const hits = [
    { file: 'index.html', line: 1, kind: 'hex', literal: '#0d0b09' },
    { file: 'src/x.tsx', line: 2, kind: 'hex', literal: '#0d0b09' },
  ];
  const { left, stale } = applyAllowlist(hits, [
    { file: 'index.html', literal: '#0d0b09', reason: 'meta tag' },
    { file: 'src/gone.tsx', literal: '#123456', reason: 'old' },
  ]);
  assert.deepEqual(left.map((h) => h.file), ['src/x.tsx']);
  assert.equal(stale.length, 1);
});

test('a blue, cool or over-saturated token fails the range check; an unclassified primitive fails too', () => {
  const base = { '--ink': '#0d0b09', '--champagne': '#c9a66b' };
  assert.deepEqual(checkTokens(base), []);
  assert.match(checkTokens({ ...base, '--ink': '#0f0f12' }).join('\n'), /--ink .*(blue|hue)/);
  assert.match(checkTokens({ ...base, '--champagne': '#e5a93c' }).join('\n'), /--champagne .*chroma/);
  assert.match(checkTokens({ ...base, '--signal': '#4fb8e0' }).join('\n'), /--signal .*not classified/);
  assert.match(checkTokens({ ...base, '--bg': 'color-mix(in srgb, #ffffff 10%, transparent)' }).join('\n'), /reference primitives/);
});
