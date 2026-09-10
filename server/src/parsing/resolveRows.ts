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
  waiter: 'Waiter',
  waiters: 'Waiter',
  'wait staff': 'Waiter',
  'waiting staff': 'Waiter',
  server: 'Waiter',
  servers: 'Waiter',
  'head waiter': 'Head Waiter',
  'head waiters': 'Head Waiter',
  'head server': 'Head Waiter',
  'senior waiter': 'Head Waiter',
  supervisor: 'Supervisor',
  supervisors: 'Supervisor',
  'floor supervisor': 'Supervisor',
  'shift supervisor': 'Supervisor',
  'team leader': 'Supervisor',
  'team lead': 'Supervisor',
  runner: 'Runner',
  runners: 'Runner',
  'food runner': 'Runner',
  'bar runner': 'Runner',
  bartender: 'Bartender',
  bartenders: 'Bartender',
  barista: 'Bartender',
  host: 'Host',
  hostess: 'Host',
  'host hostess': 'Host',
  chef: 'Chef',
  cooks: 'Chef',
  cook: 'Chef',
  'kitchen staff': 'Chef',
  management: 'Management',
  'management floor': 'Management',
  'management / floor': 'Management',
  manager: 'Management',
  managers: 'Management',
  gm: 'Management',
  'general manager': 'Management',
  'restaurant manager': 'Management',
  'floor manager': 'Management',
  'duty manager': 'Management',
  'shift manager': 'Management',
  'operations manager': 'Management',
  'assistant manager': 'Management',
  'assistant gm': 'Management',
  'head of floor': 'Management',
  'floor management': 'Management',
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
  return ROLE_ALIASES[key] ?? raw;
}

/**
 * Whether `raw` matches a known role alias (including a canonical name
 * typed as-is, e.g. "Waiter" — the canonical spellings are their own keys
 * in ROLE_ALIASES). Used to disambiguate which of two candidate columns on
 * a grid-format sheet holds role labels vs. staff names by content rather
 * than position — see deterministicGridParser.ts.
 */
export function isRecognizedRoleAlias(raw: string): boolean {
  return nameKey(raw) in ROLE_ALIASES;
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
    // Resolve the role through the canonical alias map first, then fall back
    // to the raw string — so "Floor", "Supervisor", "Head Waiter" etc. map to
    // the seeded Role.name regardless of casing or synonym.
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
      roleByName.get(nameKey(canonicalRole)) ??
      roleByName.get(nameKey(row.roleName)) ??
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
