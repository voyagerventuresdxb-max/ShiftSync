import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingMessage } from './readingMessage';

test('the reading message calms down as time passes, up to the ~100s an AI read may take', () => {
  assert.equal(readingMessage(0), 'Reading your roster…');
  assert.match(readingMessage(10), /photo or scan takes longer/);
  assert.match(readingMessage(40), /a minute or two/);
  assert.match(readingMessage(95), /up to two minutes/);
});
