import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWellFormedReading } from './voiceReading';

const shout = { intent: 'POST_SHOUTOUT', targetUserId: 'u1', targetUserName: 'Alex Example', content: 'Great job', confidence: 0.9, summary: 'Give Alex Example a shout-out.' };
const answer = { title: 'Working tonight', items: [{ primary: 'Sam Sample', secondary: 'Bartender' }], emptyText: 'Nobody yet.' };

test('the readings the server sends pass: actions, answers, declines, choices', () => {
  assert.ok(isWellFormedReading(shout));
  assert.ok(isWellFormedReading({ intent: 'CREATE_SHIFT', roleId: 'r', date: '2031-03-07', start: '18:00', end: '02:00', userId: null, confidence: 0.9, summary: 's', second: { start: '11:00', end: '15:00' } }));
  assert.ok(isWellFormedReading({ intent: 'WHO_IS_WORKING', answer, confidence: 0.9, summary: 'Working tonight' }));
  assert.ok(isWellFormedReading({ intent: 'QUERY_MY_SCHEDULE', confidence: 0.9, summary: 'You work Friday.' }));
  assert.ok(isWellFormedReading({ intent: 'DECLINED', category: 'staff', message: 'Do that on People.', screen: null, confidence: 1, summary: 'Not by voice' }));
  assert.ok(isWellFormedReading({ intent: 'UNRECOGNIZED', reason: 'Two match.', summary: 'Which Alex?', options: [shout, { ...shout, targetUserId: 'u2' }] }));
});

test('a reading missing what the sheet draws is refused, including inside "Which one?" choices', () => {
  for (const bad of [
    undefined,
    null,
    'POST_SHOUTOUT',
    { intent: 'POST_SHOUTOUT', summary: 'x' },
    { ...shout, targetUserName: undefined },
    { intent: 'NOPE', summary: 'x' },
    { intent: 'WHO_IS_WORKING', answer: 'You are working Friday.', confidence: 0.9, summary: 's' },
    { intent: 'WHO_IS_WORKING', answer: { title: 't', emptyText: 'e' }, confidence: 0.9, summary: 's' },
    { ...shout, summary: 7 },
    { intent: 'UNRECOGNIZED', reason: 'r', summary: 's', options: [shout, { intent: 'POST_SHOUTOUT', summary: 'x' }] },
    { intent: 'CANCEL_SHIFT', shiftId: 's1', confidence: 0.9, summary: 's' },
  ]) {
    assert.equal(isWellFormedReading(bad), false, JSON.stringify(bad));
  }
});
