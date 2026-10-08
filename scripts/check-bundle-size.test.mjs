import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overBudget, screenFiles } from './check-bundle-size.mjs';

const manifest = {
  'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/routes/FloorPlanRoute.tsx'] },
  '_shared.js': { file: 'assets/shared.js' },
  '_dnd.js': { file: 'assets/dnd.js' },
  'src/routes/FloorPlanRoute.tsx': { file: 'assets/FloorPlanRoute.js', isDynamicEntry: true, imports: ['_dnd.js', '_shared.js'], css: ['assets/fp.css'] },
};

test('a screen in the entry chunk downloads the entry and its static imports only, never the lazy chunks', () => {
  assert.deepEqual(screenFiles(manifest, ['src/routes/HomeRoute.tsx']).sort(), ['assets/index.js', 'assets/shared.js']);
});

test('a lazily-loaded screen adds its own chunk and its imports, each file once', () => {
  assert.deepEqual(screenFiles(manifest, ['src/routes/FloorPlanRoute.tsx']).sort(), ['assets/FloorPlanRoute.js', 'assets/dnd.js', 'assets/index.js', 'assets/shared.js']);
});

test('over budget only beyond the tolerance; a budgeted screen that is no longer measured is reported', () => {
  const budget = { tolerance: 0.1, staffScreensGzipBytes: { '/': 1000, '/my-shifts': 1000 } };
  assert.deepEqual(overBudget({ '/': 1100, '/my-shifts': 900 }, budget), [], '+10% exactly still passes');
  assert.equal(overBudget({ '/': 1101, '/my-shifts': 900 }, budget).length, 1);
  assert.match(overBudget({ '/': 900 }, budget)[0], /no longer measured/);
});

test('the staff-screen budget was raised once (run 17), to a 146.0 kB gzip ceiling, and says why', async () => {
  const { readFileSync } = await import('node:fs');
  const budget = JSON.parse(readFileSync(new URL('../bundle-budget.json', import.meta.url), 'utf8'));
  for (const bytes of Object.values(budget.staffScreensGzipBytes)) {
    assert.equal(((bytes * (1 + budget.tolerance)) / 1024).toFixed(1), '146.0');
  }
  assert.match(budget.change, /raised .* to 146\.0 kB gzip/);
  assert.match(budget.change, /Any further raise needs the owner's approval/);
  // 145 kB of staff JS fits; 147 kB does not.
  const all = (kB) => Object.fromEntries(Object.keys(budget.staffScreensGzipBytes).map((screen) => [screen, kB * 1024]));
  assert.deepEqual(overBudget(all(145), budget), []);
  assert.equal(overBudget(all(147), budget).length, Object.keys(budget.staffScreensGzipBytes).length);
});
