import { periodSaid } from './vocabulary.js';

/**
 * Spoken shift times, read deterministically on the server. The model passes times as the caller
 * said them ("6", "6pm", "half past six", "18:30", "noon"); this decides what they mean, so the
 * same words always give the same shift, and a genuinely two-way reading is put to the caller
 * instead of guessed:
 *  - an hour with am/pm, a 24-hour time ("18:30", "06:00"), noon and midnight mean what they say;
 *  - a bare hour ("6") could be morning or evening: every reading is tried, and only shift
 *    lengths from 1 to 14 hours are kept (an end at or before the start runs past midnight);
 *  - one reading left is the answer ("6pm to 2" is 18:00–02:00, "18:30 to 1" is 18:30–01:00);
 *  - two left ("6 to 2": 06:00–14:00 or 18:00–02:00) is settled by a service word the caller said
 *    ("tonight", "closing", "lunch"), or else asked, the evening reading first.
 */
export interface SpokenTime {
  hour: number;
  minute: number;
  /** am/pm as said, or null. */
  meridiem: 'am' | 'pm' | null;
  /** The hour means itself: 24-hour form, noon/midnight, or am/pm given. */
  fixed: boolean;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const MINUTE_WORDS: Record<string, number> = { "o'clock": 0, oclock: 0, fifteen: 15, thirty: 30, 'forty five': 45, 'forty-five': 45, 'fourty five': 45 };

function hourOf(word: string): number | null {
  if (/^\d{1,2}$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

/** One time as said, or null when it isn't one. */
export function parseSpokenTime(raw: string | null | undefined): SpokenTime | null {
  if (!raw) return null;
  let s = raw
    .toLowerCase()
    .replace(/\b(p\.?\s?m\.?|pee\s?em)(?=\s|$)/g, 'pm')
    .replace(/\b(a\.?\s?m\.?|ay\s?em)(?=\s|$)/g, 'am')
    .replace(/\bin the (evening|night)\b/g, 'pm')
    .replace(/\bin the morning\b/g, 'am')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (/^(noon|midday|12 noon)$/.test(s)) return { hour: 12, minute: 0, meridiem: null, fixed: true };
  if (/^(midnight|12 midnight)$/.test(s)) return { hour: 0, minute: 0, meridiem: null, fixed: true };

  let meridiem: 'am' | 'pm' | null = null;
  const mer = s.match(/\s*\b(am|pm)$/) ?? s.match(/(am|pm)$/);
  if (mer) {
    meridiem = mer[1] as 'am' | 'pm';
    s = s.slice(0, s.length - mer[0].length).trim();
  }

  let hour: number | null = null;
  let minute = 0;
  let twentyFour = false;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,2})[:.h](\d{2})$/))) {
    hour = Number(m[1]);
    minute = Number(m[2]);
    // "06:00", "18:30": a two-digit hour is the 24-hour clock.
    twentyFour = m[1]!.length === 2;
  } else if ((m = s.match(/^(\d{2})(\d{2})$/))) {
    hour = Number(m[1]);
    minute = Number(m[2]);
    twentyFour = true;
  } else if ((m = s.match(/^(half|quarter) past (\S+)$/))) {
    hour = hourOf(m[2]!);
    minute = m[1] === 'half' ? 30 : 15;
  } else if ((m = s.match(/^quarter to (\S+)$/))) {
    const h = hourOf(m[1]!);
    hour = h === null ? null : h === 1 ? 12 : h - 1;
    minute = 45;
  } else if ((m = s.match(/^(\S+)(?: (o'clock|oclock|fifteen|thirty|forty[- ]five|fourty five))?$/))) {
    hour = hourOf(m[1]!);
    minute = m[2] ? (MINUTE_WORDS[m[2]] ?? 0) : 0;
  }
  if (hour === null || !Number.isInteger(hour) || minute < 0 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    return { hour, minute, meridiem, fixed: true };
  }
  if (hour > 23) return null;
  // 13–23 and 0 are only ever the 24-hour clock.
  return { hour, minute, meridiem: null, fixed: twentyFour || hour >= 13 || hour === 0 };
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/** Every 24-hour reading of a spoken time, in minutes after midnight. */
function readingsOf(t: SpokenTime): number[] {
  if (t.meridiem) return [((t.hour % 12) + (t.meridiem === 'pm' ? 12 : 0)) * 60 + t.minute];
  if (t.fixed) return [t.hour * 60 + t.minute];
  const am = (t.hour % 12) * 60 + t.minute;
  return [am, am + 12 * 60];
}

const MIN_SHIFT = 60;
const MAX_SHIFT = 14 * 60;
/** Length of a shift from `start` to `end` minutes, past midnight when end ≤ start. */
const lengthOf = (start: number, end: number) => (end > start ? end - start : end + 24 * 60 - start);

export type ShiftTimes = { start: string; end: string };
export type TimesReading =
  | { kind: 'one'; times: ShiftTimes }
  /** Two plausible readings: the evening one first. */
  | { kind: 'choice'; readings: ShiftTimes[] }
  /** Not a time, or no plausible shift. */
  | { kind: 'none' };

/**
 * A shift's start and end as said. `transcript` lets a service word ("tonight", "lunch") settle a
 * two-way reading.
 */
export function readShiftTimes(startHeard: string | null | undefined, endHeard: string | null | undefined, transcript = ''): TimesReading {
  const s = parseSpokenTime(startHeard);
  const e = parseSpokenTime(endHeard);
  if (!s || !e) return { kind: 'none' };
  const fixedBoth = (s.fixed || s.meridiem) && (e.fixed || e.meridiem);
  const pairs: [number, number][] = [];
  for (const a of readingsOf(s)) for (const b of readingsOf(e)) if (a !== b) pairs.push([a, b]);
  // Exactly what was said is used as said; only a bare hour is checked for a plausible length.
  const plausible = fixedBoth ? pairs : pairs.filter(([a, b]) => lengthOf(a, b) >= MIN_SHIFT && lengthOf(a, b) <= MAX_SHIFT);
  return settle(plausible, transcript);
}

/**
 * A new start or end for an existing shift (`keep` is the side that stays, as HH:MM): the reading
 * that keeps the shift a plausible length.
 */
export function readOneTime(heard: string | null | undefined, side: 'start' | 'end', keep: string, transcript = ''): TimesReading {
  const t = parseSpokenTime(heard);
  const k = parseSpokenTime(keep);
  if (!t || !k) return { kind: 'none' };
  const kept = k.hour * 60 + k.minute;
  const pairs: [number, number][] = readingsOf(t).filter((x) => x !== kept).map((x) => (side === 'start' ? [x, kept] : [kept, x]));
  const plausible = t.fixed || t.meridiem ? pairs : pairs.filter(([a, b]) => lengthOf(a, b) >= MIN_SHIFT && lengthOf(a, b) <= MAX_SHIFT);
  return settle(plausible, transcript);
}

function settle(pairs: [number, number][], transcript: string): TimesReading {
  const unique = [...new Map(pairs.map(([a, b]) => [`${a}-${b}`, [a, b] as [number, number]])).values()];
  if (!unique.length) return { kind: 'none' };
  const asTimes = ([a, b]: [number, number]): ShiftTimes => ({ start: hhmm(a), end: hhmm(b) });
  if (unique.length === 1) return { kind: 'one', times: asTimes(unique[0]!) };
  // The evening reading first: a later start sorts first.
  const ordered = [...unique].sort((x, y) => y[0] - x[0]);
  const period = periodSaid(transcript);
  if (period) {
    const fits = ordered.filter(([a]) => (period === 'PM' ? a >= 12 * 60 : a < 12 * 60));
    if (fits.length === 1) return { kind: 'one', times: asTimes(fits[0]!) };
  }
  return { kind: 'choice', readings: ordered.slice(0, 2).map(asTimes) };
}

/** True for HH:MM on the 24-hour clock (00:00–23:59). */
export function isClockTime(s: unknown): s is string {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
