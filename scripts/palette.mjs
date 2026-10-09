#!/usr/bin/env node
/**
 * Palette guard (run by `npm run build` and by `npm test` via check-palette.test.mjs).
 *
 *   node scripts/palette.mjs          exit 1 on any violation, with a list
 *
 * Two rules:
 *  1. No colour literal outside src/styles/tokens.css. Hex (#rgb … #rrggbbaa, 0xrrggbb),
 *     rgb()/rgba()/hsl()/hsla()/hwb()/lab()/lch()/oklab()/oklch()/color(), CSS named colours used
 *     as values, and Tailwind default-palette classes (`bg-blue-500`, `text-white`) all count.
 *     The few exceptions live in scripts/palette-allowlist.json, each with its reason.
 *  2. Every colour primitive in tokens.css is classified (TOKEN_GROUPS) and its measured OKLCH
 *     hue/chroma must sit inside its group's range. The ranges are the onboarding wizard's
 *     measured palette (docs/color-evidence.md) plus a small margin; no token may be blue or purple.
 *
 * Also exports the colour maths (parsing, var()/color-mix() resolution, OKLCH, WCAG contrast)
 * that scripts/palette-contrast.test.mjs uses.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TOKEN_FILE = 'src/styles/tokens.css';

// ---------------------------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------------------------

/** '#rgb' | '#rrggbb' | '#rrggbbaa' → [r, g, b, a] (0-255, alpha 0-1). */
export function parseHex(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

const lin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const unlin = (c) => {
  c = Math.max(0, Math.min(1, c));
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
};

export function rgbToOklab([r, g, b]) {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    unlin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    unlin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    unlin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** → { L (0-1), C, H (degrees, 0 when achromatic) } */
export function rgbToOklch(rgb) {
  const [L, a, b] = rgbToOklab(rgb);
  const C = Math.hypot(a, b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H: C < 1e-4 ? 0 : H };
}

/** WCAG 2.x contrast ratio of two opaque sRGB colours. */
export function contrast(a, b) {
  const lum = ([r, g, bl]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Paint [r,g,b,a] over an opaque [r,g,b]. */
export function over([r, g, b, a], [R, G, B]) {
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
}

// ---------------------------------------------------------------------------------------------
// tokens.css
// ---------------------------------------------------------------------------------------------

/** Custom properties declared in the token file's :root, as raw strings. */
export function readTokens(file = join(ROOT, TOKEN_FILE)) {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = {};
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
  return tokens;
}

/**
 * Resolves a token to [r, g, b, a]. Understands what tokens.css uses: hex, var(--x),
 * color-mix(in srgb|oklab, A p%, B | transparent).
 */
export function resolve(value, tokens, depth = 0) {
  if (depth > 20) throw new Error(`token cycle at ${value}`);
  const v = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return parseHex(v);
  if (v === 'transparent') return [0, 0, 0, 0];
  const ref = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  if (ref) {
    if (!(ref[1] in tokens)) throw new Error(`unknown token ${ref[1]}`);
    return resolve(tokens[ref[1]], tokens, depth + 1);
  }
  const mix = /^color-mix\(in (srgb|oklab),\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/i.exec(v);
  if (mix) {
    const [, space, aRaw, pRaw, bRaw] = mix;
    const p = Number(pRaw) / 100;
    const A = resolve(aRaw, tokens, depth + 1);
    const B = resolve(bRaw, tokens, depth + 1);
    if (B[3] === 0) return [A[0], A[1], A[2], A[3] * p];
    if (space === 'srgb') return [0, 1, 2].map((i) => A[i] * p + B[i] * (1 - p)).concat(1);
    const la = rgbToOklab(A), lb = rgbToOklab(B);
    return oklabToRgb([0, 1, 2].map((i) => la[i] * p + lb[i] * (1 - p))).concat(1);
  }
  throw new Error(`cannot resolve colour value "${v}"`);
}

/**
 * Every hex primitive in tokens.css belongs to one group; its hue/chroma must stay inside the
 * group's range. Measured reference (onboarding): near-blacks and bone ramp hue 67–93, chroma
 * ≤ 0.027; champagne/bronze hue 77–87, chroma 0.059–0.087.
 */
export const GROUPS = {
  neutral: { hue: [60, 95], chroma: [0, 0.03], note: 'warm near-blacks and the bone text ramp' },
  shadowTint: { hue: [55, 90], chroma: [0, 0.05], note: 'warm shadow tint' },
  achromatic: { hue: null, chroma: [0, 0.002], note: 'pure black, only ever used with transparency' },
  gold: { hue: [74, 92], chroma: [0.05, 0.1], note: 'champagne gold' },
  danger: { hue: [20, 40], chroma: [0.06, 0.16], note: 'restrained warm red' },
  success: { hue: [115, 150], chroma: [0.03, 0.09], note: 'sage' },
  warning: { hue: [55, 75], chroma: [0.05, 0.12], note: 'ochre' },
  chip: { hue: [40, 60], chroma: [0.03, 0.1], note: 'terracotta chip tone' },
};
export const TOKEN_GROUPS = {
  '--void': 'neutral', '--night': 'neutral', '--obsidian': 'neutral', '--ink-low': 'neutral', '--ink': 'neutral',
  '--ink-mid': 'neutral', '--ink-cta': 'neutral', '--bezel': 'neutral', '--ink-2': 'neutral', '--ink-hi': 'neutral',
  '--ink-top': 'neutral', '--bone': 'neutral', '--stone': 'neutral', '--dim': 'neutral', '--dim-2': 'neutral',
  '--umber': 'shadowTint', '--shadow': 'achromatic',
  '--champagne': 'gold', '--champagne-hi': 'gold', '--champagne-hover': 'gold', '--champagne-pressed': 'gold', '--bronze': 'gold',
  '--clay-red': 'danger', '--sage': 'success', '--ochre': 'warning', '--clay': 'chip',
};
const BLUE_PURPLE = [180, 330];

export function checkTokens(tokens = readTokens()) {
  const problems = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (!/^#[0-9a-f]{3,8}$/i.test(value)) {
      try {
        resolve(value, tokens);
      } catch {
        continue; // not a colour token (or a colour-free value); nothing to range-check
      }
      if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(value)) problems.push(`${name}: semantic tokens must reference primitives, not literals (${value})`);
      continue;
    }
    const group = TOKEN_GROUPS[name];
    if (!group) {
      problems.push(`${name} (${value}) is not classified in scripts/palette.mjs TOKEN_GROUPS`);
      continue;
    }
    const { C, H } = rgbToOklch(parseHex(value));
    const g = GROUPS[group];
    if (C >= 0.01 && H >= BLUE_PURPLE[0] && H <= BLUE_PURPLE[1]) problems.push(`${name} (${value}) is blue/purple: hue ${H.toFixed(0)}`);
    if (C < g.chroma[0] - 1e-9 || C > g.chroma[1] + 1e-9) problems.push(`${name} (${value}) chroma ${C.toFixed(4)} outside ${group} ${g.chroma.join('–')}`);
    if (g.hue && C >= 0.003 && (H < g.hue[0] || H > g.hue[1])) problems.push(`${name} (${value}) hue ${H.toFixed(0)} outside ${group} ${g.hue.join('–')}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Hard-coded colours
// ---------------------------------------------------------------------------------------------

const SCAN = ['src', 'index.html', 'public/manifest.webmanifest', 'capacitor.config.ts', 'android/app/src/main/res/values'];
const EXT = /\.(tsx?|css|html|webmanifest|xml)$/;
const NAMED = 'white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|navy|teal|cyan|magenta|silver|maroon|olive|lime|aqua|fuchsia|indigo|violet|gold|beige|ivory|brown|tan|salmon|coral|crimson|khaki|lavender|plum|orchid|turquoise|azure|wheat|linen|snow';
const TW_PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const PATTERNS = [
  { kind: 'hex', re: /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g },
  { kind: 'hex-number', re: /\b0x[0-9a-fA-F]{6}\b/g },
  { kind: 'colour function', re: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g },
  { kind: 'named colour', re: new RegExp(`(?:[:\\s,(]|^)(?:${NAMED})(?=\\s*[;,)!'"\`]|\\s*$)`, 'gi'), css: true },
  { kind: 'tailwind palette class', re: new RegExp(`\\b(?:bg|text|border|ring|from|via|to|fill|stroke|outline|shadow|divide|placeholder|accent|caret|decoration)-(?:white|black|(?:${TW_PALETTE})-\\d{2,3})\\b`, 'g') },
];

function walk(p, out) {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p)) walk(join(p, f), out);
  } else if (EXT.test(p) && !/\.(test|spec)\.[tj]sx?$/.test(p)) out.push(p);
}

export function readAllowlist(file = join(ROOT, 'scripts/palette-allowlist.json')) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Strips comments so documentation can name colours freely. Keeps line numbers. */
function stripComments(text, file) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let t = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (/\.(html|xml|webmanifest)$/.test(file)) t = t.replace(/<!--[\s\S]*?-->/g, blank);
  if (/\.tsx?$/.test(file)) t = t.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
  return t;
}

export function findLiterals({ root = ROOT, files } = {}) {
  const list = files ?? (() => {
    const out = [];
    for (const s of SCAN) walk(join(root, s), out);
    return out;
  })();
  const hits = [];
  for (const abs of list) {
    const file = relative(root, abs).split('\\').join('/');
    if (file === TOKEN_FILE) continue;
    const text = stripComments(readFileSync(abs, 'utf8'), file);
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const p of PATTERNS) {
        if (p.css && !/\.css$/.test(file) && !/(?:color|background|border|fill|stroke|shadow|outline)\s*[:=]/i.test(line)) continue;
        for (const m of line.matchAll(p.re)) hits.push({ file, line: i + 1, kind: p.kind, literal: m[0].trim(), text: line.trim().slice(0, 140) });
      }
    });
  }
  return hits;
}

/** Hits not covered by an allowlist entry ({ file, literal?, line? }); also reports stale entries. */
export function applyAllowlist(hits, allowlist) {
  const used = new Set();
  const left = hits.filter((h) => {
    const i = allowlist.findIndex((a) => a.file === h.file && (a.literal === undefined || h.literal.toLowerCase().includes(a.literal.toLowerCase())));
    if (i === -1) return true;
    used.add(i);
    return false;
  });
  const stale = allowlist.filter((_, i) => !used.has(i));
  return { left, stale };
}

export function runGuard() {
  const { left, stale } = applyAllowlist(findLiterals(), readAllowlist());
  const tokenProblems = checkTokens();
  return { left, stale, tokenProblems, ok: left.length === 0 && stale.length === 0 && tokenProblems.length === 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { left, stale, tokenProblems, ok } = runGuard();
  for (const h of left) console.error(`${h.file}:${h.line}  ${h.kind} ${h.literal}  →  use a token from ${TOKEN_FILE}\n    ${h.text}`);
  for (const s of stale) console.error(`palette-allowlist.json: entry no longer matches anything, remove it: ${JSON.stringify(s)}`);
  for (const p of tokenProblems) console.error(`${TOKEN_FILE}: ${p}`);
  if (!ok) {
    console.error(`\npalette check failed: ${left.length} hard-coded colour(s), ${stale.length} stale allowlist entr(ies), ${tokenProblems.length} token range problem(s).`);
    process.exit(1);
  }
  console.log('palette check: no hard-coded colours outside tokens.css; every token inside the reference ranges.');
}
