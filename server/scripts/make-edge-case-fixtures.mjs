/**
 * Edge-case roster fixtures for the section-header parsing audit:
 *   1. all-caps-roster.xlsx      — venue/staff/headers all ALL-CAPS
 *   2. novel-header-vocab.xlsx   — unconventional Title-Case section labels
 *   3. no-anchor-first-header.xlsx — ALL-CAPS header is the very first row
 *      (no unlabeled staff row above it to set hasSeenAnyStaffRow)
 *   5. combined-worst-case.xlsx  — ALL-CAPS staff + novel ALL-CAPS headers
 * (4, the skewed scanned-image PDF, is built separately — needs rasterization.)
 */
import * as XLSX from 'xlsx';
import { writeFileSync } from 'node:fs';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function writeXlsx(rows, filename) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Roster');
  writeFileSync(`server/test-fixtures/edge-case-audit/${filename}`, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  console.log(`written ${filename}`);
}

// 1. ALL-CAPS-only roster
{
  const rows = [
    ['MARINA SKY LOUNGE — WEEK OF 24-AUG-2026', '', '', '', '', '', '', ''],
    ['', ...DAYS],
    ['SUPERVISORS', '', '', '', '', '', '', ''],
    ['FATIMA HASSAN', '9-17', '9-17', 'OFF', '9-17', '14-22', '14-22', 'OFF'],
    ['YUSUF KARIM', '14-22', '14-22', '14-22', 'OFF', '9-17', '9-17', 'OFF'],
    ['RUNNERS', '', '', '', '', '', '', ''],
    ['CHEN WEI LING', '9-13', '9-13', '14-18', '14-18', 'OFF', '9-13', '9-13'],
    ['DIVYA MENON', '14-18', 'OFF', '9-13', '9-13', '14-18', '14-18', 'OFF'],
  ];
  writeXlsx(rows, '1-all-caps-roster.xlsx');
}

// 2. Novel/unconventional section header vocabulary (Title Case — neither
// ROLE_ALIASES vocabulary nor the ALL-CAPS structural signal will fire)
{
  const rows = [
    ['', ...DAYS],
    ['Poolside Detail', '', '', '', '', '', '', ''],
    ['Amira Saleh', '10-18', '10-18', 'OFF', '10-18', '14-22', '14-22', 'OFF'],
    ['Bilal Rahman', '14-22', '14-22', '14-22', 'OFF', '10-18', '10-18', 'OFF'],
    ['Shisha Terrace', '', '', '', '', '', '', ''],
    ['Nadia Farouk', '17-01', '17-01', 'OFF', '17-01', '17-01', '17-01', 'OFF'],
    ['Valet & Door', '', '', '', '', '', '', ''],
    ['Hamza Idris', '18-02', 'OFF', '18-02', '18-02', '18-02', '18-02', 'OFF'],
  ];
  writeXlsx(rows, '2-novel-header-vocab.xlsx');
}

// 3. No unlabeled staff rows above the first section header — the header
// IS row 0 of the staff block, so hasSeenAnyStaffRow is still false when
// the parser reaches it. Header text is ALL-CAPS but NOT in ROLE_ALIASES
// (so only the structural signal could catch it, and that signal is gated
// on having already seen a staff row).
{
  const rows = [
    ['', ...DAYS],
    ['FRONT OF HOUSE', '', '', '', '', '', '', ''],
    ['Layla Nasser', '10-18', '10-18', 'OFF', '10-18', '14-22', '14-22', 'OFF'],
    ['Omar Fathi', '14-22', '14-22', '14-22', 'OFF', '10-18', '10-18', 'OFF'],
    ['BACK OF HOUSE', '', '', '', '', '', '', ''],
    ['Sara Jamal', '9-17', '9-17', '13-21', 'OFF', '9-17', '13-21', 'OFF'],
  ];
  writeXlsx(rows, '3-no-anchor-first-header.xlsx');
}

// 5. Combined worst case: ALL-CAPS staff names + novel ALL-CAPS headers.
// Once a staff row has been seen, an ALL-CAPS novel header and an ALL-CAPS
// staff name are structurally identical to isRoleHeaderLabel — this tests
// whether the two failure modes compound.
{
  const rows = [
    ['', ...DAYS],
    ['NIGHT SQUAD', '', '', '', '', '', '', ''],
    ['KARIM EL-SAYED', '18-02', '18-02', 'OFF', '18-02', '18-02', '18-02', 'OFF'],
    ['REEM FAKHOURY', '18-02', 'OFF', '18-02', '18-02', '18-02', '18-02', 'OFF'],
    ['DAY SQUAD', '', '', '', '', '', '', ''],
    ['TARIQ AZIZ', '9-17', '9-17', '13-21', 'OFF', '9-17', '13-21', 'OFF'],
    ['MONA SAEED', '9-17', 'OFF', '9-17', '13-21', '13-21', '9-17', 'OFF'],
  ];
  writeXlsx(rows, '5-combined-worst-case.xlsx');
}

console.log('all edge-case fixtures written');
