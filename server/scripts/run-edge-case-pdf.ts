import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseExcelGrid } from '../src/parsing/deterministicGridParser.js';
import { hasPdfTextLayer, extractPdfGrid } from '../src/parsing/pdfTableExtractor.js';
import { parseScannedPdfViaDocling, DoclingUnavailableError } from '../src/parsing/doclingClient.js';
import { parseRosterImage } from '../src/parsing/parseVision.js';

const WEEK_START = '2026-08-24';

function summarizeRows(rows: { employeeName: string; roleName: string; date: string; startTime: string; endTime: string }[]) {
  return rows.map((r) => `${r.employeeName} | role="${r.roleName}" | ${r.date} ${r.startTime}-${r.endTime}`).sort();
}

async function main() {
  const path = 'server/test-fixtures/edge-case-audit/4-skewed-scan.pdf';
  console.log(`\n=== 4. Skewed scanned-image-style PDF (${path}) — now via hosted Gemini/Vertex path ===`);
  const buf = readFileSync(path);
  const hasTextLayer = await hasPdfTextLayer(buf);
  console.log(`hasPdfTextLayer: ${hasTextLayer}`);

  if (hasTextLayer) {
    const grid = await extractPdfGrid(buf);
    const det = parseExcelGrid(grid, WEEK_START);
    console.log(`STAGE: PDF text-layer -> Deterministic Grid Parser (templateLabel="${det.templateLabel}")`);
    console.log(summarizeRows(det.rows).join('\n'));
    return;
  }

  console.log('STAGE: no text layer -> trying Docling sidecar');
  let doclingResult = null;
  try {
    doclingResult = await parseScannedPdfViaDocling(buf, path, WEEK_START);
  } catch (err) {
    if (err instanceof DoclingUnavailableError) {
      console.log('Docling sidecar unavailable -> falling to hosted vision model');
    } else {
      console.log('Docling threw:', err instanceof Error ? err.message : err);
    }
  }
  if (doclingResult) {
    console.log(`STAGE: Docling sidecar (${doclingResult.templateLabel})`);
    console.log(summarizeRows(doclingResult.rows).join('\n'));
    return;
  }

  console.log('STAGE: sending PDF directly to hosted vision model (no rasterization needed)');
  const started = Date.now();
  const visionResult = await parseRosterImage(buf, 'application/pdf', path, WEEK_START);
  console.log(`Vision call took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`STAGE: ${visionResult.templateLabel}`);
  console.log(`rows: ${visionResult.rows.length}, anomalies: ${visionResult.anomalies.length}`);
  console.log(summarizeRows(visionResult.rows).join('\n'));
  if (visionResult.anomalies.length) console.log('ANOMALIES:', JSON.stringify(visionResult.anomalies, null, 2));
  if (visionResult.legend.length) console.log('LEGEND:', JSON.stringify(visionResult.legend, null, 2));
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
