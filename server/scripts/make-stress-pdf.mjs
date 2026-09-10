/**
 * Fixture 7: text-layer PDF version of the legend-code shift pattern
 * (setupmyhotel.com-documented hotel duty-roster convention — single-letter
 * shift codes M/E/N/G with hours defined in a separate legend table, not
 * embedded in the cell). Tests the PDF positional-reconstruction path
 * (pdfjs-dist column anchoring from the header row) against a shape neither
 * permanent PDF fixture (Gattopardo, Bar des Pres) resembles.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const doc = await PDFDocument.create();
const page = doc.addPage([700, 420]);
const font = await doc.embedFont(StandardFonts.Helvetica);

const cols = [30, 150, 230, 280, 330, 380, 430, 480, 530]; // Name, Role, Mon..Sun
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function row(y, values) {
  values.forEach((v, i) => {
    if (v) page.drawText(v, { x: cols[i], y, size: 10, font });
  });
}

let y = 390;
row(y, ['', '', ...days]);
y -= 20;
row(y, ['Ahmed Ali', 'Waiter', 'M', 'M', 'E', 'OFF', 'N', 'M', 'E']);
y -= 20;
row(y, ['Noor Said', 'Captain', 'E', 'E', 'M', 'M', 'OFF', 'E', 'N']);
y -= 20;
row(y, ['Reem Fakhoury', 'Runner', 'M', 'OFF', 'M', 'E', 'E', 'N', 'M']);
y -= 40;
page.drawText('Shift Code Legend', { x: 30, y, size: 11, font });
y -= 20;
page.drawText('M = Morning 07:00-15:00', { x: 30, y, size: 10, font });
y -= 16;
page.drawText('E = Evening 15:00-23:00', { x: 30, y, size: 10, font });
y -= 16;
page.drawText('N = Night 23:00-07:00', { x: 30, y, size: 10, font });
y -= 16;
page.drawText('G = General 09:00-18:00', { x: 30, y, size: 10, font });
y -= 16;
page.drawText('OFF = Day Off', { x: 30, y, size: 10, font });

writeFileSync('server/test-fixtures/stress/7-legend-code-text-pdf.pdf', Buffer.from(await doc.save()));
console.log('written 7-legend-code-text-pdf.pdf');
