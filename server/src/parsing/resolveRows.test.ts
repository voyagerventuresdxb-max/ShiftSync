import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { resolveRowsAgainstDatabase } from './resolveRows.js';
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
