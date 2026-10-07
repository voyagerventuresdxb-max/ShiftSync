import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, resolvePerson, type StaffEntry } from './people.js';

// Made-up staff. Two Omars, three Karims, one each of the rest.
const staff: StaffEntry[] = [
  { id: 'caller', fullName: 'Dina Manager' },
  { id: 'layla', fullName: 'Layla Nasser' },
  { id: 'omarH', fullName: 'Omar Haddad' },
  { id: 'omarF', fullName: 'Omar Farouk' },
  { id: 'karimS', fullName: 'Karim Saleh' },
  { id: 'karimA', fullName: 'Karim Aziz' },
  { id: 'karimB', fullName: 'Karim Bashir' },
  { id: 'maricel', fullName: 'Maricel Dizon' },
  { id: 'junjun', fullName: 'Jun-Jun Ramos' },
  { id: 'alex', fullName: 'Alex Morgan' },
];
const ids = (r: ReturnType<typeof resolvePerson>) =>
  r.kind === 'one' ? [r.person.id] : r.kind === 'ambiguous' ? r.people.map((p) => p.id) : r.kind === 'missing' ? r.near.map((p) => p.id) : [];

test('normalizeName: case, accents, possessives and punctuation', () => {
  assert.equal(normalizeName("Jun-Jun's"), 'jun jun');
  assert.equal(normalizeName('  ÉLODIE  O’Neil '), 'elodie o neil');
});

test('a name only one person has resolves to them, by first name, full name or surname', () => {
  for (const heard of ['Layla', 'layla nasser', 'Nasser']) {
    const r = resolvePerson(heard, null, staff, `Give ${heard} a shout-out`, 'caller');
    assert.deepEqual([r.kind, ids(r)], ['one', ['layla']], heard);
  }
  assert.deepEqual(ids(resolvePerson('Jun-Jun', null, staff, 'ask jun-jun to cover', 'caller')), ['junjun']);
});

test('the model picking the same person as the name said is accepted', () => {
  const r = resolvePerson('Layla', 'layla', staff, 'Give Layla a shout-out', 'caller');
  assert.deepEqual([r.kind, ids(r)], ['one', ['layla']]);
});

test('a first name two people share is a question, even when the model picked one confidently', () => {
  for (const modelId of [null, 'omarH']) {
    const r = resolvePerson('Omar', modelId, staff, 'Give Omar a shout-out saying great job', 'caller');
    assert.equal(r.kind, 'ambiguous');
    assert.deepEqual(ids(r), ['omarF', 'omarH']);
    assert.equal(r.kind === 'ambiguous' && r.heard, 'Omar');
  }
});

test('three people with the same first name: all three are offered', () => {
  const r = resolvePerson('Karim', 'karimA', staff, 'Give Karim a shout-out', 'caller');
  assert.deepEqual([r.kind, ids(r)], ['ambiguous', ['karimA', 'karimB', 'karimS']]);
});

test('a full name settles a shared first name; a full name the caller never said does not', () => {
  assert.deepEqual(ids(resolvePerson('Omar Farouk', null, staff, 'Give Omar Farouk a shout-out', 'caller')), ['omarF']);
  // The model "helpfully" wrote the full name, but the caller only said "Omar".
  const r = resolvePerson('Omar Haddad', 'omarH', staff, 'Give Omar a shout-out', 'caller');
  assert.deepEqual([r.kind, ids(r)], ['ambiguous', ['omarF', 'omarH']]);
  // No name at all from the model, only its pick: the transcript still decides.
  const silent = resolvePerson('', 'omarH', staff, 'Give Omar a shout-out', 'caller');
  assert.deepEqual([silent.kind, ids(silent)], ['ambiguous', ['omarF', 'omarH']]);
});

test("the model's id disagreeing with the name said puts both to the caller", () => {
  const r = resolvePerson('Layla', 'alex', staff, 'Give Layla a shout-out', 'caller');
  assert.deepEqual([r.kind, ids(r)], ['ambiguous', ['layla', 'alex']]);
});

test('nobody by that name: missing, with similar spellings as suggestions (closest first, at most three)', () => {
  const rana = resolvePerson('Rana', null, staff, 'Give Rana a shout-out', 'caller');
  assert.deepEqual([rana.kind, ids(rana)], ['missing', []]);
  const mariel = resolvePerson('Mariel', null, staff, 'Give Mariel a shout-out', 'caller');
  assert.deepEqual([mariel.kind, ids(mariel)], ['missing', ['maricel']]);
  const karin = resolvePerson('Karin', null, staff, 'Give Karin a shout-out', 'caller');
  assert.equal(karin.kind, 'missing');
  assert.equal(ids(karin).length, 3);
});

test('a mishearing the model already resolved is accepted only when it is the one close name', () => {
  assert.deepEqual(ids(resolvePerson('Alix', 'alex', staff, 'Give Alix a shout-out', 'caller')), ['alex']);
  // A close name, but the model picked someone unrelated: not accepted.
  assert.equal(resolvePerson('Alix', 'layla', staff, 'Give Alix a shout-out', 'caller').kind, 'missing');
});

test('"me" is the caller; no name and an id from nowhere is unknown', () => {
  assert.deepEqual(ids(resolvePerson('me', null, staff, 'create a shift for me', 'caller')), ['caller']);
  assert.equal(resolvePerson('', 'someone-else', staff, 'give a shout-out', 'caller').kind, 'unknown');
  assert.equal(resolvePerson('', null, staff, 'give a shout-out', 'caller').kind, 'unknown');
});

test("only the venue's own staff are ever candidates", () => {
  // The caller's venue has no Bartholomew; another venue's id is never resolved or suggested.
  const r = resolvePerson('Bartholomew', 'other-venue-person', staff, 'Give Bartholomew a shout-out', 'caller');
  assert.equal(r.kind, 'missing');
  assert.deepEqual(ids(r), []);
});
