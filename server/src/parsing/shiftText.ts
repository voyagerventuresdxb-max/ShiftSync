/**
 * Reads the times printed in one roster cell (or one day's sub-cells joined in column order)
 * into shift segments. Shared by the table reader and the AI reader's cross-check, so a cell
 * means the same thing whichever reader saw it.
 *
 * Every pure-time cell is a list of times read left to right; consecutive pairs are segments:
 *   "9-17", "17:00-01:00", "4pm to 2am", "4 PM - 2 AM", "6.30pm-1am", "7a-3p", "12n-8p",
 *   "4pm-12m", "noon till midnight", "1830-0200"                         → one segment
 *   "11 17 18 25" (AM start, AM end, PM start, PM end), "10-14/18-23",
 *   "10am/3pm-7pm/12am" (bridged split), "10:30-4:00-8:00-12" (chained),
 *   "1000-1500 & 1900-2400"                                              → two segments
 * Times: 24h ("18:30", "1830"), dot separators ("18.30"), decimal hours ("18.5" = 18:30, "9.75" =
 * 09:45), hours past midnight ("25" = 01:00 next day), 12h with am/pm or a / p, noon ("12n") and
 * midnight ("12m"). A cell written on a 12-hour clock without am/pm reads forward in time
 * ("10:30-4:00-8:00-12" = 10:30-16:00 and 20:00-00:00), the way such rotas are meant. Anything
 * with other words in it is not a time cell.
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
   * How this roster writes dotted times (sheetDotStyle): on a clock ("18.30" = 18:30, and "18.3"
   * a clock time whose 0 a spreadsheet dropped), as decimal hours ("18.5" = 18:30, "18.25" =
   * 18:15), or both ("mixed": a ".5" / ".25" / ".50" could be either and is never guessed).
   * Unset: two-digit fractions other than .25/.50/.75/.00 are minutes, the rest decimal.
   */
  dotMeans?: 'minutes' | 'decimal' | 'mixed';
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

const TOKEN_RE = /(\d{1,2})(?:([:.])(\d{1,2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|a(?![a-z])|p(?![a-z]))?(?![\d])/gi;
/** What may sit between times: dashes, slashes, commas, '&', '~', and the words to / and / till / until / thru. */
const isSeparatorText = (s: string) => /^[\s\-–—/;,&+~]*$/.test(s.replace(/(?:\b|')(?:to|and|till|til|until|thru|through)\b/gi, ' '));

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (min: number) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

/** True when a dotted fraction is a typical decimal-hour fraction (.25, .5, .75). */
const decimalFraction = (frac: string) => ['25', '5', '50', '75', '0', '00'].includes(frac);
/** A dotted fraction that is a decimal hour on a decimal roster and a clock time on a clock roster. */
const eitherWay = (frac: string) => ['5', '25', '50'].includes(frac);

/**
 * The words and shapes people type for times, rewritten so one tokenizer reads them all:
 * noon / "12n" → 12pm, midnight / "12m" / "12mn" → 12am, four-digit 24h without a colon
 * ("1830", "0200", "2400") → "18:30", and a three-digit one beside it ("830-1700").
 */
function normalizeTimeText(raw: string): string {
  let text = raw
    .trim()
    .replace(/\bnoon\b|\b12\s*n\b/gi, '12pm')
    .replace(/\bmid-?night\b|\b12\s*m(?:n|id)?\b/gi, '12am');
  const four = /(?<![\d.:])([01]\d|2[0-4])([0-5]\d)(?![\d.:])/g;
  if (four.test(text)) {
    text = text.replace(four, '$1:$2').replace(/(?<![\d.:])([1-9])([0-5]\d)(?![\d.:])/g, '$1:$2');
  }
  return text;
}

/** Marks a cell whose dotted time can't be told apart on a roster that writes both ways. */
const AMBIGUOUS = Symbol('ambiguous');

function readTokens(text: string, opts: ShiftTextOptions): Token[] | null | typeof AMBIGUOUS {
  const tokens: Token[] = [];
  let rest = '';
  let last = 0;
  const dotted = [...text.matchAll(/\d{1,2}\.(\d{1,2})/g)].map((m) => m[1]!);
  const cellSaysMinutes = dotted.some((f) => f.length === 2 && !decimalFraction(f));
  let ambiguous = false;
  for (const m of text.matchAll(TOKEN_RE)) {
    rest += text.slice(last, m.index);
    last = m.index! + m[0].length;
    const hour = Number(m[1]);
    const sep = m[2];
    const frac = m[3];
    const mer = m[4] ? (m[4].toLowerCase().startsWith('a') ? 'am' : 'pm') : null;
    let minutes: number;
    let twentyFour = hour > 12 || (m[1]!.length === 2 && m[1]!.startsWith('0'));
    if (!sep) minutes = hour * 60;
    else if (sep === ':') {
      if (frac!.length !== 2 || Number(frac) > 59) return null;
      minutes = hour * 60 + Number(frac);
    } else {
      // Clock, decimal, or either: as the roster writes its dotted times (sheetDotStyle).
      let asMinutes: boolean;
      if (opts.dotMeans === 'mixed') {
        if (eitherWay(frac!)) ambiguous = true;
        asMinutes = frac !== '75' && !decimalFraction(frac!);
      } else if (opts.dotMeans === 'minutes') asMinutes = true;
      else if (opts.dotMeans === 'decimal') asMinutes = false;
      else asMinutes = frac!.length === 2 && (cellSaysMinutes || !decimalFraction(frac!));
      if (asMinutes) {
        // "18.3" on a clock roster is 18:30 with its 0 dropped (a spreadsheet number).
        const mm = frac!.length === 1 ? Number(frac) * 10 : Number(frac);
        if (mm > 59) return null;
        minutes = hour * 60 + mm;
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
  return ambiguous ? AMBIGUOUS : tokens;
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
 * note, a name) or its times don't pair up. `inferred` is true when am/pm had to be inferred, or
 * a dotted time that reads either way (".25", ".50") had no other cell of the roster to say how.
 */
export function parseShiftText(raw: string, opts: ShiftTextOptions = {}): { segments: ShiftSegment[]; inferred: boolean } | null {
  const text = normalizeTimeText(raw);
  if (!text || !/\d/.test(text)) return null;
  const tokens = readTokens(text, opts);
  if (!tokens || tokens === AMBIGUOUS || tokens.length < 2 || tokens.length % 2 !== 0 || tokens.length > 6) return null;
  const dotGuessed = !opts.dotMeans && /(?<![\d.])\d{1,2}\.(25|50)(?![\d.])/.test(text);
  const inferred = inferTwelveHour(tokens) || dotGuessed;
  const segments: ShiftSegment[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const s = tokens[i]!.minutes % 1440;
    const e = tokens[i + 1]!.minutes % 1440;
    if (s === e) return null;
    segments.push({ start: hhmm(s), end: hhmm(e), overnight: e <= s });
  }
  return { segments, inferred };
}

/**
 * True when a cell's segments follow one another within one day: each starts at or after the
 * last one ended, and the last ends within 24 hours of the first start ("10-15 / 18-23",
 * "18.30-01.00"). Times that overlap or run on past a day ("18:30-01:00 18:00-02:00") are two
 * days' cells run together, not one day.
 */
export function withinOneDay(segments: { start: string; end: string }[]): boolean {
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let first: number | null = null;
  let last = -1;
  for (const s of segments) {
    for (const t of [s.start, s.end]) {
      let m = minutes(t);
      // One segment may start where the last ended ("16-18, 18-26").
      while (m < last) m += 1440;
      first ??= m;
      last = m;
    }
  }
  return first === null || last - first <= 1440;
}

/**
 * True when a time cell holds a dotted time this roster writes both ways (".5", ".25", ".50" on
 * a roster with both "18.30" and "9.5"): it is shown to check, never read on a guess.
 */
export function ambiguousDottedTime(raw: string, opts: ShiftTextOptions = {}): boolean {
  if (opts.dotMeans !== 'mixed') return false;
  return readTokens(normalizeTimeText(raw), opts) === AMBIGUOUS;
}

/** One time on its own ("10", "4pm", "7a", "noon", "1830", "18.5") as HH:mm, or null. For open-ended cells ("10IN", "4CL"). */
export function parseSingleTime(raw: string, opts: ShiftTextOptions = {}): string | null {
  const tokens = readTokens(normalizeTimeText(raw), opts);
  if (!tokens || tokens === AMBIGUOUS || tokens.length !== 1) return null;
  return hhmm(tokens[0]!.minutes % 1440);
}

/**
 * How a whole roster writes dotted times, from the evidence in all its cells: on a clock when
 * some fraction can't be a decimal hour (".30", ".15", ".45", or ".3" — a clock time whose 0 a
 * spreadsheet dropped) and none is decimal (".5", ".75"); decimal hours in the reverse case;
 * "mixed" when it has both (the fractions that read either way — ".5", ".25", ".50" — are then
 * shown to check); unset when it has neither (".25" and ".50" alone fit either way).
 */
export function sheetDotStyle(cells: string[]): ShiftTextOptions['dotMeans'] {
  let clock = false;
  let decimal = false;
  for (const c of cells) {
    for (const m of c.matchAll(/(?<![\d.])\d{1,2}\.(\d{1,2})(?![\d.])/g)) {
      const f = m[1]!;
      // ".25" and ".50" fit either way and follow the rest of the roster.
      if (['0', '00', '25', '50'].includes(f)) continue;
      if (f === '5' || f === '75') decimal = true;
      else clock = true;
    }
  }
  if (clock && decimal) return 'mixed';
  if (clock) return 'minutes';
  if (decimal) return 'decimal';
  return undefined;
}
