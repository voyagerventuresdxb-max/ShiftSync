import { writeXlsxFile } from './xlsxWriter.mjs';

const rows = [
  ["Employee Name", "Role", "Date", "Start Time", "End Time", "Manager Floor Notes"],
  ["Ahmed Khan", "Bartender", "20/08/2026", "17:00", "01:00", "Cover VIP section, restock garnish tray"],
  ["Fatima Al Suwaidi", "Floor Staff", "20/08/2026", "9:00 AM", "5:00 PM", ""],
  ["New Hire Person", "Runner", "20/08/2026", "10:00", "18:00", "Trial shift, pair with Ahmed"],
  ["", "Host", "21/08/2026", "09:00", "17:00", ""],
];

await writeXlsxFile("server/test-fixtures/sample-roster.xlsx", [{ name: "Roster", rows }]);
console.log("written");
