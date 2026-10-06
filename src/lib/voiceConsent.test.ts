import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasVoiceConsent, saveVoiceConsent, withdrawVoiceConsent } from './voiceConsent';

function withStorage(storage: Partial<Storage> | 'throws', fn: () => void) {
  const g = globalThis as { localStorage?: unknown };
  const saved = g.localStorage;
  g.localStorage = storage === 'throws' ? new Proxy({}, { get: () => () => { throw new Error('blocked'); } }) : storage;
  try {
    fn();
  } finally {
    g.localStorage = saved;
  }
}

test('consent is per person: saved, read back, withdrawn', () => {
  const data = new Map<string, string>();
  withStorage({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }, () => {
    assert.equal(hasVoiceConsent('u1'), false);
    saveVoiceConsent('u1');
    assert.equal(hasVoiceConsent('u1'), true);
    assert.equal(hasVoiceConsent('u2'), false, 'another person on the same device still gets the notice');
    withdrawVoiceConsent('u1');
    assert.equal(hasVoiceConsent('u1'), false);
  });
});

test('blocked storage never counts as consent, and nothing throws', () => {
  withStorage('throws', () => {
    saveVoiceConsent('u1');
    withdrawVoiceConsent('u1');
    assert.equal(hasVoiceConsent('u1'), false);
  });
});
