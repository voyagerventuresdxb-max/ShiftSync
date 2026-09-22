/**
 * Test-only helper: builds an in-memory .xlsx from arrays of rows, so parser
 * tests can exercise the REAL read path (workbookReader.ts) on a genuine
 * workbook buffer — merges included — instead of a pre-built grid.
 *
 * Replaces the SheetJS `aoa_to_sheet` / `!merges` / `XLSX.write` boilerplate
 * those tests used to repeat. Not imported by production code.
 *
 * Cell semantics match `aoa_to_sheet`: `null`/`undefined` is a blank cell, an
 * empty string is an empty-string cell, and `merges` are A1-notation ranges
 * (e.g. 'B1:C1' is one row, two columns; 'A2:A3' is one column, two rows).
 */
import ExcelJS from 'exceljs';

export interface TestSheet {
  name: string;
  rows: unknown[][];
  merges?: string[];
}

export async function buildXlsx(sheets: TestSheet[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    worksheet.addRows(sheet.rows as ExcelJS.CellValue[][]);
    for (const range of sheet.merges ?? []) worksheet.mergeCells(range);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
