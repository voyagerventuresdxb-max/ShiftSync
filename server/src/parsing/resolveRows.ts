import type { PrismaClient } from '@prisma/client';
import { normalizeHeader } from './templates.js';
import type { ParsedShiftRow, PreviewRow, RowIssue, UploadPreviewSummary } from './types.js';

/** Case/whitespace-insensitive key for matching names against DB records. */
export function nameKey(value: string): string {
  return normalizeHeader(value);
}

/**
 * Canonical role aliases. The parser/VLM emits free-form role strings
 * ("Floor", "Supervisor", "Head Waiter", "Management / Floor", "SUPERVISORS")
 * that rarely match the exact Role.name seeded in the DB ("Floor Staff",
 * "Supervisor", "Head Waiter", "Management"). This map normalizes common
 * hospitality variants to the canonical role name so a valid staff member
 * isn't flagged "Unmatched role ⚠️" purely because of casing or a synonym.
 *
 * Keys are normalized (lowercase, alnum+space) via nameKey; values are the
 * canonical Role.name to look up. Lookup is case/whitespace-insensitive.
 */
const ROLE_ALIASES: Record<string, string> = {
  floor: 'Floor Staff',
  'floor staff': 'Floor Staff',
  'floor team': 'Floor Staff',
  'floor service': 'Floor Staff',
  'floor staff member': 'Floor Staff',
  // "Commis de rang"/"commis de salle" = the most junior member of a
  // French-service rang team (clearing, assisting) — general floor duty
  // rather than a specific waiter/runner specialization.
  'commis de rang': 'Floor Staff',
  'commis de salle': 'Floor Staff',
  waiter: 'Waiter',
  waiters: 'Waiter',
  'wait staff': 'Waiter',
  'waiting staff': 'Waiter',
  server: 'Waiter',
  servers: 'Waiter',
  // Classic French-service brigade: a "demi chef de rang" is the junior
  // half of a section-waiter pair, working under a chef de rang — same
  // seniority tier as a regular waiter, NOT the kitchen 'Chef' bucket.
  'demi chef de rang': 'Waiter',
  'demi chefs de rang': 'Waiter',
  'head waiter': 'Head Waiter',
  'head waiters': 'Head Waiter',
  'head server': 'Head Waiter',
  'senior waiter': 'Head Waiter',
  // "Chef de rang" = senior section waiter who owns a group of tables in
  // French service. Despite the word "Chef", this is a FOH floor role,
  // not kitchen staff — do not route into the 'Chef' bucket below.
  'chef de rang': 'Head Waiter',
  'chefs de rang': 'Head Waiter',
  // "Captain" is a common senior-waiter title on Dubai fine-dining floors.
  captain: 'Head Waiter',
  captains: 'Head Waiter',
  supervisor: 'Supervisor',
  supervisors: 'Supervisor',
  'floor supervisor': 'Supervisor',
  'shift supervisor': 'Supervisor',
  'team leader': 'Supervisor',
  'team lead': 'Supervisor',
  // "Sup" — real abbreviated per-row title, confirmed in this app's own
  // audit fixture (server/scripts/make-skewed-scan-fixture.ts), not
  // invented. Short enough that a bare match risks false positives on
  // unrelated short tokens elsewhere (e.g. a stray "sup" in free text),
  // but this column only ever holds a role/title label, never prose.
  sup: 'Supervisor',
  runner: 'Runner',
  runners: 'Runner',
  'food runner': 'Runner',
  'bar runner': 'Runner',
  // "Run" — same fixture as "Sup" above, same reasoning.
  run: 'Runner',
  bartender: 'Bartender',
  bartenders: 'Bartender',
  barista: 'Bartender',
  barback: 'Bartender',
  barbacks: 'Bartender',
  mixologist: 'Bartender',
  mixologists: 'Bartender',
  host: 'Host',
  hostess: 'Host',
  'host hostess': 'Host',
  // Guest Relations Officer/Associate — the guest-greeting/seating desk
  // role common at Dubai/GCC fine-dining and hotel outlets; functionally
  // closest to Host among existing buckets (see report re: judgment call).
  'guest relations officer': 'Host',
  'guest relations officers': 'Host',
  'guest relations': 'Host',
  // A one-grade-up GRO title seen at some hotel-affiliated outlets — same
  // function, so the same bucket.
  'guest relations manager': 'Host',
  'guest relations managers': 'Host',
  gro: 'Host',
  'guest relations associate': 'Host',
  'guest relations associates': 'Host',
  gra: 'Host',
  chef: 'Chef',
  cooks: 'Chef',
  cook: 'Chef',
  'kitchen staff': 'Chef',
  // "Commis chef"/"Commis de Cuisine" = junior/trainee kitchen chef — real,
  // distinct kitchen titles (unlike bare "commis", which is ambiguous
  // between kitchen and floor and is deliberately NOT added here — see
  // report).
  'commis chef': 'Chef',
  'commis chefs': 'Chef',
  'commis de cuisine': 'Chef',
  management: 'Management',
  'management floor': 'Management',
  'management / floor': 'Management',
  manager: 'Management',
  managers: 'Management',
  // "Mgr"/"Mgrs" — the universal English shorthand for manager/managers.
  mgr: 'Management',
  mgrs: 'Management',
  gm: 'Management',
  'general manager': 'Management',
  'restaurant manager': 'Management',
  // "RM" — real per-row title abbreviation, confirmed in the Bar des Pres
  // reference fixture (barDesPresReference.test.ts, transcribed from an
  // actual venue roster) — the same abbreviation pattern as the existing
  // "gm" entry above for "General Manager", here for the already-mapped
  // "restaurant manager" one line up.
  rm: 'Management',
  // Deliberately NOT added, despite also appearing as real per-row titles
  // in the same Bar des Pres reference fixture: "AM" and "JAM". "AM" is
  // already a heavily overloaded token elsewhere in this app's own domain
  // (the AM/PM shift-period marker — see DayColumn.period in
  // deterministicGridParser.ts) — even though it isn't read through this
  // same map today, a bare "am" alias here is a real future collision risk
  // for no confirmed gain. "JAM" has no confirmed expansion anywhere in
  // this codebase or its source material (plausibly "Junior Assistant
  // Manager" by hospitality convention, but that's a guess, not a
  // confirmed fact) — same "don't guess" principle already applied to bare
  // "commis" below. Both stay unresolved (flagged "Unmatched role" for
  // manual assignment) until a real venue confirms what they mean.
  'floor manager': 'Management',
  'duty manager': 'Management',
  'shift manager': 'Management',
  'operations manager': 'Management',
  'assistant manager': 'Management',
  // "Asst Mgr"/"Asst Manager" — common shorthand for the "assistant
  // manager" entry above.
  'asst mgr': 'Management',
  'asst manager': 'Management',
  'assistant gm': 'Management',
  'head of floor': 'Management',
  'floor management': 'Management',
  // Maître d'Hôtel / Chef de Salle — the senior FOH authority in French
  // service, above chef de rang and reporting to the F&B/restaurant
  // manager. Grouped with 'Management' to match this table's existing
  // "head of floor" / "floor management" entries rather than Supervisor.
  // NOTE: nameKey/normalizeHeader preserves each accented char as its own
  // Unicode letter (via \p{L}) rather than folding it to plain ASCII (an
  // accent-folding attempt was tried and reverted — see templates.ts's own
  // comment — because it broke Vietnamese name matching), so a literal
  // "Maître d'Hôtel" normalizes to "maître d hôtel" — a DIFFERENT key from
  // this ASCII one — and will NOT match this key. Only the plain-ASCII
  // spellings real Dubai rosters actually use ("Maitre D", "Maitre
  // D'Hotel") match here.
  'maitre d': 'Management',
  'maitre d hotel': 'Management',
  'chef de salle': 'Management',
  'outlet manager': 'Management',
  'outlet managers': 'Management',
  // F&B / Food & Beverage Manager — the spelled-out, "&"-punctuated, AND
  // no-space "FB" forms are each their own distinct normalized key
  // ("F&B" -> "f b" [two tokens], "FB" -> "fb" [one token] — normalization
  // only collapses punctuation to a space, it doesn't merge/split letter
  // runs), plus the plural of each, since a section header grouping
  // several people under one manager title ("Food & Beverage Managers") is
  // a realistic sheet shape distinct from an individual's own title.
  'f b manager': 'Management',
  'f b managers': 'Management',
  'fb manager': 'Management',
  'fb managers': 'Management',
  'fnb manager': 'Management',
  'fnb managers': 'Management',
  'food and beverage manager': 'Management',
  'food and beverage managers': 'Management',
  'food beverage manager': 'Management',
  'food beverage managers': 'Management',
  staff: 'Staff',
  'general staff': 'Staff',
};

/**
 * Resolves a raw role string to its canonical Role.name, if a known alias
 * exists. Returns the canonical name, or the original string when no alias
 * matches (so the exact DB lookup still gets a chance).
 */
export function canonicalRoleName(raw: string): string {
  const key = nameKey(raw);
  // Plain bracket access (`ROLE_ALIASES[key]`) also resolves inherited
  // Object.prototype properties — a role/section label that normalizes to
  // "constructor" would otherwise silently return the real Object
  // constructor FUNCTION (truthy, so `?? raw` never kicks in) instead of
  // falling through to the raw string, corrupting anything downstream that
  // expects a string (e.g. a ParsedShiftRow.roleName). hasOwnProperty guards
  // against that same class of collision templates.ts's normalizeHeader fix
  // targets for name keys.
  return Object.prototype.hasOwnProperty.call(ROLE_ALIASES, key) ? ROLE_ALIASES[key] : raw;
}

/**
 * Whether `raw` matches a known role alias (including a canonical name
 * typed as-is, e.g. "Waiter" — the canonical spellings are their own keys
 * in ROLE_ALIASES). Used to disambiguate which of two candidate columns on
 * a grid-format sheet holds role labels vs. staff names by content rather
 * than position — see deterministicGridParser.ts.
 */
export function isRecognizedRoleAlias(raw: string): boolean {
  // `in` also matches inherited Object.prototype property names (see
  // canonicalRoleName above) — a cell reading "constructor" or "toString"
  // would otherwise be misreported as a recognized role alias.
  return Object.prototype.hasOwnProperty.call(ROLE_ALIASES, nameKey(raw));
}

/**
 * Resolves parsed rows against a Location's existing Role and User records.
 * - Missing Role => blocking error (Shift.roleId is a required FK).
 * - Missing/unmatched employee => non-blocking warning; shift is created
 *   unassigned (Shift.userId is nullable) so managers can review/assign it.
 */
export async function resolveRowsAgainstDatabase(
  prisma: PrismaClient,
  locationId: string,
  rows: ParsedShiftRow[],
): Promise<{ previewRows: PreviewRow[]; summary: UploadPreviewSummary }> {
  const [roles, users] = await Promise.all([
    prisma.role.findMany({ where: { locationId, isActive: true } }),
    prisma.user.findMany({ where: { locationId, isActive: true } }),
  ]);

  const roleByName = new Map(roles.map((r) => [nameKey(r.name), r.id]));
  const userByName = new Map(users.map((u) => [nameKey(u.fullName), u.id]));
  const userByNameFull = new Map(users.map((u) => [nameKey(u.fullName), u]));

  const previewRows: PreviewRow[] = rows.map((row) => {
    const issues: RowIssue[] = [];
    // Resolve the role via a RAW exact match against this venue's own seeded
    // Role.name FIRST, falling back to the canonical alias map only when the
    // raw string isn't itself a real role here. This ordering matters: a
    // venue can seed a Role whose name happens to equal one of ROLE_ALIASES'
    // own keys (a real, distinct "GRO"/"Captain"/"Outlet Manager" role,
    // deliberately different from that generic bucket's "Host"/"Head
    // Waiter"/"Management") — trying the alias-canonicalized name first
    // would silently redirect every such row to the wrong, generic role
    // with `status: 'matched'` and no warning surfaced at all, overriding a
    // previously-correct exact match. Checking the raw string first doesn't
    // weaken the intended synonym-matching case: a roster saying "Server"
    // for a venue that seeded "Waiter" (not "Server") still falls through
    // to the alias lookup exactly as before, since no venue seeds a role
    // literally named after its own synonym.
    const canonicalRole = canonicalRoleName(row.roleName);
    const resolvedUserId = userByName.get(nameKey(row.employeeName)) ?? null;
    const matchedUser = userByNameFull.get(nameKey(row.employeeName));

    // The file provided no role at all (as opposed to one we simply don't
    // recognize) for a staff member who already exists with a role on file
    // — fall back to their existing role rather than blocking the import.
    // Deliberately narrow: a non-blank-but-unresolved role (typo, a role
    // the venue hasn't set up yet) is NEVER affected by this fallback and
    // still blocks exactly as before, since it only triggers when the raw
    // roleName is empty.
    const usedExistingRoleFallback = !row.roleName.trim() && !!matchedUser?.roleId;
    const resolvedRoleId =
      roleByName.get(nameKey(row.roleName)) ??
      roleByName.get(nameKey(canonicalRole)) ??
      (usedExistingRoleFallback ? matchedUser!.roleId : null);

    if (usedExistingRoleFallback) {
      issues.push({
        rowNumber: row.rowNumber,
        field: 'role',
        severity: 'info',
        message: `Role for "${row.employeeName}" was not specified in the file — inferred from their existing staff record.`,
      });
    }

    if (!resolvedRoleId) {
      issues.push({
        rowNumber: row.rowNumber,
        field: 'role',
        severity: 'error',
        message: row.roleName.trim()
          ? `Role "${row.roleName}" does not exist for this location. Add it first, or fix the spelling in the sheet.`
          : 'No role could be identified for this shift. Assign one manually before importing.',
      });
    }
    if (!resolvedUserId) {
      issues.push({
        rowNumber: row.rowNumber,
        field: 'employeeName',
        severity: 'warning',
        message: `No active employee named "${row.employeeName}" found. This shift will be imported as unassigned.`,
      });
    }

    const status: PreviewRow['status'] = !resolvedRoleId
      ? 'unmatched_role'
      : !resolvedUserId
        ? 'new_employee'
        : 'matched';

    return { ...row, status, resolvedRoleId, resolvedUserId, issues };
  });

  const summary: UploadPreviewSummary = {
    totalRows: previewRows.length,
    matchedRows: previewRows.filter((r) => r.status === 'matched').length,
    newEmployeeRows: previewRows.filter((r) => r.status === 'new_employee').length,
    unmatchedRoleRows: previewRows.filter((r) => r.status === 'unmatched_role').length,
    errorRows: previewRows.filter((r) => r.status === 'error').length,
  };

  return { previewRows, summary };
}
