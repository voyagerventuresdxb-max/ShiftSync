import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canConfirmVoiceIntent, MANAGER_INTENTS, STAFF_INTENTS } from '../../shared/voiceIntents';

test('canConfirmVoiceIntent: staff may confirm staff intents only; managers and owners every intent; nobody UNRECOGNIZED', () => {
  for (const intent of STAFF_INTENTS) {
    assert.equal(canConfirmVoiceIntent('STAFF', intent), true, intent);
    assert.equal(canConfirmVoiceIntent('MANAGER', intent), true, intent);
    assert.equal(canConfirmVoiceIntent('OWNER', intent), true, intent);
  }
  for (const intent of MANAGER_INTENTS.filter((i) => !(STAFF_INTENTS as readonly string[]).includes(i))) {
    assert.equal(canConfirmVoiceIntent('STAFF', intent), false, intent);
    assert.equal(canConfirmVoiceIntent('MANAGER', intent), true, intent);
    assert.equal(canConfirmVoiceIntent('OWNER', intent), true, intent);
  }
  assert.equal(canConfirmVoiceIntent('OWNER', 'UNRECOGNIZED'), false);
  assert.equal(canConfirmVoiceIntent('ADMIN', 'MARK_AVAILABILITY'), false, 'an unknown role (tampered session) fails closed');
});
