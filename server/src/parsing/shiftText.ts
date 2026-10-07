/**
 * Reads the times printed in one roster cell (or one day's sub-cells joined in column order)
 * into shift segments. Shared by the table reader and the AI reader's cross-check, so a cell
 * means the same thing whichever reader saw it.
 *
 * Every pure-time cell is a list of times read left to right; consecutive pairs are segments:
 *   "9-17", "17:00-01:00", "4pm to 2am", "4 PM - 2 AM", "6.30pm-1am"       → one segment
 *   "11 17 18 25" (AM start, AM end, PM start, PM end), "10-14/18-23",
 *   "10am/3pm-7pm/12am" (bridged split), "10:30-4:00-8:00-12" (chained)  → two segments
 * Times: 24h ("18:30"), dot separators ("18.30"), decimal hours ("18.5" = 18:30, "9.75" =
 * 09:45), hours past midnight ("25" = 01:00 next day), 12h with am/pm. A cell written on a
 * 12-hour clock without am/pm reads forward in time ("10:30-4:00-8:00-12" = 10:30-16:00 and
 * 20:00-00:00), the way such rotas are meant. Anything with other words in it is not a time cell.
 */

export interface ShiftSegment {
  /** HH:mm, 00-23. */
  start: string;
  /** HH:mm, 00-23. */
  end: string;
  /** The segment ends on the next calendar day. */
  overnight: boolean;
}

export interface ShiftTextOptions {
  /**
   * How "18.30" is meant when the cell alone can't tell: minutes (18:30) or decimal hours
   * (18.30 h). Unset: two-digit fractions other than .25/.50/.75/.00 are minutes, the rest decimal.
   */
  dotMeans?: 'minutes' | 'decimal';
}

interface Token {
  /** Minutes from the day's midnight; may exceed 1440 (hours past midnight). */
  minutes: number;
  meridiem: 'am' | 'pm' | null;
  /** Hour as written (before am/pm), for the 12-hour reading. */
  hour: number;
  /** "09:00", "18.5", "26": a 24-hour (or decimal) way of writing, never a 12-hour clock. */
  twentyFour: boolean;
}

const TOKEN_RE = /(\d{1,2})(?:([:.])(\d{1,2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?![\d])/gi;
/** What may sit between times: dashes, slashes, commas, '&', and the words to / and / till / until. */
const isSeparatorText = (s: string) => /^[\s\-–—/;,&+]*$/.test(s.replace(/\b(?:to|and|till|until)\b/gi, ' '));

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (min: number) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

/** True when a dotted fraction is a typical decimal-hour fraction (.25, .5, .75). */
const decimalFraction = (frac: string) => ['25', '5', '50', '75', '0', '00'].includes(frac);

function readTokens(text: string, opts: ShiftTextOptions): Token[] | null {
  const tokens: Token[] = [];
  let rest = '';
  let last = 0;
  const dotted = [...text.matchAll(/\d{1,2}\.(\d{1,2})/g)].map((m) => m[1]!);
  const cellSaysMinutes = dotted.some((f) => f.length === 2 && !decimalFraction(f));
  for (const m of text.matchAll(TOKEN_RE)) {
    rest += text.slice(last, m.index);
    last = m.index! + m[0].length;
    const hour = Number(m[1]);
    const sep = m[2];
    const frac = m[3];
    const mer = m[4] ? (m[4].toLowerCase().startsWith('a') ? 'am' : 'pm') : null;
    let minutes: number;
    let twentyFour = hour > 12 || m[1]!.length === 2 && m[1]!.startsWith('0');
    if (!sep) minutes = hour * 60;
    else if (sep === ':') {
      if (frac!.length !== 2 || Number(frac) > 59) return null;
      minutes = hour * 60 + Number(frac);
    } else {
      // "18.5" / "9.75" are decimal hours; "18.30" is 18:30 unless told otherwise.
      const asMinutes = frac!.length === 2 && (opts.dotMeans === 'minutes' || (opts.dotMeans !== 'decimal' && (cellSaysMinutes || !decimalFraction(frac!))));
      if (asMinutes) {
        if (Number(frac) > 59) return null;
        minutes = hour * 60 + Number(frac);
      } else {
        minutes = Math.round((hour + Number(`0.${frac}`)) * 60);
        twentyFour = true;
      }
    }
    if (mer) {
      if (hour < 1 || hour > 12) return null;
      minutes = (minutes % 720) + (mer === 'pm' ? 720 : 0);
      twentyFour = false;
    } else if (hour > 30) return null;
    tokens.push({ minutes, meridiem: mer, hour, twentyFour });
  }
  rest += text.slice(last);
  if (!isSeparatorText(rest)) return null;
  return tokens;
}

/** Fills in am/pm a cell leaves out: a bare hour beside an am/pm one, or a whole 12-hour chain. */
function inferTwelveHour(tokens: Token[]): boolean {
  let inferred = false;
  // A bare start before an am/pm end ("6-11pm", "10-3pm"): the reading that gives a 1-14h shift, same half first.
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [a, b] = [tokens[i]!, tokens[i + 1]!];
    if (a.meridiem || !b.meridiem || a.twentyFour || a.hour > 12) continue;
    const base = a.minutes % 720;
    const options = b.meridiem === 'pm' ? [base + 720, base] : [base, base + 720];
    const dur = (s: number) => (((b.minutes - s) % 1440) + 1440) % 1440;
    const pick = options.find((s) => dur(s) >= 60 && dur(s) <= 14 * 60);
    if (pick !== undefined) {
      a.minutes = pick;
      inferred = true;
    }
  }
  // No am/pm anywhere and every time could be a 12-hour clock: each time is later than the one before.
  if (tokens.length >= 2 && tokens.every((t) => !t.meridiem && !t.twentyFour && t.hour >= 1 && t.hour <= 12)) {
    for (let i = 1; i < tokens.length; i++) {
      const prev = tokens[i - 1]!.minutes;
      const t = tokens[i]!;
      if (t.minutes <= prev && t.minutes + 720 > prev) {
        t.minutes += 720;
        inferred = true;
      }
    }
  }
  return inferred;
}

/**
 * The segments printed in a time cell, or null when the cell is not purely times (a code, a
 * note, a name) or its times don't pair up. `inferred` is true when am/pm had to be inferred.
 */
export function parseShiftText(raw: string, opts: ShiftTextOptions = {}): { segments: ShiftSegment[]; inferred: boolean } | null {
  const text = raw.trim().replace(/\bnoon\b/gi, '12pm').replace(/\bmidnight\b/gi, '12am');
  if (!text || !/\d/.test(text)) return null;
  const tokens = readTokens(text, opts);
  if (!tokens || tokens.length < 2 || tokens.length % 2 !== 0 || tokens.length > 6) return null;
  const inferred = inferTwelveHour(tokens);
  const segments: ShiftSegment[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const s = tokens[i]!.minutes % 1440;
    const e = tokens[i + 1]!.minutes % 1440;
    if (s === e) return null;
    segments.push({ start: hhmm(s), end: hhmm(e), overnight: e <= s });
  }
  return { segments, inferred };
}

/** One time on its own ("10", "4pm", "18.5") as HH:mm, or null. For open-ended cells ("10IN", "4CL"). */
export function parseSingleTime(raw: string, opts: ShiftTextOptions = {}): string | null {
  const tokens = readTokens(raw.trim(), opts);
  if (!tokens || tokens.length !== 1) return null;
  return hhmm(tokens[0]!.minutes % 1440);
}

/**
 * How a whole sheet writes dotted times: when any cell has a two-digit fraction that can't be a
 * decimal hour (".30", ".15", ".45"), every dotted time in the sheet is hours.minutes.
 */
export function sheetDotStyle(cells: string[]): ShiftTextOptions['dotMeans'] {
  for (const c of cells) {
    for (const m of c.matchAll(/\b\d{1,2}\.(\d{2})\b/g)) if (!decimalFraction(m[1]!)) return 'minutes';
  }
  return undefined;
}
