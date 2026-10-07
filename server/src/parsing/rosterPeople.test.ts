import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { resolveRowsAgainstDatabase, nameCloseness, personNameKey, isRecognizedRoleAlias } from './resolveRows.js';
import type { ParsedShiftRow } from './types.js';
import type { RowReadingInfo } from './rosterContract.js';

/**
 * People on the review screen (2026-10 roster review rework): one PersonPreview per person,
 * matched against the venue's staff. Exact names match; close names are only suggestions;
 * the same name twice is flagged, never merged; an unresolved role never blocks. Made-up
 * names only.
 */

interface FakeUser {
  id: string;
  fullName: string;
  roleId: string | null;
}

function fakePrisma(
  roles: { id: string; name: string }[],
  users: FakeUser[],
  aliases: { roleAliases?: { normalizedLabel: string; roleId: string }[]; nameAliases?: { normalizedName: string; userId: string }[] } = {},
): PrismaClient {
  return {
    role: { findMany: async () => roles },
    user: { findMany: async () => users },
    rosterRoleAlias: { findMany: async () => aliases.roleAliases ?? [] },
    rosterNameAlias: { findMany: async () => aliases.nameAliases ?? [] },
  } as unknown as PrismaClient;
}

function row(overrides: Partial<ParsedShiftRow & RowReadingInfo>): ParsedShiftRow {
  return {
    rowNumber: 1,
    employeeName: 'Ava Thornton',
    roleName: '',
    date: '2031-03-03',
    startTime: '09:00',
    endTime: '17:00',
    overnight: false,
    breakMinutes: 0,
    managerNotes: null,
    ...overrides,
  };
}

test('one entry per PERSON, not per row: summary.people counts people while the row counts stay', async () => {
  const roles = [{ id: 'role-waiter', name: 'Waiter' }];
  const { people, summary } = await resolveRowsAgainstDatabase(fakePrisma(roles, []), 'loc-1', [
    row({ rowNumber: 1, sourceRowIndex: 4, employeeName: 'Ava Thornton', roleName: 'Waiter', date: '2031-03-03' }),
    row({ rowNumber: 2, sourceRowIndex: 4, employeeName: 'Ava Thornton', roleName: 'Waiter', date: '2031-03-04' }),
    row({ rowNumber: 3, sourceRowIndex: 5, employeeName: 'Ben Okafor', roleName: 'Waiter', date: '2031-03-03' }),
  ]);
  assert.equal(people.length, 2);
  assert.equal(summary.people.total, 2);
  assert.equal(summary.people.new, 2);
  assert.equal(summary.newEmployeeRows, 3, 'the old row count is kept for older clients');
  const ava = people.find((p) => p.name === 'Ava Thornton')!;
  assert.equal(ava.shiftCount, 2);
  assert.deepEqual(ava.rowNumbers, [1, 2]);
  assert.equal(ava.resolvedRoleId, 'role-waiter');
  assert.equal(ava.suggestedAction, 'create');
});

test('readPeople adds a person with no shifts that week', async () => {
  const { people } = await resolveRowsAgainstDatabase(fakePrisma([], []), 'loc-1', [row({ rowNumber: 1, employeeName: 'Ava Thornton', personKey: 'p1' })], {
    readPeople: [
      { personKey: 'p1', name: 'Ava Thornton', roleLabel: null, section: null, sourcePage: null, sourceRow: 3, readerSource: 'both' },
      { personKey: 'p2', name: 'Cleo Varga', roleLabel: 'Host', section: 'HOSTS', sourcePage: null, sourceRow: 4, readerSource: 'table' },
    ],
  });
  assert.deepEqual(
    people.map((p) => [p.name, p.shiftCount]),
    [
      ['Ava Thornton', 1],
      ['Cleo Varga', 0],
    ],
  );
  assert.ok(people[1]!.flags.some((f) => f.kind === 'table_only'));
  assert.equal(people[1]!.section, 'HOSTS');
});

test('an exact name match (accents in either Unicode form) is matched; a remembered link is matched', async () => {
  const users = [
    { id: 'u-jose', fullName: 'José Ramos', roleId: null },
    { id: 'u-bash', fullName: 'Bastian Rao', roleId: null },
  ];
  const { people, previewRows } = await resolveRowsAgainstDatabase(fakePrisma([], users, { nameAliases: [{ normalizedName: 'bast', userId: 'u-bash' }] }), 'loc-1', [
    row({ rowNumber: 1, sourceRowIndex: 1, employeeName: 'José Ramos' }),
    row({ rowNumber: 2, sourceRowIndex: 2, employeeName: 'Bast' }),
  ]);
  assert.equal(people[0]!.status, 'matched');
  assert.equal(people[0]!.matchedUserId, 'u-jose');
  assert.equal(people[1]!.status, 'matched');
  assert.equal(people[1]!.matchedUserId, 'u-bash');
  assert.equal(previewRows[1]!.resolvedUserId, 'u-bash');
});

test('close names are only ever suggestions (needs_decision + possible_match), never matched', async () => {
  const users = [
    { id: 'u-bash', fullName: 'Bastian Rao', roleId: null },
    { id: 'u-maria', fullName: 'Maria Lopez', roleId: null },
    { id: 'u-jose', fullName: 'José Ramos', roleId: null },
    { id: 'u-john', fullName: 'John Smith', roleId: null },
  ];
  const { people, previewRows } = await resolveRowsAgainstDatabase(fakePrisma([], users), 'loc-1', [
    row({ rowNumber: 1, sourceRowIndex: 1, employeeName: 'Bast' }),
    row({ rowNumber: 2, sourceRowIndex: 2, employeeName: 'Maria L.' }),
    row({ rowNumber: 3, sourceRowIndex: 3, employeeName: 'Jose Ramos' }),
    row({ rowNumber: 4, sourceRowIndex: 4, employeeName: 'Jon Smith' }),
    row({ rowNumber: 5, sourceRowIndex: 5, employeeName: 'Maria' }),
  ]);
  const byName = new Map(people.map((p) => [p.name, p]));
  for (const [name, userId] of [
    ['Bast', 'u-bash'],
    ['Maria L.', 'u-maria'],
    ['Jose Ramos', 'u-jose'],
    ['Jon Smith', 'u-john'],
    ['Maria', 'u-maria'],
  ] as const) {
    const person = byName.get(name)!;
    assert.equal(person.status, 'needs_decision', `${name} must need a decision`);
    assert.equal(person.matchedUserId, null, `${name} must not be auto-linked`);
    const flag = person.flags.find((f) => f.kind === 'possible_match');
    assert.ok(flag && flag.kind === 'possible_match' && flag.candidates.some((c) => c.userId === userId), `${name} should suggest ${userId}`);
  }
  assert.ok(previewRows.every((r) => r.resolvedUserId === null), 'no row is assigned to a suggested person');
  // Never preselected as the same person: the manager answers (a confirm without an answer creates).
  for (const person of people) {
    assert.equal(person.suggestedAction, 'create', person.name);
    assert.equal(person.suggestedUserId, null, person.name);
  }
});

test('an exact-name match is the only thing preselected as "same person"', async () => {
  const users = [{ id: 'u-ava', fullName: 'Ava Thornton', roleId: null }];
  const { people } = await resolveRowsAgainstDatabase(fakePrisma([], users), 'loc-1', [row({ employeeName: 'ava  THORNTON' })]);
  assert.equal(people[0]!.status, 'matched');
  assert.equal(people[0]!.suggestedAction, 'link');
  assert.equal(people[0]!.suggestedUserId, 'u-ava');
});

test('numbered titles and common abbreviations resolve; unknown ones stay non-blocking', async () => {
  const roles = ['Waiter', 'Head Waiter', 'Runner', 'Management', 'Chef'].map((name) => ({ id: `role-${name}`, name }));
  const labels: [string, string | null][] = [
    ['Waiter 3', 'Waiter'],
    ['Head waiter 1', 'Head Waiter'],
    ['Runner 2', 'Runner'],
    ['Waiter #2', 'Waiter'],
    ['WAITER II', 'Waiter'],
    ['RM', 'Management'],
    ['AM', 'Management'],
    ['JAM', 'Management'],
    ['Chef de pass', 'Chef'],
    ['Sous Chef 2', 'Chef'],
    ['Pot Wash', null],
  ];
  const { people } = await resolveRowsAgainstDatabase(
    fakePrisma(roles, []),
    'loc-1',
    labels.map(([label], i) => row({ rowNumber: i + 1, sourceRowIndex: i + 1, employeeName: `Person ${String.fromCharCode(65 + i)}`, roleName: label })),
  );
  labels.forEach(([label, expected], i) => {
    assert.equal(people[i]!.resolvedRoleId, expected ? `role-${expected}` : null, label);
  });
  assert.equal(people[labels.length - 1]!.status, 'new', 'an unknown title never blocks or needs a decision');
});

test('unrelated names are not suggested', async () => {
  const users = [{ id: 'u-1', fullName: 'Maria Lopez', roleId: null }];
  const { people } = await resolveRowsAgainstDatabase(fakePrisma([], users), 'loc-1', [
    row({ rowNumber: 1, employeeName: 'Maria Santos' }),
    row({ rowNumber: 2, employeeName: 'M. Lopez' }),
    row({ rowNumber: 3, employeeName: 'Omar' }),
  ]);
  for (const person of people) {
    assert.equal(person.status, 'new', person.name);
    assert.equal(
      person.flags.some((f) => f.kind === 'possible_match'),
      false,
      person.name,
    );
  }
});

test('two staff with the exact same name are never picked silently', async () => {
  const users = [
    { id: 'u-a', fullName: 'Sam Lee', roleId: null },
    { id: 'u-b', fullName: 'Sam Lee', roleId: null },
  ];
  const { people } = await resolveRowsAgainstDatabase(fakePrisma([], users), 'loc-1', [row({ employeeName: 'Sam Lee' })]);
  assert.equal(people[0]!.status, 'needs_decision');
  assert.equal(people[0]!.matchedUserId, null);
  assert.equal(people[0]!.suggestedAction, 'create');
});

test('the same name on two rows -> duplicate_name; under two sections -> two_sections; both kept, neither merged', async () => {
  const rows = [
    row({ rowNumber: 1, sourceRowIndex: 1, employeeName: 'Lena Park', section: 'WAITERS' }),
    row({ rowNumber: 2, sourceRowIndex: 2, employeeName: 'Lena Park', section: 'BAR' }),
    row({ rowNumber: 3, sourceRowIndex: 3, employeeName: 'Theo Grant', section: 'BAR' }),
    row({ rowNumber: 4, sourceRowIndex: 4, employeeName: 'Theo Grant', section: 'BAR' }),
  ];
  const { people } = await resolveRowsAgainstDatabase(fakePrisma([], []), 'loc-1', rows);
  assert.equal(people.length, 4, 'every entry is kept');
  const lenas = people.filter((p) => p.name === 'Lena Park');
  const theos = people.filter((p) => p.name === 'Theo Grant');
  for (const p of [...lenas, ...theos]) {
    assert.equal(p.status, 'needs_decision');
    assert.ok(p.flags.some((f) => f.kind === 'duplicate_name' && f.personKeys.length === 2));
  }
  assert.ok(lenas.every((p) => p.flags.some((f) => f.kind === 'two_sections' && f.sections.length === 2)));
  assert.ok(theos.every((p) => !p.flags.some((f) => f.kind === 'two_sections')));
});

test('an unresolved role is a non-blocking flag; a remembered role label resolves it next time', async () => {
  const roles = [{ id: 'role-somm', name: 'Sommelier' }];
  const first = await resolveRowsAgainstDatabase(fakePrisma(roles, []), 'loc-1', [row({ employeeName: 'Ava Thornton', roleName: 'Wine Steward' })]);
  assert.ok(first.people[0]!.flags.some((f) => f.kind === 'role_unresolved'));
  assert.equal(first.people[0]!.status, 'new', 'role trouble alone never makes a person need a decision');
  assert.equal(first.summary.people.roleUnresolved, 1);

  const second = await resolveRowsAgainstDatabase(fakePrisma(roles, [], { roleAliases: [{ normalizedLabel: 'wine steward', roleId: 'role-somm' }] }), 'loc-1', [
    row({ employeeName: 'Ava Thornton', roleName: 'Wine Steward' }),
  ]);
  assert.equal(second.people[0]!.resolvedRoleId, 'role-somm');
  assert.equal(second.previewRows[0]!.resolvedRoleId, 'role-somm');
  assert.equal(
    second.people[0]!.flags.some((f) => f.kind === 'role_unresolved'),
    false,
  );
});

test('a matched person whose printed role is unknown keeps their current role (not unresolved)', async () => {
  const roles = [{ id: 'role-waiter', name: 'Waiter' }];
  const users = [{ id: 'u-ava', fullName: 'Ava Thornton', roleId: 'role-waiter' }];
  const { people } = await resolveRowsAgainstDatabase(fakePrisma(roles, users), 'loc-1', [row({ employeeName: 'Ava Thornton', roleName: 'Floor Lead X' })]);
  assert.equal(people[0]!.status, 'matched');
  assert.equal(people[0]!.resolvedRoleId, 'role-waiter');
  assert.equal(
    people[0]!.flags.some((f) => f.kind === 'role_unresolved'),
    false,
  );
});

test('nameCloseness: Vietnamese names that differ only by tone marks are a suggestion, not a match', () => {
  assert.notEqual(personNameKey('Nguyễn Văn An'), personNameKey('Nguyên Văn An'));
  assert.equal(nameCloseness('Nguyễn Văn An', 'Nguyên Văn An'), 'strong');
});

test('the resolve-only abbreviations leave the readers alias table alone ("AM" is still the AM/PM marker there)', () => {
  assert.equal(isRecognizedRoleAlias('AM'), false);
  assert.equal(isRecognizedRoleAlias('JAM'), false);
  assert.equal(isRecognizedRoleAlias('Waiter 3'), false);
});
