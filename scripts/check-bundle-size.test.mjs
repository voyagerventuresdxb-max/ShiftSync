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
