/**
 * Structurally diverse Dubai/GCC hospitality roster stress-test fixtures.
 * Each is grounded in a real, sourced pattern (see the gap-report writeup
 * this accompanies) — not arbitrary noise. Synthetic data, real structures:
 *   1. multi-outlet-single-file  — 7shifts' documented "Multi-Location
 *      Restaurant Schedule Template" pattern: 3 outlet blocks stacked in
 *      one sheet, each with its own title row + day-header row.
 *   2. legend-code-shifts        — the setupmyhotel.com-documented hotel
 *      duty-roster convention: single-letter shift codes (M/E/N/G) with
 *      actual hours defined in a separate legend table, not in the cell.
 *   3. bilingual-arabic-english  — MENA HR-document bilingual norm applied
 *      to a roster: Arabic+English day names and role labels.
 *   4. days-as-rows              — orthogonal orientation: dates down the
 *      left column, staff names across the header row.
 *   5. dubai-fine-dining-roles   — real fine-dining FOH/BOH hierarchy
 *      (Outlet Manager, Captain, Chef de Rang, Demi-Chef de Rang, Commis de
 *      Salle, Chef de Partie, Commis Chef) in an otherwise-normal grid.
 *   6. ramadan-split-shifts      — same normal grid shape, but every shift
 *      is a compliant ~6h split (2 short blocks) per the UAE's mandated
 *      Ramadan hours reduction — NOT a distinct template, per research;
 *      testing whether split-shift/gap logic holds up under realistic
 *      Ramadan-density content in the existing format.
 */
import { writeXlsxFile } from './xlsxWriter.mjs';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_AR = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];

async function writeXlsx(rows, merges, filename) {
  await writeXlsxFile(`server/test-fixtures/stress/${filename}`, [{ name: 'Roster', rows, merges }]);
  console.log(`written ${filename}`);
}

// 1. Multi-outlet single-file roster
{
  const pad = (r, n = 9) => [...r, ...Array(Math.max(0, n - r.length)).fill('')].slice(0, n);
  const rows = [
    pad(['ROOFTOP LOUNGE — Week of 24-Aug-2026']),
    pad(['', '', ...DAYS]),
    pad(['Layla Hassan', 'Waiter', '10-18', '10-18', 'OFF', '10-18', '14-22', '14-22', 'OFF']),
    pad(['Omar Youssef', 'Captain', '14-22', '14-22', '14-22', 'OFF', '10-18', '10-18', 'OFF']),
    pad([]),
    pad(['MAIN DINING — Week of 24-Aug-2026']),
    pad(['', '', ...DAYS]),
    pad(['Sara Ahmed', 'Chef de Rang', '10-18', 'OFF', '10-18', '10-18', '14-22', '14-22', 'OFF']),
    pad(['Khalid Nasser', 'Commis de Salle', '14-22', '14-22', 'OFF', '14-22', '10-18', '10-18', 'OFF']),
    pad([]),
    pad(['TERRACE BAR — Week of 24-Aug-2026']),
    pad(['', '', ...DAYS]),
    pad(['Priya Nair', 'Bartender', '17-01', '17-01', 'OFF', '17-01', '17-01', '17-01', 'OFF']),
  ];
  await writeXlsx(
    rows,
    [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
      { s: { r: 5, c: 0 }, e: { r: 5, c: 8 } },
      { s: { r: 10, c: 0 }, e: { r: 10, c: 8 } },
    ],
    '1-multi-outlet-single-file.xlsx',
  );
}

// 2. Legend-code shift system (M/E/N/G, hours defined separately)
{
  const pad = (r, n) => [...r, ...Array(Math.max(0, n - r.length)).fill('')].slice(0, n);
  const rows = [
    ['', '', ...DAYS],
    ['Ahmed Ali', 'Waiter', 'M', 'M', 'E', 'OFF', 'N', 'M', 'E'],
    ['Noor Said', 'Captain', 'E', 'E', 'M', 'M', 'OFF', 'E', 'N'],
    ['Reem Fakhoury', 'Runner', 'M', 'OFF', 'M', 'E', 'E', 'N', 'M'],
    [],
    ['Shift Code Legend'],
    ['M', 'Morning', '07:00-15:00'],
    ['E', 'Evening', '15:00-23:00'],
    ['N', 'Night', '23:00-07:00'],
    ['G', 'General', '09:00-18:00'],
    ['OFF', 'Day Off'],
  ].map((r) => pad(r, 9));
  await writeXlsx(rows, undefined, '2-legend-code-shifts.xlsx');
}

// 3. Bilingual Arabic/English headers
{
  const rows = [
    ['اسم الموظف Name', 'المنصب Role', ...DAYS.map((d, i) => `${d} ${DAYS_AR[i]}`)],
    ['فاطمة الزهراء Fatima Zahra', 'نادل Waiter', '10:00-18:00', '10:00-18:00', 'إجازة OFF', '10:00-18:00', '14:00-22:00', '14:00-22:00', 'إجازة OFF'],
    ['يوسف حسن Youssef Hassan', 'كابتن Captain', '14:00-22:00', '14:00-22:00', '14:00-22:00', 'إجازة OFF', '10:00-18:00', '10:00-18:00', 'إجازة OFF'],
  ];
  await writeXlsx(rows, undefined, '3-bilingual-arabic-english.xlsx');
}

// 4. Days-as-rows / staff-as-columns (orthogonal orientation)
{
  const rows = [
    ['Date', 'Layla Hassan', 'Omar Youssef', 'Sara Ahmed', 'Khalid Nasser'],
    ['24/08/2026 Mon', '10-18', 'OFF', '14-22', '10-18'],
    ['25/08/2026 Tue', '10-18', '14-22', 'OFF', '10-18'],
    ['26/08/2026 Wed', 'OFF', '14-22', '10-18', 'OFF'],
    ['27/08/2026 Thu', '10-18', 'OFF', '10-18', '14-22'],
    ['28/08/2026 Fri', '14-22', '10-18', '14-22', '10-18'],
    ['29/08/2026 Sat', '14-22', '10-18', '14-22', '10-18'],
    ['30/08/2026 Sun', 'OFF', 'OFF', 'OFF', 'OFF'],
  ];
  await writeXlsx(rows, undefined, '4-days-as-rows.xlsx');
}

// 5. Real Dubai fine-dining role hierarchy
{
  const rows = [
    ['', '', ...DAYS],
    ['SENIOR MANAGEMENT', '', '', '', '', '', '', ''],
    ['Karim El-Sayed', 'Outlet Manager', '10-22', '10-22', 'OFF', '10-22', '10-22', '10-22', 'OFF'],
    ['FLOOR', '', '', '', '', '', '', ''],
    ['Elena Petrova', 'Captain', '10-18', '10-18', '14-22', 'OFF', '10-18', '14-22', 'OFF'],
    ['Youssef Ibrahim', 'Chef de Rang', '14-22', '14-22', '10-18', '10-18', 'OFF', '10-18', '14-22'],
    ['Aisha Malik', 'Demi-Chef de Rang', '10-18', 'OFF', '10-18', '14-22', '14-22', '10-18', 'OFF'],
    ['Ravi Kumar', 'Commis de Salle', '14-22', '14-22', 'OFF', '10-18', '10-18', '14-22', '10-18'],
    ['KITCHEN', '', '', '', '', '', '', ''],
    ['Hassan Ali', 'Chef de Partie', '09-17', '09-17', '13-21', 'OFF', '09-17', '13-21', 'OFF'],
    ['Ana Cruz', 'Commis Chef', '13-21', '13-21', '09-17', '09-17', 'OFF', '09-17', '13-21'],
  ].map((r) => [...r, ...Array(Math.max(0, 9 - r.length)).fill('')].slice(0, 9));
  await writeXlsx(rows, undefined, '5-dubai-fine-dining-roles.xlsx');
}

// 6. Ramadan-compressed split shifts (same normal grid, ~6h split content)
{
  const rows = [
    ['', '', ...DAYS],
    ['Mona Saeed', 'Waiter', '11:00-14:00/18:00-21:00', '11:00-14:00/18:00-21:00', 'OFF', '11:00-14:00/18:00-21:00', '11:00-14:00/18:00-21:00', '11:00-14:00/18:00-21:00', 'OFF'],
    ['Tariq Aziz', 'Captain', '12:00-15:00/19:00-22:00', 'OFF', '12:00-15:00/19:00-22:00', '12:00-15:00/19:00-22:00', '12:00-15:00/19:00-22:00', '12:00-15:00/19:00-22:00', 'OFF'],
  ];
  await writeXlsx(rows, undefined, '6-ramadan-split-shifts.xlsx');
}

console.log('all fixtures written');
