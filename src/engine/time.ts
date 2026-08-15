/**
 * Time and date helpers for the ShiftSync engine.
 * Pure functions, no external dependencies.
 */

/** Parse a time string ("6pm", "18:00", "6:30pm", "1800") into 24h "HH:MM". */
export function parseTime(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  // 24h "HH:MM" or "HHMM"
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return pad(m[1], m[2]);

  m = s.match(/^(\d{1,2})(\d{2})$/);
  if (m) return pad(m[1], m[2]);

  // 12h with am/pm: "6pm", "6:30pm", "6 pm", "6:30 pm"
  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? m[2] : '00';
    const meridiem = m[3];
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    return pad(String(h), min);
  }

  return null;
}

function pad(h: string, min: string): string {
  return `${h.padStart(2, '0')}:${min.padStart(2, '0')}`;
}

/** True when a shift crosses midnight (end time is earlier than start). */
export function isOvernight(start: string, end: string): boolean {
  return end < start;
}

/** Duration in hours between two "HH:MM" times, handling overnight. */
export function shiftHours(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes < 0) minutes += 24 * 60;
  return minutes / 60;
}

/** Day-of-week name for a given ISO date. */
export function dayOfWeek(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
  });
}

/** Map a day name (or abbreviation) to an ISO date for a given week start. */
export function dayToDate(weekStart: string, dayName: string): string | null {
  const names: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
  };
  const key = dayName.trim().toLowerCase();
  const targetOffset = names[key];
  if (targetOffset === undefined) return null;
  const [y, m, d] = weekStart.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  // Offset of the weekStart's own day within the week (Sunday=0..Saturday=6).
  const startOffset = base.getDay();
  // Days from weekStart to the target day, wrapping within the week.
  const delta = (targetOffset - startOffset + 7) % 7;
  base.setDate(base.getDate() + delta);
  const yy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
