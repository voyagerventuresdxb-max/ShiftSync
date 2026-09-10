import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeReturnTo } from './JoinFlow';

/**
 * `isSafeReturnTo` is the only thing standing between an attacker-crafted
 * `returnTo` query param and an open redirect straight out of this app right
 * after a real login. A blocklist-style first draft of this function was
 * caught in review missing a real bypass (embedded ASCII tab/CR/LF, which the
 * WHATWG URL parser strips before resolving a URL, silently turning an
 * apparently-safe `/\t/evil.example` into a protocol-relative `//evil.example`
 * at actual navigation time) — these cases exist so that class of mistake,
 * and this specific one, can't quietly come back.
 */

test('isSafeReturnTo: accepts ordinary same-origin relative paths', () => {
  assert.equal(isSafeReturnTo('/scheduling'), true);
  assert.equal(isSafeReturnTo('/scheduling?week=2026-01-01'), true);
  assert.equal(isSafeReturnTo('/floor-plan'), true);
  assert.equal(isSafeReturnTo('/my-shifts'), true);
});

test('isSafeReturnTo: rejects missing/empty values, falling back to the caller\'s own default', () => {
  assert.equal(isSafeReturnTo(undefined), false);
  assert.equal(isSafeReturnTo(null), false);
  assert.equal(isSafeReturnTo(''), false);
});

test('isSafeReturnTo: rejects a redirect back into the join flow itself', () => {
  assert.equal(isSafeReturnTo('/join'), false);
  assert.equal(isSafeReturnTo('/join?mode=login'), false);
});

test('isSafeReturnTo: the /join guard is case-INSENSITIVE, matching react-router-dom\'s default route matching', () => {
  // A case-sensitive check here would let `/JOIN` (or any other casing)
  // through as "safe" — but react-router-dom's route matching defaults to
  // caseSensitive: false (confirmed for this app's own /join route in
  // router.tsx, which sets no override), so /JOIN really does route back
  // into JoinContent. A case-sensitive guard would let the exact loop this
  // check exists to prevent happen anyway, just via a differently-cased link.
  assert.equal(isSafeReturnTo('/JOIN'), false);
  assert.equal(isSafeReturnTo('/Join'), false);
  assert.equal(isSafeReturnTo('/JoIn?mode=login'), false);
});

test('isSafeReturnTo: rejects absolute and protocol-relative URLs to another host', () => {
  assert.equal(isSafeReturnTo('https://evil.example'), false);
  assert.equal(isSafeReturnTo('http://evil.example/x'), false);
  assert.equal(isSafeReturnTo('//evil.example'), false);
});

test('isSafeReturnTo: rejects non-http(s) schemes', () => {
  assert.equal(isSafeReturnTo('javascript:alert(1)'), false);
  assert.equal(isSafeReturnTo('data:text/html,evil'), false);
});

test('isSafeReturnTo: rejects the backslash-as-slash bypass', () => {
  // Browsers treat `\` as `/` when resolving an http(s) URL, so a naive
  // "no literal //" check can be defeated by `/\evil.example`, which
  // normalizes to `//evil.example` at actual navigation time.
  assert.equal(isSafeReturnTo('/\\evil.example'), false);
  assert.equal(isSafeReturnTo('/\\/evil.example'), false);
});

test('isSafeReturnTo: rejects the embedded tab/CR/LF bypass (the one a blocklist missed)', () => {
  // The WHATWG URL parser strips ASCII tab/CR/LF from anywhere in a URL
  // before resolving it — verified: new URL('/\t/evil.example', 'https://x').host
  // is really 'evil.example'. A check that only scans for a literal `//` or
  // `\` in the raw string never sees this, because those characters aren't
  // in the raw string at all until the parser's own normalization removes
  // the tab and collapses what's left into a protocol-relative URL.
  assert.equal(isSafeReturnTo('/\t/evil.example'), false);
  assert.equal(isSafeReturnTo('/\r/evil.example'), false);
  assert.equal(isSafeReturnTo('/\n/evil.example'), false);
  assert.equal(isSafeReturnTo('/\r\n/evil.example'), false);
});
