import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionedIn, periodSaid, resolveTerm, type Term } from './vocabulary.js';

// A made-up venue's sections and roles.
const sections: Term[] = [
  { id: 'main', label: 'Main Bar' },
  { id: 'pool', label: 'Pool Bar' },
  { id: 'terrace', label: 'Terrace' },
  { id: 'terraceBar', label: 'Terrace Bar' },
  { id: 'floor1', label: 'Floor 1' },
  { id: 'floor2', label: 'Floor 2' },
  { id: 'vip', label: 'VIP Section' },
];
const roles: Term[] = [
  { id: 'bartender', label: 'Bartender' },
  { id: 'barback', label: 'Bar Back' },
  { id: 'chef', label: 'Chef' },
  { id: 'headChef', label: 'Head Chef' },
];
const ids = (t: Term[]) => t.map((x) => x.id);

test('a spoken section that names one item resolves to it', () => {
  assert.deepEqual(resolveTerm('the terrace', sections), { kind: 'one', item: sections[2] });
  assert.deepEqual(resolveTerm('Pool Bar', sections), { kind: 'one', item: sections[1] });
  assert.deepEqual(resolveTerm('the VIP', sections), { kind: 'one', item: sections[6] });
});

test('"the bar" or "floor" with several such items is a choice, never a pick', () => {
  const bar = resolveTerm('the bar', sections);
  assert.equal(bar.kind, 'choice');
  assert.deepEqual(bar.kind === 'choice' && ids(bar.items), ['main', 'pool', 'terraceBar']);
  const floor = resolveTerm('floor', sections);
  assert.deepEqual(floor.kind === 'choice' && ids(floor.items), ['floor1', 'floor2']);
});

test('a close mishearing is a choice; nothing close says back what was heard', () => {
  // Another spelling of the same word is the same word.
  assert.deepEqual(resolveTerm('Terace', sections), { kind: 'one', item: sections[2] });
  const r = resolveTerm('Terrice', sections);
  assert.deepEqual(r.kind === 'choice' && ids(r.items), ['terrace', 'terraceBar']);
  assert.deepEqual(resolveTerm('rooftop', sections), { kind: 'none', heard: 'rooftop' });
});

test('roles: an exact role name settles, even when a longer role contains it', () => {
  assert.deepEqual(resolveTerm('bartender', roles), { kind: 'one', item: roles[0] });
  assert.deepEqual(resolveTerm('head chef', roles), { kind: 'one', item: roles[3] });
  const chef = resolveTerm('chef', roles);
  assert.deepEqual(chef, { kind: 'one', item: roles[2] });
});

test('items named in what the caller said: the most specific full name, else every partial match', () => {
  assert.deepEqual(ids(mentionedIn('Put Omar on the terrace bar tomorrow evening', sections)), ['terraceBar']);
  assert.deepEqual(ids(mentionedIn('Put Omar on the terrace tomorrow', sections)), ['terrace']);
  assert.deepEqual(ids(mentionedIn('Put Omar on the bar tonight', sections)), ['main', 'pool', 'terraceBar']);
  assert.deepEqual(ids(mentionedIn('Put Omar somewhere tonight', sections)), []);
  assert.deepEqual(ids(mentionedIn('Create a head chef shift for Karim', roles)), ['headChef']);
  assert.deepEqual(ids(mentionedIn('Create a bartender shift for Layla', roles)), ['bartender']);
});

test('service periods: closing/dinner are evening, opening/lunch are daytime, neither or both is unknown', () => {
  assert.equal(periodSaid('Put Omar on the bar for closing'), 'PM');
  assert.equal(periodSaid('tomorrow evening'), 'PM');
  assert.equal(periodSaid('dinner service'), 'PM');
  assert.equal(periodSaid('opening shift on the terrace'), 'AM');
  assert.equal(periodSaid('lunch on Friday'), 'AM');
  assert.equal(periodSaid('I am putting Omar on an open shift'), null);
  assert.equal(periodSaid('lunch and dinner'), null);
});
