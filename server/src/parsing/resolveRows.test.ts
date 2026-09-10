import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { resolveRowsAgainstDatabase, canonicalRoleName, isRecognizedRoleAlias, nameKey } from './resolveRows.js';
import type { ParsedShiftRow } from './types.js';

interface FakeRole {
  id: string;
  name: string;
}

interface FakeUser {
  id: string;
  fullName: string;
  roleId: string | null;
}

function fakePrisma(roles: FakeRole[], users: FakeUser[]): PrismaClient {
  return {
    role: { findMany: async () => roles },
    user: { findMany: async () => users },
  } as unknown as PrismaClient;
}

function row(overrides: Partial<ParsedShiftRow>): ParsedShiftRow {
  return {
    rowNumber: 1,
    employeeName: 'Andrea',
    roleName: '',
    date: '2026-08-17',
    startTime: '09:00',
    endTime: '17:00',
    overnight: false,
    breakMinutes: 0,
    managerNotes: null,
    ...overrides,
  };
}

test('falls back to an existing employee\'s own role when the file specifies no role at all', async () => {
  const roles = [{ id: 'role-mgmt', name: 'Management' }];
  const users = [{ id: 'user-andrea', fullName: 'Andrea', roleId: 'role-mgmt' }];
  const { previewRows } = await resolveRowsAgainstDatabase(fakePrisma(roles, users), 'loc-1', [
    row({ employeeName: 'Andrea', roleName: '' }),
  ]);

  assert.equal(previewRows[0].status, 'matched');
  assert.equal(previewRows[0].resolvedRoleId, 'role-mgmt');
  assert.equal(previewRows[0].resolvedUserId, 'user-andrea');
  const infoIssue = previewRows[0].issues.find((i) => i.severity === 'info');
  assert.ok(infoIssue, 'expected an informational issue noting the inferred role');
  assert.match(infoIssue!.message, /inferred from their existing staff record/i);
});

test('does NOT apply the fallback when the file specifies a role that simply fails to resolve (typo/unknown role) — stays blocked', async () => {
  const roles = [{ id: 'role-mgmt', name: 'Management' }];
  const users = [{ id: 'user-andrea', fullName: 'Andrea', roleId: 'role-mgmt' }];
  const { previewRows } = await resolveRowsAgainstDatabase(fakePrisma(roles, users), 'loc-1', [
    row({ employeeName: 'Andrea', roleName: 'Bartander' }), // typo, not blank
  ]);

  assert.equal(previewRows[0].status, 'unmatched_role');
  assert.equal(previewRows[0].resolvedRoleId, null);
  assert.equal(
    previewRows[0].issues.some((i) => i.severity === 'info'),
    false,
    'the fallback must not fire for a non-blank unresolved role',
  );
  const errorIssue = previewRows[0].issues.find((i) => i.severity === 'error');
  assert.ok(errorIssue);
  assert.match(errorIssue!.message, /does not exist for this location/i);
});

test('does NOT apply the fallback when the employee has no existing role on file either — stays blocked', async () => {
  const roles = [{ id: 'role-mgmt', name: 'Management' }];
  const users = [{ id: 'user-andrea', fullName: 'Andrea', roleId: null }];
  const { previewRows } = await resolveRowsAgainstDatabase(fakePrisma(roles, users), 'loc-1', [
    row({ employeeName: 'Andrea', roleName: '' }),
  ]);

  assert.equal(previewRows[0].status, 'unmatched_role');
  assert.equal(previewRows[0].resolvedRoleId, null);
});

test('does NOT apply the fallback for a genuinely unknown employee name (new_employee territory)', async () => {
  const roles = [{ id: 'role-mgmt', name: 'Management' }];
  const users: FakeUser[] = [];
  const { previewRows } = await resolveRowsAgainstDatabase(fakePrisma(roles, users), 'loc-1', [
    row({ employeeName: 'Someone New', roleName: '' }),
  ]);

  assert.equal(previewRows[0].status, 'unmatched_role');
  assert.equal(previewRows[0].resolvedRoleId, null);
  assert.equal(previewRows[0].resolvedUserId, null);
});

test('a normally-resolved role (present in the file) is unaffected by the fallback path', async () => {
  const roles = [{ id: 'role-waiter', name: 'Waiter' }];
  const users = [{ id: 'user-jose', fullName: 'Jose', roleId: null }];
  const { previewRows } = await resolveRowsAgainstDatabase(fakePrisma(roles, users), 'loc-1', [
    row({ employeeName: 'Jose', roleName: 'Waiter' }),
  ]);

  assert.equal(previewRows[0].status, 'matched');
  assert.equal(previewRows[0].resolvedRoleId, 'role-waiter');
  assert.equal(
    previewRows[0].issues.some((i) => i.severity === 'info'),
    false,
  );
});

// --- Dubai/GCC luxury-hospitality & French-service ROLE_ALIASES additions ---
// Each new alias below is checked both for canonicalRoleName's mapping and
// for isRecognizedRoleAlias (the latter is what deterministicGridParser.ts
// actually uses to disambiguate role-label columns from name columns).

test('French-service "chef de rang" (senior section waiter) resolves to Head Waiter, NOT Chef', () => {
  assert.equal(canonicalRoleName('Chef de Rang'), 'Head Waiter');
  assert.equal(canonicalRoleName('chefs de rang'), 'Head Waiter');
  assert.ok(isRecognizedRoleAlias('CHEF DE RANG'), 'case-insensitive match expected');
});

test('French-service "demi chef de rang" (junior section waiter) resolves to Waiter, NOT Chef', () => {
  assert.equal(canonicalRoleName('Demi Chef de Rang'), 'Waiter');
  assert.equal(canonicalRoleName('demi chefs de rang'), 'Waiter');
  assert.ok(isRecognizedRoleAlias('Demi Chef De Rang'));
});

test('"Captain" (common Dubai fine-dining senior-waiter title) resolves to Head Waiter', () => {
  assert.equal(canonicalRoleName('Captain'), 'Head Waiter');
  assert.equal(canonicalRoleName('captains'), 'Head Waiter');
});

test('"Commis de Rang"/"Commis de Salle" (junior floor trainee) resolve to Floor Staff', () => {
  assert.equal(canonicalRoleName('Commis de Rang'), 'Floor Staff');
  assert.equal(canonicalRoleName('Commis de Salle'), 'Floor Staff');
});

test('"Commis Chef" (junior kitchen chef) resolves to Chef; bare "Commis" is deliberately NOT recognized (ambiguous kitchen/floor)', () => {
  assert.equal(canonicalRoleName('Commis Chef'), 'Chef');
  assert.equal(canonicalRoleName('commis chefs'), 'Chef');
  assert.equal(isRecognizedRoleAlias('Commis'), false);
});

test('"Barback" and "Mixologist" resolve to Bartender', () => {
  assert.equal(canonicalRoleName('Barback'), 'Bartender');
  assert.equal(canonicalRoleName('barbacks'), 'Bartender');
  assert.equal(canonicalRoleName('Mixologist'), 'Bartender');
  assert.equal(canonicalRoleName('mixologists'), 'Bartender');
});

test('Guest Relations Officer/Associate and GRO/GRA abbreviations resolve to Host', () => {
  assert.equal(canonicalRoleName('Guest Relations Officer'), 'Host');
  assert.equal(canonicalRoleName('Guest Relations'), 'Host');
  assert.equal(canonicalRoleName('GRO'), 'Host');
  assert.equal(canonicalRoleName('Guest Relations Associate'), 'Host');
  assert.equal(canonicalRoleName('GRA'), 'Host');
});

test('Maitre D / Maitre D\'Hotel and Chef de Salle (senior FOH authority) resolve to Management', () => {
  assert.equal(canonicalRoleName('Maitre D'), 'Management');
  assert.equal(canonicalRoleName("Maitre D'Hotel"), 'Management');
  assert.equal(canonicalRoleName('Chef de Salle'), 'Management');
});

// 2026-09-05 — a review caught a real gap in the Unicode widening above:
// `\p{L}` alone doesn't cover combining marks, so Arabic diacritics
// (tashkeel) get replaced with a SPACE by the letter/number filter,
// splitting one word into isolated letters ("مُحَمَّد" -> "م ح م د") —
// the SAME name spelled with vs. without diacritics produces DIFFERENT
// keys. An `.normalize('NFKD') + strip \p{M}` fix was tried and reverted:
// it does fold Arabic diacritics correctly, but it also collapses two
// DIFFERENT Vietnamese names to the same key ("Nguyễn"/"Nguyên" both ->
// "nguyen", verified empirically) — reintroducing the exact
// silent-collision bug this function exists to prevent, for a different
// script. This is documented, accepted behavior, not an oversight: a
// same-name diacritic mismatch fails SAFE (unmatched/new_employee, a
// visible prompt for manual review), which is the correct tradeoff
// against silently mismatching two different Vietnamese employees.
test('nameKey: a name WITH Arabic diacritics (tashkeel) and the same name WITHOUT them currently produce DIFFERENT keys — documented, safe-failure-mode limitation, not a collision', () => {
  assert.notEqual(nameKey('مُحَمَّد'), nameKey('محمد'), 'diacritic-marked and plain spellings do not currently match (fails safe, not a bug)');
  assert.notEqual(nameKey('مُحَمَّد'), '', 'must still not collapse to empty — that was the original collision bug, and stays fixed');
});

test('accent-folding ("Maître d\'Hôtel" -> the plain-ASCII "maitre d hotel" key) was deliberately NOT implemented — would break Vietnamese name matching', () => {
  // Both forms are real, valid, and distinct keys today; only the
  // plain-ASCII spelling matches the seeded alias.
  assert.notEqual(canonicalRoleName("Maître d'Hôtel"), 'Management');
  assert.equal(canonicalRoleName("Maitre D'Hotel"), 'Management');
});

test('Outlet Manager resolves to Management', () => {
  assert.equal(canonicalRoleName('Outlet Manager'), 'Management');
  assert.equal(canonicalRoleName('outlet managers'), 'Management');
});

test('F&B / FnB / FB / Food and Beverage Manager variants (singular and plural) all resolve to Management', () => {
  assert.equal(canonicalRoleName('F&B Manager'), 'Management');
  assert.equal(canonicalRoleName('F & B Manager'), 'Management');
  assert.equal(canonicalRoleName('FB Manager'), 'Management'); // no-space form: normalizes to a single "fb" token, distinct from "F&B"'s two-token "f b"
  assert.equal(canonicalRoleName('FnB Manager'), 'Management');
  assert.equal(canonicalRoleName('Food and Beverage Manager'), 'Management');
  assert.equal(canonicalRoleName('Food & Beverage Manager'), 'Management');
  assert.equal(canonicalRoleName('Food & Beverage Managers'), 'Management'); // plural: a section header grouping several people
  assert.equal(canonicalRoleName('FB Managers'), 'Management');
});

test('Guest Relations Manager (one grade up from GRO) resolves to Host', () => {
  assert.equal(canonicalRoleName('Guest Relations Manager'), 'Host');
  assert.equal(canonicalRoleName('Guest Relations Managers'), 'Host');
});

test('Commis de Cuisine (standard French-kitchen junior title) resolves to Chef, parallel to Commis Chef', () => {
  assert.equal(canonicalRoleName('Commis de Cuisine'), 'Chef');
});

// 2026-09-05 — a whole-branch review caught a real bug the alias expansion
// above exposed: resolveRowsAgainstDatabase tried the alias-canonicalized
// name BEFORE the raw exact match, so a venue that seeds its own Role whose
// name happens to equal one of ROLE_ALIASES' keys (a real, distinct "GRO"
// role, deliberately different from the generic "Host" bucket "GRO" maps
// to) had every such row silently redirected to the wrong role, matched
// with no warning at all. Fixed by trying the raw exact match first.
test('a venue-specific Role whose name coincidentally matches a ROLE_ALIASES key resolves to ITS OWN role, not the generic alias bucket', async () => {
  const roles = [
    { id: 'role-gro', name: 'GRO' },
    { id: 'role-host', name: 'Host' },
  ];
  const users = [{ id: 'user-fatima', fullName: 'Fatima', roleId: null }];
  const { previewRows } = await resolveRowsAgainstDatabase(fakePrisma(roles, users), 'loc-1', [
    row({ employeeName: 'Fatima', roleName: 'GRO' }),
  ]);

  assert.equal(previewRows[0].status, 'matched');
  assert.equal(previewRows[0].resolvedRoleId, 'role-gro', 'must resolve to the venue\'s own distinct "GRO" role, not "Host"');
});

test('the alias fallback still applies when the venue has NOT seeded a role matching the raw string', async () => {
  // Same scenario, but this venue never created a "GRO" role of its own —
  // the alias-canonicalized fallback to "Host" must still fire.
  const roles = [{ id: 'role-host', name: 'Host' }];
  const users = [{ id: 'user-fatima', fullName: 'Fatima', roleId: null }];
  const { previewRows } = await resolveRowsAgainstDatabase(fakePrisma(roles, users), 'loc-1', [
    row({ employeeName: 'Fatima', roleName: 'GRO' }),
  ]);

  assert.equal(previewRows[0].status, 'matched');
  assert.equal(previewRows[0].resolvedRoleId, 'role-host');
});

// --- ROSTER-PARSING GAP: non-Latin (Arabic) name/role collision fix ---
// normalizeHeader (aliased here as nameKey) used to strip every
// non-ASCII-Latin character to nothing, so two DIFFERENT Arabic names (or
// role labels) both collapsed to the SAME empty/whitespace key — a real
// collision that could silently resolve one person's roster row to a
// DIFFERENT person's DB record with status 'matched' and no warning. Fixed
// by widening normalizeHeader's regex to a Unicode-aware `\p{L}`/`\p{N}`
// class (see templates.ts) so any script's actual letters are preserved
// instead of stripped, producing distinct keys for distinct names.

test('nameKey: two different Arabic full names produce distinct, non-empty keys (no more collision to "")', () => {
  const a = nameKey('محمد أحمد');
  const b = nameKey('فاطمة علي');

  assert.notEqual(a, '', 'Arabic name must not normalize to an empty key');
  assert.notEqual(b, '', 'Arabic name must not normalize to an empty key');
  assert.notEqual(a, b, 'two different Arabic names must not collide on the same key');
});

// 2026-09-05 — found while writing a regression test for a related legend-
// code bug in deterministicGridParser.ts: `ROLE_ALIASES[key] ?? raw` and
// `nameKey(raw) in ROLE_ALIASES` both use plain-object property access,
// which also resolves inherited Object.prototype properties. A role/section
// label that normalizes to "constructor" (or "toString", "hasOwnProperty",
// etc.) used to make canonicalRoleName silently return the real Object
// constructor FUNCTION instead of falling through to the raw string
// (truthy, so `?? raw` never fired), and isRecognizedRoleAlias would
// incorrectly report it as a known role. Fixed via hasOwnProperty.
test('canonicalRoleName/isRecognizedRoleAlias do not resolve inherited Object.prototype property names', () => {
  assert.equal(canonicalRoleName('constructor'), 'constructor', 'must fall through to the raw string, not the real Object constructor function');
  assert.equal(canonicalRoleName('toString'), 'toString');
  assert.equal(canonicalRoleName('hasOwnProperty'), 'hasOwnProperty');
  assert.equal(isRecognizedRoleAlias('constructor'), false);
  assert.equal(isRecognizedRoleAlias('toString'), false);
  assert.equal(isRecognizedRoleAlias('hasOwnProperty'), false);
});

test('nameKey: plain English/French-service names and headers are unaffected by the Unicode widening', () => {
  // \p{L}/\p{N} is a superset of a-z/0-9, so already-ASCII input must
  // normalize identically to before.
  assert.equal(nameKey('Andrea'), 'andrea');
  assert.equal(nameKey('Employee Name'), 'employee name');
  assert.equal(nameKey('Chef de Rang'), 'chef de rang');
});

test('two different Arabic-named employees resolve to their OWN distinct user record, not to each other or a random match', async () => {
  const roles = [{ id: 'role-waiter', name: 'Waiter' }];
  const users = [
    { id: 'user-mohammed', fullName: 'محمد أحمد', roleId: 'role-waiter' },
    { id: 'user-fatima', fullName: 'فاطمة علي', roleId: 'role-waiter' },
  ];
  const { previewRows } = await resolveRowsAgainstDatabase(fakePrisma(roles, users), 'loc-1', [
    row({ rowNumber: 1, employeeName: 'محمد أحمد', roleName: 'Waiter' }),
    row({ rowNumber: 2, employeeName: 'فاطمة علي', roleName: 'Waiter' }),
  ]);

  assert.equal(previewRows[0].status, 'matched');
  assert.equal(previewRows[0].resolvedUserId, 'user-mohammed');
  assert.equal(previewRows[1].status, 'matched');
  assert.equal(previewRows[1].resolvedUserId, 'user-fatima');
  assert.notEqual(
    previewRows[0].resolvedUserId,
    previewRows[1].resolvedUserId,
    'two different Arabic-named employees must never resolve to the same user',
  );
});

test('an Arabic role label distinguishes correctly from a different Arabic role label seeded for the same location', async () => {
  const roles = [
    { id: 'role-a', name: 'نادل' }, // "waiter"
    { id: 'role-b', name: 'مدير' }, // "manager"
  ];
  const users = [{ id: 'user-1', fullName: 'Sample User', roleId: null }];
  const { previewRows } = await resolveRowsAgainstDatabase(fakePrisma(roles, users), 'loc-1', [
    row({ rowNumber: 1, employeeName: 'Sample User', roleName: 'نادل' }),
  ]);

  assert.equal(previewRows[0].resolvedRoleId, 'role-a', 'must resolve to the matching Arabic role, not the other one');
});
