import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_ACCENT, cssRgb, tokenRgb } from './cssToken';

test('without a stylesheet the token falls back to the gold accent', () => {
  assert.deepEqual(tokenRgb('--accent'), { r: 0xc9, g: 0xa6, b: 0x6b });
  assert.equal(FALLBACK_ACCENT, '#c9a66b');
});

test('canvas colour strings: rounded channels, alpha only when given', () => {
  assert.equal(cssRgb({ r: 201.4, g: 166.6, b: 107 }), 'rgb(201,167,107)');
  assert.equal(cssRgb({ r: 201, g: 166, b: 107 }, 0.25), 'rgba(201,166,107,0.25)');
});
