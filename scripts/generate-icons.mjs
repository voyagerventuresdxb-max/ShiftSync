#!/usr/bin/env node
/**
 * Renders the home-screen / PWA icons from the EXISTING logo mark
 * (public/shiftsync-mark.svg) — no new artwork. The mark is a 2:1 wordless
 * infinity stroke, so each icon is a square of the app background
 * (--bg, #0F0F12) with the mark centred at 70% of the width: that keeps the
 * whole stroke inside the 80%-diameter safe circle a maskable icon can be
 * cropped to, so nothing is cut off on Android, and iOS (which applies its
 * own rounded corners) shows the same composition.
 *
 * Output (committed — this script is a regeneration convenience, and
 * `sharp` is only a transitive dependency today):
 *   public/icons/apple-touch-icon-180.png   iOS Add to Home Screen
 *   public/icons/icon-192.png               manifest, Android/desktop
 *   public/icons/icon-512.png               manifest, splash / maskable
 *
 * Usage: node scripts/generate-icons.mjs
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public', 'shiftsync-mark.svg'));
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BACKGROUND = { r: 0x0f, g: 0x0f, b: 0x12, alpha: 1 }; // --bg
const MARK_WIDTH_RATIO = 0.7;

async function render(size, filename) {
  const markWidth = Math.round(size * MARK_WIDTH_RATIO);
  const mark = await sharp(svg, { density: 384 }).resize({ width: markWidth }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toFile(join(outDir, filename));
  console.log(`${filename}  ${size}×${size}`);
}

await render(180, 'apple-touch-icon-180.png');
await render(192, 'icon-192.png');
await render(512, 'icon-512.png');
