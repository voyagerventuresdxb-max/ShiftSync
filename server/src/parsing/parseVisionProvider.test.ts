import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseRosterGrid, parseRosterImage, VisionIngestionError } from './parseVision.js';
import { MockVisionProvider, VisionProviderError, __setVisionProviderForTests } from './visionProvider.js';

/**
 * parseVision through the VisionProvider seam: the provider is a mock, everything from the
 * fallback decisions to the row mapping is the real code.
 */
const FAKE_NAME = 'Zed Testperson';
const RESPONSE = JSON.stringify({
  venueTemplateNotes: '',
  legend: [],
  documentAnomalies: [],
  employees: [
    {
      rawName: FAKE_NAME,
      role: 'Bartender',
      cells: [
        { date: '2026-08-17', rawText: '10-18', period: null, interpretation: 'worked_shift', startTime: '10:00', endTime: '18:00', leaveCode: null, confidence: 0.95, needsReview: false, reviewReason: null },
      ],
    },
  ],
});

afterEach(() => __setVisionProviderForTests(null));

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; logs: string[] }> {
  const logs: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    return { result: await fn(), logs };
  } catch (error) {
    return { error, logs };
  } finally {
    Object.assign(console, saved);
  }
}

test('an image read by the provider is mapped to rows, and the roster itself (staff names) is never logged', async () => {
  __setVisionProviderForTests(new MockVisionProvider(RESPONSE));
  const { result, logs } = await captureLogs(() => parseRosterImage(Buffer.from('png'), 'image/png', 'roster.png', '2026-08-17'));
  assert.equal(result?.rows.length, 1);
  assert.equal(result?.rows[0]!.employeeName, FAKE_NAME);
  assert.ok(logs.some((l) => /read by mock model=mock-model/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => l.includes(FAKE_NAME)), 'no staff name in any log line');
});

test('every configured model retired (404) → vision_model_unavailable with a message that names the way out', async () => {
  __setVisionProviderForTests(
    new MockVisionProvider(() => {
      throw new VisionProviderError('No configured vision model is available.', 'model_unavailable');
    }),
  );
  const { error } = await captureLogs(() => parseRosterImage(Buffer.from('png'), 'image/png', 'roster.png'));
  assert.ok(error instanceof VisionIngestionError);
  assert.equal(error.code, 'vision_model_unavailable');
  assert.match(error.message, /Excel\/CSV/);
  assert.match(error.message, /add staff by hand/);
});

test('a grid roster whose AI read fails falls back to the deterministic parser on the same grid (auto mode)', async () => {
  __setVisionProviderForTests(
    new MockVisionProvider(() => {
      throw new VisionProviderError('No configured vision model is available.', 'model_unavailable');
    }),
  );
  const grid = [
    ['', 'Mon', 'Tue'],
    [FAKE_NAME, '10-18', 'OFF'],
  ];
  const { result } = await captureLogs(() => parseRosterGrid(grid, 'grid.csv', '2026-08-17'));
  assert.equal(result?.templateLabel, 'Deterministic local parser (vision_model_unavailable)');
});

test('the grid goes to the provider as text', async () => {
  const mock = new MockVisionProvider(RESPONSE);
  __setVisionProviderForTests(mock);
  await captureLogs(() => parseRosterGrid([['', 'Mon'], [FAKE_NAME, '10-18']], 'grid.csv', '2026-08-17'));
  assert.equal(mock.calls[0]!.kind, 'grid');
});
