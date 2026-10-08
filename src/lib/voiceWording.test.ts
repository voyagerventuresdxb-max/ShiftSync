import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIntent } from '@/api/voice';
import { confirmLabel, daysInclusive, isAppPath, publishSentence } from './voiceWording';

test('publish sentence states both counts, in the singular when it is one', () => {
  assert.equal(publishSentence({ shiftsChanging: 12, peopleNotified: 8 }), '12 shifts will change and 8 people will be notified.');
  assert.equal(publishSentence({ shiftsChanging: 1, peopleNotified: 1 }), '1 shift will change and 1 person will be notified.');
  assert.equal(publishSentence({ shiftsChanging: 3, peopleNotified: 0 }), '3 shifts will change and nobody will be notified.');
});

test('Confirm says what a publish notifies and what a cancellation cancels; everything else is plain Confirm', () => {
  const publish = (peopleNotified: number): ParsedIntent => ({
    intent: 'PUBLISH_ROTA',
    weekStart: '2026-10-12',
    counts: { shiftsChanging: 4, peopleNotified },
    confidence: 0.9,
    summary: 'Publish.',
  });
  assert.equal(confirmLabel(publish(8)), 'Confirm: publish and notify 8 people');
  assert.equal(confirmLabel(publish(1)), 'Confirm: publish and notify 1 person');
  assert.equal(confirmLabel(publish(0)), 'Confirm: publish (nobody to notify)');
  // An older server without counts: unchanged.
  assert.equal(confirmLabel({ intent: 'PUBLISH_ROTA', weekStart: '2026-10-12', confidence: 0.9, summary: 'Publish.' }), 'Confirm');
  assert.equal(
    confirmLabel({
      intent: 'CANCEL_SHIFT',
      shiftId: 's',
      confidence: 0.9,
      summary: 'Cancel.',
      details: { person: null, personRole: null, date: '2026-10-09', start: '18:00', end: '23:00', role: null },
    }),
    'Confirm: cancel this shift',
  );
  assert.equal(confirmLabel({ intent: 'POST_ANNOUNCEMENT', content: 'x', confidence: 0.9, summary: 'Post.' }), 'Confirm');
});

test('days are counted inclusively; nonsense is null', () => {
  assert.equal(daysInclusive('2026-10-12', '2026-10-14'), 3);
  assert.equal(daysInclusive('2026-10-12', '2026-10-12'), 1);
  assert.equal(daysInclusive('2026-12-31', '2027-01-01'), 2);
  assert.equal(daysInclusive('2026-10-14', '2026-10-12'), null);
  assert.equal(daysInclusive('soon', '2026-10-12'), null);
});

test('a screen link only ever goes to a route inside the app', () => {
  assert.equal(isAppPath('/people'), true);
  assert.equal(isAppPath('//evil.example'), false);
  assert.equal(isAppPath('/\\evil.example'), false);
  assert.equal(isAppPath('https://evil.example'), false);
  assert.equal(isAppPath('javascript:alert(1)'), false);
});
