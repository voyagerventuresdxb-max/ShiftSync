/**
 * Round-2 adversarial roster fixtures — one stressor isolated per fixture,
 * per the round-2 audit brief. See MEMORY.md for the audit writeup this
 * accompanies. Synthetic data, realistic structures.
 */
import { mkdirSync } from 'node:fs';
import { writeXlsxFile } from './xlsxWriter.mjs';

const DIR = 'server/test-fixtures/edge-case-audit-round2';
mkdirSync(DIR, { recursive: true });

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function writeXlsx(rows, filename, opts = {}) {
  await writeXlsxFile(`${DIR}/${filename}`, [{ name: opts.sheetName ?? 'Roster', rows, merges: opts.merges }]);
  console.log(`written ${filename}`);
}

// 1. Bilingual / Arabic-script content — staff names and one section
// header in Arabic script mixed with English, RTL text in cells.
{
  const rows = [
    ['', ...DAYS],
    ['خدمة الطعام Service', '', '', '', '', '', '', ''],
    ['فاطمة الزهراني Fatima Al-Zahrani', '9-17', '9-17', 'OFF', '9-17', '14-22', '14-22', 'OFF'],
    ['Ahmed محمد العتيبي', '14-22', '14-22', '14-22', 'OFF', '9-17', '9-17', 'OFF'],
    ['البار Bar', '', '', '', '', '', '', ''],
    ['سارة يوسف Sara Youssef', '17-01', '17-01', 'OFF', '17-01', '17-01', '17-01', 'OFF'],
  ];
  await writeXlsx(rows, '1-bilingual-arabic.xlsx');
}

// 2a. Merged cell spanning what should be the header (day-name) row.
{
  const rows = [
    ['Weekly Roster — All Days', '', '', '', '', '', '', ''],
    ['', ...DAYS],
    ['Layla Hassan', '10-18', '10-18', 'OFF', '10-18', '14-22', '14-22', 'OFF'],
    ['Omar Youssef', '14-22', '14-22', '14-22', 'OFF', '10-18', '10-18', 'OFF'],
  ];
  // Merge the entire first row (a title banner) across all 8 columns —
  // the row directly ABOVE the real day-header row.
  await writeXlsx(rows, '2a-merged-header-row.xlsx', {
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }],
  });
}

// 2b. Merged cell spanning multiple staff rows (e.g. one name cell
// vertically merged across 3 rows, as if one person's name was merged to
// visually "group" several shift rows under one label).
{
  const rows = [
    ['', ...DAYS],
    ['Karim El-Sayed', '10-18', '10-18', 'OFF', '10-18', '14-22', '14-22', 'OFF'],
    ['', '14-22', '14-22', '14-22', 'OFF', '10-18', '10-18', 'OFF'],
    ['', '9-17', '9-17', '13-21', 'OFF', '9-17', '13-21', 'OFF'],
    ['Reem Fakhoury', '9-17', 'OFF', '9-17', '13-21', '13-21', '9-17', 'OFF'],
  ];
  // "Karim El-Sayed" merged vertically across rows 1-3 (0-indexed 1..3) —
  // as if 3 different shift patterns belonged to one merged name cell.
  await writeXlsx(rows, '2b-merged-staff-rows.xlsx', {
    merges: [{ s: { r: 1, c: 0 }, e: { r: 3, c: 0 } }],
  });
}

// 3. Multi-sheet workbook — 3 tabs: a "Notes" tab first (no roster data),
// the REAL roster on tab 2, and a "Prior Week" tab third (different,
// decoy roster data) — tests whether the app reads the right tab at all.
{
  const notesRows = [
    ['Notes for the week'],
    ['Please confirm holiday cover by Thursday.'],
    ['Contact: manager@venue.ae'],
  ];
  const realRows = [
    ['', ...DAYS],
    ['Amara Okafor', '9-17', '9-17', 'OFF', '9-17', '14-22', '14-22', 'OFF'],
    ['Priya Nair', '14-22', '14-22', '14-22', 'OFF', '9-17', '9-17', 'OFF'],
  ];
  const decoyRows = [
    ['', ...DAYS],
    ['Zeynep Kaya', '10-18', '10-18', 'OFF', '10-18', '10-18', 'OFF', 'OFF'],
  ];
  await writeXlsxFile(`${DIR}/3-multi-sheet-workbook.xlsx`, [
    { name: 'Notes', rows: notesRows },
    { name: 'This Week', rows: realRows },
    { name: 'Prior Week (archive)', rows: decoyRows },
  ]);
  console.log('written 3-multi-sheet-workbook.xlsx');
}

// 4. Split shifts — same staff member twice in one day, two non-overlapping
// ranges (lunch + dinner), using the slash-separated multi-segment cell
// form the parser already documents supporting.
{
  const rows = [
    ['', ...DAYS],
    ['Hassan Ali', '11am-3pm/6pm-11pm', '11am-3pm/6pm-11pm', 'OFF', '11am-3pm/6pm-11pm', '11am-3pm/6pm-11pm', '11am-3pm/6pm-11pm', 'OFF'],
    ['Ana Cruz', '9-17', '9-17', '9-17', 'OFF', '9-17', '9-17', 'OFF'],
  ];
  await writeXlsx(rows, '4-split-shifts.xlsx');
}

// 5. Time-format inconsistency — 12hr and 24hr mixed in the same file,
// "TBD"/"Close"/missing end time, and a real overnight shift (23:00-02:00).
{
  const rows = [
    ['', ...DAYS],
    ['Tariq Aziz', '9:00am-5:00pm', '09:00-17:00', 'OFF', '23:00-02:00', 'TBD', 'Close', '9-5'],
    ['Mona Saeed', '14:00-22:00', '2pm-10pm', 'OFF', '9:00-17:00', '9:00am-', '', 'OFF'],
  ];
  await writeXlsx(rows, '5-time-format-inconsistency.xlsx');
}

// 6. Footer/trailing noise — signature block, Prepared/Approved by lines, a
// totals row, and a role-abbreviation legend, all below the real data.
{
  const rows = [
    ['', '', ...DAYS],
    ['Sup', 'Aisha Rahman', '9-17', '9-17', 'OFF', '9-17', '14-22', '14-22', 'OFF'],
    ['Run', 'Farid Hossein', '14-22', '14-22', '14-22', 'OFF', '9-17', '9-17', 'OFF'],
    [],
    ['Total hours', '', '', '', '', '', '', ''],
    [],
    ['Prepared by: _______________', '', '', '', '', '', '', ''],
    ['Approved by: _______________', '', '', '', '', '', '', ''],
    [],
    ['Legend: Sup = Supervisor, Run = Runner'],
  ];
  await writeXlsx(rows, '6-footer-trailing-noise.xlsx');
}

// 7a. Missing structure — no day-of-week column at all (just a flat
// name+role+single-shift list, no date/day headers the grid parser can
// anchor on).
{
  const rows = [
    ['Name', 'Role', 'Shift'],
    ['Layla Nasser', 'Waiter', '10-18'],
    ['Omar Fathi', 'Runner', '14-22'],
  ];
  await writeXlsx(rows, '7a-missing-day-column.xlsx');
}

// 7b. Extra structure — an unexplained extra column inserted mid-table
// (between the name column and the day columns).
{
  const rows = [
    ['', 'Badge #', ...DAYS],
    ['Sara Jamal', 'B-1042', '9-17', '9-17', '13-21', 'OFF', '9-17', '13-21', 'OFF'],
    ['Khalid Nasser', 'B-1043', '14-22', '14-22', 'OFF', '14-22', '10-18', '10-18', 'OFF'],
  ];
  await writeXlsx(rows, '7b-extra-column.xlsx');
}

// 8. Nested sub-headers — a role header ("SERVICE") followed by a
// second-level sub-header ("Breakfast", "Lunch") before staff rows.
{
  const rows = [
    ['', ...DAYS],
    ['SERVICE', '', '', '', '', '', '', ''],
    ['Breakfast', '', '', '', '', '', '', ''],
    ['Youssef Ibrahim', '6-11', '6-11', 'OFF', '6-11', '6-11', '6-11', 'OFF'],
    ['Lunch', '', '', '', '', '', '', ''],
    ['Aisha Malik', '11-16', '11-16', '11-16', 'OFF', '11-16', '11-16', 'OFF'],
  ];
  await writeXlsx(rows, '8-nested-subheaders.xlsx');
}

console.log('all round-2 audit fixtures written');
