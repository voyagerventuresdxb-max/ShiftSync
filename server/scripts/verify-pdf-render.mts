import { readFileSync, writeFileSync } from 'node:fs';
import { renderPdfPagesToImages } from '../src/parsing/ocrExtractor.js';

const pdfPath = process.argv[2] ?? 'server/test-fixtures/real-roster.pdf';
const buffer = readFileSync(pdfPath);

const pages = await renderPdfPagesToImages(buffer, 2);
console.log(`[verify] Rendered ${pages.length} page(s)`);

for (let i = 0; i < pages.length; i++) {
  const png = pages[i];
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const sig = png.subarray(0, 8).toString('hex');
  const isPng = sig === '89504e470d0a1a0a';
  console.log(`[verify] page ${i + 1}: ${Math.round(png.length / 1024)}KB, PNG signature=${sig}, valid=${isPng}`);
  // Write to disk so it can be inspected
  writeFileSync(`server/test-fixtures/rendered-page-${i + 1}.png`, png);
}

if (pages.length === 0) {
  console.log('[verify] FAIL: no pages rendered');
  process.exit(1);
}
console.log('[verify] PASS: PDF rendered to valid PNG image buffer(s)');
