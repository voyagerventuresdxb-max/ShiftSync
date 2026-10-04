#!/usr/bin/env node
/**
 * Regenerates the synthetic roster fixtures in server/test-fixtures/synthetic/ — public stand-ins
 * for the real venue rosters kept out of the repository (see docs/test-fixtures.md). Every name
 * is made up. Run from the repo root:  node server/scripts/make-synthetic-roster-fixtures.mjs
 *
 *  - text-roster.pdf     text-layer PDF, day-grid layout of the real text-layer reference roster:
 *                        a COVERS caption row with annotations above the listing, 3 unlabeled
 *                        management rows, section headers printed in a middle column beside a stray
 *                        headcount number, AM/PM "11 17 18 25" cells, a blank-week employee inside
 *                        a section, and a legend box in a trailing column that lines up with rows.
 *  - roster.png          the same roster as an image (for OCR/vision tooling).
 *  - scanned-roster.pdf  image-only PDF (no text layer) of a per-row-title layout like the real
 *                        scanned reference roster: title column + name column, shorthand cells
 *                        (OFF, 12CL, 10IN, UL, AL, "4pm to 2am", "10am/3pm-7pm/12am").
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chromium } from '@playwright/test';

const OUT = 'server/test-fixtures/synthetic';
mkdirSync(OUT, { recursive: true });

const DAYS = ['17-Aug', '18-Aug', '19-Aug', '20-Aug', '21-Aug', '22-Aug', '23-Aug'];

/** Rows of the day-grid roster: [label, cells per day (7), legend column entry?]. */
const TEXT_ROSTER = [
  ['COVERS', ['', 'Party - 20pax', '', '', 'Launch - 45pax', '', '']], // caption above the staff listing
  ['Test Manager Avery', ['11 17 18 25', '11 17 18 25', '', '11 17 18 25', '11 17 18 25', '11 17', '']],
  ['Test Manager Blake', ['', '12 16 18 24', '12 16 18 24', '12 16 18 24', '', '18 25', '18 25']],
  ['Test Manager Casey', ['10 16', '10 16', '10 16', '', '', '10 16', '10 16']],
  ['@SUPERVISORS', 2],
  ['Test Supervisor Dana', ['11 17 18 25', '', '11 17 18 25', '11 17 18 25', '11 17 18 25', '', '11 17']],
  ['Test Supervisor Ellis', ['', '11 17 18 25', '11 17 18 25', '', '18 25', '11 17 18 25', '11 17 18 25']],
  ['@HEAD WAITERS', 3],
  ['Test Head Finley', ['12 16 18 24', '12 16 18 24', '', '', '12 16 18 24', '12 16 18 24', '12 16']],
  ['Test Head Gray', ['', '', '', '', '', '', '']], // blank week inside a real section: never a header, no rows
  ['Test Head Harper', ['', '18 25', '18 25', '18 25', '18 25', '', '18 25']],
  ['@WAITERS', 1],
  ['Test Waiter Indigo', ['11 17', '11 17', '11 17', '', '', '18 25', '18 25']],
  ['@RUNNERS', 4],
  ['Test Runner Jules', ['12 16', '12 16', '', '12 16', '12 16', '18 24', ''], 'AL'], // has shifts: legend entry ignored
  ['Test Runner Kai', ['', '', '', '', '', '', ''], 'PH'], // no shifts: legend entry surfaces as a leave record
  ['Test Runner Lee', ['', '', '', '', '', '', ''], 'Request'],
  ['Test Runner Morgan', ['18 24', '18 24', '18 24', '', '18 24', '18 24', ''], 'SL'],
];

async function textRosterPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([842, 595]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const dayX = (i) => 150 + i * 80;
  const draw = (text, x, y) => page.drawText(text, { x, y, size: 9, font });
  let y = 560;
  DAYS.forEach((d, i) => draw(d, dayX(i), y));
  for (const [label, cells, legend] of TEXT_ROSTER) {
    y -= 22;
    if (label.startsWith('@')) {
      // Section header printed in a middle column, sharing its row with a stray headcount number.
      draw(label.slice(1), dayX(3), y);
      draw(String(cells), dayX(6), y);
      continue;
    }
    draw(label, 20, y);
    cells.forEach((c, i) => c && draw(c, dayX(i), y));
    if (legend) draw(legend, 740, y);
  }
  writeFileSync(`${OUT}/text-roster.pdf`, Buffer.from(await doc.save()));
}

const htmlTable = (head, rows) =>
  `<html><body style="margin:0;background:#fff;font:13px Arial"><table id="t" border="1" cellpadding="5" style="border-collapse:collapse">` +
  `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>` +
  rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
  `</table></body></html>`;

const SCANNED_HEAD = ['', 'Name', ...['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']];
const SCANNED_ROWS = [
  ['RM', 'Test Person Nova', 'OFF', '12CL', '10IN', 'OFF', 'IN', '4CL', 'UL'],
  ['AM', 'Test Person Orion', '2CL', 'OFF', 'OFF', '4CL', '4CL', 'UL', '4CL'],
  ['Supervisor', 'Test Person Piper', '10:30-4:00-8:00-12', '10:30-4:00-8:00-12', 'UL', 'OFF', 'OFF', 'AL', 'AL'],
  ['WAITER', '', '', '', '', '', '', '', ''],
  ['Waiter 1', 'Test Person Quinn', '4pm to 2am', 'OFF', '1pm to 11pm', '10am/3pm-7pm/12am', '10am/3pm-7pm/12am', 'OFF', 'OFF'],
  ['Waiter 2', 'Test Person Reese', 'UL', 'UL', 'UL', 'UL', 'UL', 'OFF', 'OFF'],
];

async function images() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1 });
    const gridRows = TEXT_ROSTER.map(([label, cells, legend]) =>
      label.startsWith('@') ? [`<b>${label.slice(1)}</b>`, '', '', '', '', '', '', '', ''] : [label, ...cells, legend ?? ''],
    );
    await page.setContent(htmlTable(['', ...DAYS, 'Key'], gridRows));
    await page.locator('#t').screenshot({ path: `${OUT}/roster.png` });

    await page.setContent(htmlTable(SCANNED_HEAD, SCANNED_ROWS));
    const png = await page.locator('#t').screenshot();
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(png);
    const pdfPage = doc.addPage([img.width, img.height]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    writeFileSync(`${OUT}/scanned-roster.pdf`, Buffer.from(await doc.save()));
  } finally {
    await browser.close();
  }
}

await textRosterPdf();
await images();
console.log(`[synthetic-fixtures] wrote ${OUT}/text-roster.pdf, roster.png, scanned-roster.pdf`);
