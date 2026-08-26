import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";

const rows = [
  ["Employee Name", "Role", "Date", "Start Time", "End Time", "Manager Floor Notes"],
  ["Ahmed Khan", "Bartender", "20/08/2026", "17:00", "01:00", "Cover VIP section, restock garnish tray"],
  ["Fatima Al Suwaidi", "Floor Staff", "20/08/2026", "9:00 AM", "5:00 PM", ""],
  ["New Hire Person", "Runner", "20/08/2026", "10:00", "18:00", "Trial shift, pair with Ahmed"],
  ["", "Host", "21/08/2026", "09:00", "17:00", ""],
];

const ws = XLSX.utils.aoa_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Roster");
writeFileSync("server/test-fixtures/sample-roster.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
console.log("written");
