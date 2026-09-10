import { readFileSync } from 'node:fs';
import { renderPdfPagesToImages, extractOcrFromImage } from '../src/parsing/ocrExtractor.js';

const pdfPath = process.argv[2] ?? 'server/test-fixtures/real-roster.pdf';
const buffer = readFileSync(pdfPath);

console.log(`[verify] PDF size: ${Math.round(buffer.length / 1024)}KB`);

const pages = await renderPdfPagesToImages(buffer, 2);
console.log(`[verify] Rendered ${pages.length} page(s)`);
for (let i = 0; i < pages.length; i++) {
  console.log(`[verify] page ${i + 1}: ${Math.round(pages[i].length / 1024)}KB PNG`);
}

// Force the OCR-on-rendered-image path (what a scanned/grid PDF would hit).
const words = await extractOcrFromImage(pages[0]);
console.log(`[verify] Tesseract on rendered page: ${words.length} words`);
if (words.length > 0) {
  console.log(`[verify] first 8 words: ${words.slice(0, 8).map((w) => w.text).join(' | ')}`);
} else {
  console.log('[verify] FAIL: no words extracted from rendered page');
}
