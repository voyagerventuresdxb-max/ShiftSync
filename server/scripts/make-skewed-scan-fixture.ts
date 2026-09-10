/**
 * Fixture 4: simulated messy/skewed scanned-image PDF. Builds a roster page
 * with rotated, unevenly-spaced text (approximating a phone photo of a
 * printed roster held at an angle), rasterizes it to a PNG via the same
 * pypdfium2 path the app uses for real scanned PDFs, then re-embeds that PNG
 * as the ONLY content of a fresh PDF (no text layer) so the pipeline is
 * forced down the true scanned-image branch (hasPdfTextLayer === false ->
 * Docling -> Ollama), not the text-layer/grid-reconstruction branch.
 */
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';
import { rasterizePdfPageToPng } from '../src/parsing/pdfRasterize.js';

const SKEW_DEG = 4.5; // consistent slight rotation, like a hand-held photo

async function main() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([720, 480]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const cols = [40, 170, 250, 310, 370, 430, 490, 550, 610];
  const rowsData = [
    ['', '', ...days],
    ['SUPERVISORS', '', '', '', '', '', '', '', ''],
    ['Aisha Rahman', 'Sup', '9-17', '9-17', 'OFF', '9-17', '14-22', '14-22', 'OFF'],
    ['Farid Hossein', 'Sup', '14-22', '14-22', '14-22', 'OFF', '9-17', '9-17', 'OFF'],
    ['RUNNERS', '', '', '', '', '', '', '', ''],
    ['Lin Mei', 'Run', '9-13', '9-13', '14-18', '14-18', 'OFF', '9-13', '9-13'],
    ['Yousef Adly', 'Run', '14-18', 'OFF', '9-13', '9-13', '14-18', '14-18', 'OFF'],
  ];

  // Draw the whole block rotated around a pivot to simulate a skewed photo,
  // plus small per-row jitter (uneven scan) instead of a perfectly clean grid.
  let y = 400;
  let seed = 7;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return ((seed / 2147483648) - 0.5) * 6; // +/-3pt
  };

  for (const row of rowsData) {
    row.forEach((v, i) => {
      if (!v) return;
      page.drawText(v, {
        x: cols[i] + jitter(),
        y: y + jitter(),
        size: 10,
        font,
        color: rgb(0.15, 0.15, 0.15),
        rotate: degrees(SKEW_DEG),
      });
    });
    y -= 42; // wider, uneven-looking spacing typical of a photographed page
  }

  const vectorPdfBytes = await doc.save();

  // Rasterize to a real PNG (same pypdfium2 path the app uses for scanned
  // PDFs), so the "scanned" fixture is genuine pixels, not vector text.
  const png = await rasterizePdfPageToPng(Buffer.from(vectorPdfBytes), 1, 2.0);
  writeFileSync('server/test-fixtures/edge-case-audit/4-skewed-scan-rasterized.png', png);

  // Re-embed as an IMAGE-ONLY pdf (no text layer at all) so hasPdfTextLayer
  // returns false and the pipeline takes the true scanned/Docling/Ollama path.
  const imageDoc = await PDFDocument.create();
  const pngImage = await imageDoc.embedPng(png);
  const scaled = pngImage.scale(0.5); // rasterized at 2x, halve back to page size
  const imgPage = imageDoc.addPage([scaled.width, scaled.height]);
  imgPage.drawImage(pngImage, { x: 0, y: 0, width: scaled.width, height: scaled.height });
  const finalBytes = await imageDoc.save();
  writeFileSync('server/test-fixtures/edge-case-audit/4-skewed-scan.pdf', Buffer.from(finalBytes));

  console.log('written 4-skewed-scan.pdf and 4-skewed-scan-rasterized.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
