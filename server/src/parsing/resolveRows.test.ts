import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { resolveRowsAgainstDatabase, canonicalRoleName, isRecognizedRoleAlias } from './resolveRows.js';
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

test('Outlet Manager resolves to Management', () => {
  assert.equal(canonicalRoleName('Outlet Manager'), 'Management');
  assert.equal(canonicalRoleName('outlet managers'), 'Management');
});

test('F&B / FnB / Food and Beverage Manager variants all resolve to Management', () => {
  assert.equal(canonicalRoleName('F&B Manager'), 'Management');
  assert.equal(canonicalRoleName('F & B Manager'), 'Management');
  assert.equal(canonicalRoleName('FnB Manager'), 'Management');
  assert.equal(canonicalRoleName('Food and Beverage Manager'), 'Management');
  assert.equal(canonicalRoleName('Food & Beverage Manager'), 'Management');
});
