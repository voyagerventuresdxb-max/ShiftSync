/**
 * Pure calendar math on YYYY-MM-DD strings. Nothing here converts between
 * timezones: a calendar day in, a calendar day (or a label for it) out, so the
 * device's zone can never shift a week or a label.
 */

/** The Monday (YYYY-MM-DD) of the week containing the given calendar day; the input itself when it is not a real date. */
export function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return iso;
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

/** The calendar day `deltaDays` after `iso`. */
export function addDays(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * "Mon 28 Sep – Sun 4 Oct 2026": the month is always shown and the year at
 * least once, so a week that crosses a month or a year reads unambiguously.
 * Assembled by hand (not one `toLocaleDateString` call) because ICU inserts a
 * comma after the weekday as soon as a year is requested.
 */
export function weekRangeLabel(firstIso: string, lastIso: string): string {
  const part = (iso: string, withYear: boolean) => {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y!, m! - 1, d!);
    const weekday = date.toLocaleDateString('en-GB', { weekday: 'short' });
    const month = date.toLocaleDateString('en-GB', { month: 'short' });
    return `${weekday} ${d} ${month}${withYear ? ` ${y}` : ''}`;
  };
  const sameYear = firstIso.slice(0, 4) === lastIso.slice(0, 4);
  return `${part(firstIso, !sameYear)} – ${part(lastIso, true)}`;
}
