/** The ISO date (YYYY-MM-DD) of the Monday of the week containing `now`. */
export function currentWeekStart(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEK_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Two-way sync between the viewed week (app state) and `?week=` in the URL,
 * as one decision per render. `lastSynced` is the week both sides last
 * agreed on, which is what tells the two directions apart:
 *  - the URL moved away from `lastSynced` (bookmark, shared link, back/
 *    forward) → adopt the URL's week into state;
 *  - otherwise state moved (Prev/Next week, template apply) or the URL is
 *    bare/stale → write state's week to the URL.
 * Without `lastSynced`, a Prev/Next click saw the not-yet-updated `?week=`
 * as "the URL differs from state" and snapped straight back (2026-09-25).
 */
export function reconcileWeekParam(
  param: string | null,
  weekStart: string,
  lastSynced: string | null,
): { adopt?: string; write?: string; lastSynced: string } {
  const validParam = param && WEEK_PARAM_RE.test(param) ? param : null;
  if (validParam && validParam !== lastSynced) {
    return validParam === weekStart ? { lastSynced: validParam } : { adopt: validParam, lastSynced: validParam };
  }
  return param === weekStart ? { lastSynced: weekStart } : { write: weekStart, lastSynced: weekStart };
}
