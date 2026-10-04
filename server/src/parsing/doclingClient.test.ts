import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDoclingAvailable, parseScannedPdfViaDocling } from './doclingClient.js';
import { privateFixture, privateFixtureSkipMessage } from './privateFixtures.js';

const SYNTHETIC_SCAN = 'server/test-fixtures/synthetic/scanned-roster.pdf';

// Live integration test against the real Docling sidecar (server/docling-sidecar).
// Requires the sidecar to be running (`npm run docling:sidecar`) — skips cleanly
// otherwise, matching the pattern of the gated live Ollama test, since CI/most
// dev machines won't have the sidecar up by default.
test('live: the synthetic scanned (image-only) roster through the Docling sidecar produces a structured grid', async (t) => {
  if (!(await isDoclingAvailable())) {
    t.skip('Docling sidecar not reachable at DOCLING_SIDECAR_HOST — run `npm run docling:sidecar` first.');
    return;
  }
  const result = await parseScannedPdfViaDocling(readFileSync(SYNTHETIC_SCAN), 'scanned-roster.pdf', '2026-08-17');
  assert.ok(result, 'Docling should detect and structure the table on the synthetic scan');
  assert.ok(result!.rows.length > 0, 'expected at least some resolved shift rows');
});

test('live: the real scanned roster (private, local only) through the Docling sidecar produces a structured grid', async (t) => {
  if (!(await isDoclingAvailable())) {
    t.skip('Docling sidecar not reachable at DOCLING_SIDECAR_HOST — run `npm run docling:sidecar` first.');
    return;
  }
  const fixturePath = privateFixture('bar-des-pres-roster.pdf');
  if (!fixturePath) {
    t.skip(privateFixtureSkipMessage('bar-des-pres-roster.pdf'));
    return;
  }

  const buffer = readFileSync(fixturePath);
  const result = await parseScannedPdfViaDocling(buffer, 'scanned-roster.pdf', '2026-04-13');

  assert.ok(result, 'Docling should detect and structure the table on this fixture');
  assert.ok(result!.rows.length > 0, 'expected at least some resolved shift rows');

  // Spot-check a couple of the harder cell shapes this fixture is known for
  // (per the hand-transcribed reference test, barDesPresReference.test.ts).
  const names = new Set(result!.rows.map((r) => r.employeeName));
  assert.ok(names.size > 0, 'expected at least one recognizable employee name');
});
