/**
 * Shared .xlsx writer for the fixture-generation scripts (make-*.mjs), on
 * exceljs — these used to call SheetJS `xlsx` directly (Issue #23).
 *
 * `sheets` is [{ name, rows, merges? }]. `rows` is an array of arrays
 * (null/undefined = blank cell, '' = empty-string cell). `merges` keeps the
 * SheetJS shape the scripts already use — `{ s: { r, c }, e: { r, c } }`,
 * 0-based — so the fixture definitions themselves did not need to change.
 */
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';

export async function writeXlsxFile(path, sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    worksheet.addRows(sheet.rows);
    for (const { s, e } of sheet.merges ?? []) worksheet.mergeCells(s.r + 1, s.c + 1, e.r + 1, e.c + 1);
  }
  writeFileSync(path, Buffer.from(await workbook.xlsx.writeBuffer()));
}
