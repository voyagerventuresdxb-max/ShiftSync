/**
 * The token file's colour pairs meet WCAG 2.x AA (docs/color-evidence.md lists the measured values).
 * Text pairs need 4.5:1, large/decorative text and non-text UI (focus ring, the difference
 * between an enabled and a disabled button) 3:1. Transparent tokens are measured as they render:
 * painted over the surface they sit on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, contrast, over, readTokens, resolve, rgbToOklch } from './palette.mjs';

const tokens = readTokens();
const rgba = (name) => resolve(`var(${name})`, tokens);
/** The token as it renders on `surface` (alpha composited). */
const on = (name, surface) => over(rgba(name), rgba(surface).slice(0, 3));
const SURFACES = ['--bg', '--surface', '--surface-2', '--surface-3'];
const ratio = (fg, bg) => contrast(on(fg, bg), rgba(bg).slice(0, 3));

function atLeast(min, fg, bgs = SURFACES) {
  for (const bg of bgs) {
    const r = ratio(fg, bg);
    assert.ok(r >= min, `${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
  }
}

test('body text and secondary/muted text are AA on every surface', () => {
  atLeast(7, '--text');
  atLeast(4.5, '--text-secondary');
});

test('faint text is only for large or decorative text: AA-large on the page and card surfaces (never on surface 3)', () => {
  atLeast(3, '--text-faint', ['--bg', '--surface', '--surface-2']);
});

test('gold text and icons on the dark surfaces are AA', () => {
  for (const t of ['--accent', '--accent-hover', '--accent-pressed', '--info']) atLeast(4.5, t);
});

test('text on gold buttons is AA in the default, hover and pressed states', () => {
  for (const bg of ['--accent', '--accent-hover', '--accent-pressed']) {
    const r = contrast(rgba('--accent-foreground').slice(0, 3), rgba(bg).slice(0, 3));
    assert.ok(r >= 4.5, `--accent-foreground on ${bg}: ${r.toFixed(2)}`);
  }
  const r = contrast(rgba('--danger-foreground').slice(0, 3), rgba('--danger').slice(0, 3));
  assert.ok(r >= 4.5, `--danger-foreground on --danger: ${r.toFixed(2)}`);
});

test('the focus ring stands out from every surface (3:1)', () => {
  atLeast(3, '--focus-ring');
});

test('a disabled button reads as disabled: clearly apart from an enabled gold one, its label still legible', () => {
  for (const bg of SURFACES) {
    const disabled = on('--disabled-bg', bg);
    const enabled = rgba('--accent').slice(0, 3);
    const apart = contrast(enabled, disabled);
    assert.ok(apart >= 3, `enabled vs disabled fill on ${bg}: ${apart.toFixed(2)}`);
    const label = contrast(rgba('--disabled-fg').slice(0, 3), disabled);
    assert.ok(label >= 3, `disabled label on ${bg}: ${label.toFixed(2)}`);
  }
});

test('semantic colours are AA as text on every surface', () => {
  for (const t of ['--danger', '--success', '--warning']) atLeast(4.5, t);
});

test('department chips: label AA on its own chip, and the three chips stay apart from each other', () => {
  const chips = ['gold', 'sage', 'clay'];
  for (const c of chips) {
    const r = contrast(rgba(`--chip-${c}-fg`).slice(0, 3), rgba(`--chip-${c}-bg`).slice(0, 3));
    assert.ok(r >= 4.5, `chip ${c}: ${r.toFixed(2)}`);
  }
  // Distinguishable by hue: at least 30° apart pairwise (OKLCH), none of them blue or purple.
  const hues = chips.map((c) => rgbToOklch(rgba(`--chip-${c}-fg`)).H);
  for (let i = 0; i < hues.length; i++) {
    assert.ok(hues[i] < 180 || hues[i] > 330, `chip ${chips[i]} hue ${hues[i].toFixed(0)} is blue/purple`);
    for (let j = i + 1; j < hues.length; j++) {
      const d = Math.min(Math.abs(hues[i] - hues[j]), 360 - Math.abs(hues[i] - hues[j]));
      assert.ok(d >= 30, `chips ${chips[i]} and ${chips[j]} only ${d.toFixed(0)}° apart`);
    }
  }
});

test('surfaces step up in lightness from page (0) to highest (3)', () => {
  const L = SURFACES.map((s) => rgbToOklch(rgba(s)).L);
  for (let i = 1; i < L.length; i++) assert.ok(L[i] > L[i - 1], `${SURFACES[i]} is not lighter than ${SURFACES[i - 1]}`);
});

test('the native shell colours (theme-color meta, web manifest, Capacitor, Android) equal the page token', () => {
  const bg = resolve('var(--bg)', tokens).slice(0, 3);
  const hex = '#' + bg.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const read = (f) => readFileSync(join(ROOT, f), 'utf8');
  assert.match(read('index.html'), new RegExp(`name="theme-color" content="${hex}"`, 'i'));
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.background_color.toLowerCase(), hex);
  assert.equal(manifest.theme_color.toLowerCase(), hex);
  assert.match(read('capacitor.config.ts'), new RegExp(`backgroundColor: '${hex}'`, 'i'));
  assert.match(read('android/app/src/main/res/values/colors.xml'), new RegExp(`name="shell_background">${hex}<`, 'i'));
});

test('the canvas fallback gold used before the stylesheet can be read equals the token', () => {
  const src = readFileSync(join(ROOT, 'src/lib/cssToken.ts'), 'utf8');
  const m = /FALLBACK_ACCENT = '(#[0-9a-f]{6})'/i.exec(src);
  assert.ok(m, 'FALLBACK_ACCENT not found in src/lib/cssToken.ts');
  const accent = resolve('var(--accent)', tokens).slice(0, 3);
  assert.equal(m[1].toLowerCase(), '#' + accent.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''));
});
