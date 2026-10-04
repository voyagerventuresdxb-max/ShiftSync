import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeReturnTo, postLoginDestination } from './postLoginDestination';

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
  assert.equal(isSafeReturnTo('/onboarding/venue'), true);
  assert.equal(isSafeReturnTo('/'), true);
});

test('isSafeReturnTo: rejects missing/empty values, falling back to the caller\'s own default', () => {
  assert.equal(isSafeReturnTo(undefined), false);
  assert.equal(isSafeReturnTo(null), false);
  assert.equal(isSafeReturnTo(''), false);
});

test('isSafeReturnTo: rejects anything not rooted at /, which a router-relative navigation would resolve against /login', () => {
  assert.equal(isSafeReturnTo('scheduling'), false);
  assert.equal(isSafeReturnTo('?returnTo=/people'), false);
  assert.equal(isSafeReturnTo('#x'), false);
});

test('isSafeReturnTo: rejects a redirect back into the join or login screens', () => {
  assert.equal(isSafeReturnTo('/join'), false);
  assert.equal(isSafeReturnTo('/join?mode=login'), false);
  assert.equal(isSafeReturnTo('/join?location=abc'), false);
  assert.equal(isSafeReturnTo('/login'), false);
  assert.equal(isSafeReturnTo('/login?returnTo=%2Fpeople'), false);
});

test('isSafeReturnTo: the /join and /login guards are case-INSENSITIVE, matching react-router-dom\'s default route matching', () => {
  // react-router-dom's route matching defaults to caseSensitive: false (this
  // app's routes set no override), so /JOIN and /LOGIN really do route back
  // into those screens. A case-sensitive guard would let the exact loop this
  // check exists to prevent happen anyway, just via a differently-cased link.
  assert.equal(isSafeReturnTo('/JOIN'), false);
  assert.equal(isSafeReturnTo('/Join'), false);
  assert.equal(isSafeReturnTo('/JoIn?mode=login'), false);
  assert.equal(isSafeReturnTo('/LOGIN'), false);
  assert.equal(isSafeReturnTo('/Login?returnTo=%2F'), false);
});

test('isSafeReturnTo: the /join and /login guards see the path the router will match (dot segments, percent-encoding)', () => {
  assert.equal(isSafeReturnTo('/./login'), false);
  assert.equal(isSafeReturnTo('/x/../login'), false);
  assert.equal(isSafeReturnTo('/%6Cogin'), false);
  assert.equal(isSafeReturnTo('/%4Aoin'), false);
  // Malformed escapes fail closed rather than throwing.
  assert.equal(isSafeReturnTo('/%E0%A4%A'), false);
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

test('postLoginDestination: with no returnTo, OWNER and MANAGER land on / and STAFF on /my-shifts', () => {
  assert.equal(postLoginDestination('OWNER'), '/');
  assert.equal(postLoginDestination('MANAGER'), '/');
  assert.equal(postLoginDestination('STAFF'), '/my-shifts');
  assert.equal(postLoginDestination('OWNER', null), '/');
  assert.equal(postLoginDestination('STAFF', ''), '/my-shifts');
});

test('postLoginDestination: an unknown or missing role fails closed to /my-shifts, never a manager page', () => {
  assert.equal(postLoginDestination(undefined), '/my-shifts');
  assert.equal(postLoginDestination(''), '/my-shifts');
  assert.equal(postLoginDestination('owner'), '/my-shifts');
  assert.equal(postLoginDestination('ADMIN'), '/my-shifts');
});

test('postLoginDestination: a safe returnTo wins for every role', () => {
  for (const role of ['OWNER', 'MANAGER', 'STAFF', undefined]) {
    assert.equal(postLoginDestination(role, '/people'), '/people');
    assert.equal(postLoginDestination(role, '/scheduling?week=2026-01-01#x'), '/scheduling?week=2026-01-01#x');
  }
});

test('postLoginDestination: an unsafe returnTo is ignored and the role destination is used instead', () => {
  const unsafe = ['https://evil.example', '//evil.example', '/\t/evil.example', '/\\evil.example', 'javascript:alert(1)', '/LOGIN', '/login', '/join?mode=login', '/JOIN', 'people'];
  for (const returnTo of unsafe) {
    assert.equal(postLoginDestination('OWNER', returnTo), '/', returnTo);
    assert.equal(postLoginDestination('MANAGER', returnTo), '/', returnTo);
    assert.equal(postLoginDestination('STAFF', returnTo), '/my-shifts', returnTo);
    assert.equal(postLoginDestination(undefined, returnTo), '/my-shifts', returnTo);
  }
});
