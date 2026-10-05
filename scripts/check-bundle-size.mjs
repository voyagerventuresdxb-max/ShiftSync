#!/usr/bin/env node
/**
 * Bundle-size budget for the screens staff use (no dependencies).
 *
 *   node scripts/check-bundle-size.mjs            # after `vite build`: report + fail over budget
 *   node scripts/check-bundle-size.mjs --update   # record the current sizes as the budget
 *
 * For each screen it adds up the gzipped JS the browser must download to show
 * it: the entry chunk and its static imports, plus the screen's own lazy chunk
 * (and its static imports) when it has one. Read from Vite's build manifest
 * (`build.manifest` in vite.config.ts). A staff screen over its recorded
 * budget by more than `tolerance` (10%) fails the build. Manager screens are
 * reported but not budgeted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Screen → the source modules that render it (route component, plus any lazily-loaded part it always shows). */
export const STAFF_SCREENS = {
  '/': ['src/routes/HomeRoute.tsx'],
  '/my-shifts': ['src/routes/MyShiftsRoute.tsx'],
  '/scheduling': ['src/routes/SchedulingRoute.tsx'],
  '/profile': ['src/routes/ProfileRoute.tsx'],
  '/login': ['src/routes/LoginRoute.tsx'],
  '/join': ['src/routes/JoinRoute.tsx'],
  '/welcome': ['src/routes/WelcomeRoute.tsx'],
};
export const MANAGER_SCREENS = {
  '/scheduling (manager)': ['src/routes/SchedulingRoute.tsx', 'src/components/shiftsync/RotaBuilder.tsx', 'src/components/ShiftUpload.tsx'],
  '/floor-plan': ['src/routes/FloorPlanRoute.tsx'],
  '/people': ['src/routes/PeopleRoute.tsx'],
  '/schedule': ['src/routes/ScheduleEditorRoute.tsx'],
  '/onboarding': ['src/routes/OnboardingRoute.tsx'],
};

/** Every JS file needed to show a screen: the entry's static closure plus each module's own chunk closure (if it is split out). */
export function screenFiles(manifest, modules) {
  const files = new Set();
  const visit = (key) => {
    const chunk = manifest[key];
    if (!chunk || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const imp of chunk.imports ?? []) visit(imp);
  };
  const entry = Object.keys(manifest).find((k) => manifest[k].isEntry);
  if (!entry) throw new Error('No entry chunk in the Vite manifest.');
  visit(entry);
  for (const m of modules) if (manifest[m]) visit(m);
  return [...files].filter((f) => f.endsWith('.js'));
}

/** Staff screens over budget × (1 + tolerance), as messages; empty when everything fits. */
export function overBudget(actual, budget) {
  const tolerance = budget.tolerance ?? 0.1;
  const problems = [];
  for (const [screen, limit] of Object.entries(budget.staffScreensGzipBytes ?? {})) {
    const size = actual[screen];
    if (size === undefined) problems.push(`${screen}: no longer measured — update the budget (--update).`);
    else if (size > limit * (1 + tolerance)) {
      problems.push(`${screen}: ${kb(size)} gzip JS, over its budget ${kb(limit)} by more than ${Math.round(tolerance * 100)}%.`);
    }
  }
  return problems;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

function main() {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const dist = join(root, 'dist');
  const budgetPath = join(root, 'bundle-budget.json');
  const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'));
  const sizeCache = new Map();
  const size = (file) => {
    if (!sizeCache.has(file)) {
      const buf = readFileSync(join(dist, file));
      sizeCache.set(file, { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length });
    }
    return sizeCache.get(file);
  };
  const measure = (screens) =>
    Object.fromEntries(
      Object.entries(screens).map(([screen, modules]) => {
        const files = screenFiles(manifest, modules);
        return [screen, files.reduce((acc, f) => ({ raw: acc.raw + size(f).raw, gzip: acc.gzip + size(f).gzip }), { raw: 0, gzip: 0 })];
      }),
    );
  const staff = measure(STAFF_SCREENS);
  const manager = measure(MANAGER_SCREENS);

  console.log('[bundle-size] JS each screen downloads (raw / gzip):');
  for (const [screen, s] of [...Object.entries(staff), ...Object.entries(manager)]) {
    console.log(`  ${screen.padEnd(24)} ${kb(s.raw).padStart(10)} / ${kb(s.gzip).padStart(9)}${screen in staff ? '' : '  (manager, not budgeted)'}`);
  }

  const actual = Object.fromEntries(Object.entries(staff).map(([k, v]) => [k, v.gzip]));
  if (process.argv.includes('--update')) {
    const budget = { note: 'Gzipped JS each staff screen downloads; written by `node scripts/check-bundle-size.mjs --update`. The build fails above budget + tolerance.', tolerance: 0.1, staffScreensGzipBytes: actual };
    writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
    console.log(`[bundle-size] budget written to bundle-budget.json`);
    return;
  }
  const problems = overBudget(actual, JSON.parse(readFileSync(budgetPath, 'utf8')));
  if (problems.length) {
    console.error(`[bundle-size] over budget:\n${problems.map((p) => `  - ${p}`).join('\n')}\nIf the growth is intended, run: node scripts/check-bundle-size.mjs --update`);
    process.exit(1);
  }
  console.log('[bundle-size] every staff screen is within budget.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
