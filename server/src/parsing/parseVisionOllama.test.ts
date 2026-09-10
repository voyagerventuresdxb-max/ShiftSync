import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRosterImageOllama, ollamaHttp } from './parseVisionOllama.js';

/** Minimal fake Response, enough for the code under test (response.ok/status/text()/json()). */
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function chatContent(content: unknown): unknown {
  return { message: { role: 'assistant', content: JSON.stringify(content) } };
}

test('completeness check retries once when a name detected in the image is missing from the structured extraction', async (t) => {
  const calls: string[] = [];

  const namesOnlyResponse = { names: ['Amara', 'Kwame'] };
  const incompleteExtraction = {
    venueTemplateNotes: 'test',
    legend: [],
    employees: [
      { rawName: 'Amara', role: 'Bartender', cells: [{ date: '2026-08-17', rawText: '9-17', period: null, interpretation: 'worked_shift', startTime: '09:00', endTime: '17:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null }] },
      // Kwame missing entirely on this attempt.
    ],
    documentAnomalies: [],
  };
  const completeExtraction = {
    venueTemplateNotes: 'test',
    legend: [],
    employees: [
      { rawName: 'Amara', role: 'Bartender', cells: [{ date: '2026-08-17', rawText: '9-17', period: null, interpretation: 'worked_shift', startTime: '09:00', endTime: '17:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null }] },
      { rawName: 'Kwame', role: 'Host', cells: [{ date: '2026-08-17', rawText: '11-19', period: null, interpretation: 'worked_shift', startTime: '11:00', endTime: '19:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null }] },
    ],
    documentAnomalies: [],
  };

  const responses = [
    fakeResponse(chatContent(namesOnlyResponse)), // 1: names-only baseline
    fakeResponse(chatContent(incompleteExtraction)), // 2: first structured extraction attempt (missing Kwame)
    fakeResponse(chatContent(completeExtraction)), // 3: silent retry (complete)
  ];

  t.mock.method(ollamaHttp, 'fetch', async (_url: string, init?: RequestInit) => {
    calls.push(String((JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[1].content));
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch call');
    return next;
  });

  const result = await parseRosterImageOllama(Buffer.from('fake-image-bytes'), 'image/png', 'test.png', '2026-08-17');

  assert.equal(calls.length, 3, 'expected baseline call + 2 extraction attempts (initial + 1 retry)');
  assert.deepEqual(
    result.rows.map((r) => r.employeeName).sort(),
    ['Amara', 'Kwame'],
    'final result should reflect the retry, which has both employees',
  );
});

test('completeness check does not retry when nothing is missing', async (t) => {
  const namesOnlyResponse = { names: ['Amara'] };
  const completeExtraction = {
    venueTemplateNotes: 'test',
    legend: [],
    employees: [
      { rawName: 'Amara', role: 'Bartender', cells: [{ date: '2026-08-17', rawText: '9-17', period: null, interpretation: 'worked_shift', startTime: '09:00', endTime: '17:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null }] },
    ],
    documentAnomalies: [],
  };
  const responses = [fakeResponse(chatContent(namesOnlyResponse)), fakeResponse(chatContent(completeExtraction))];

  let callCount = 0;
  t.mock.method(ollamaHttp, 'fetch', async () => {
    callCount++;
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch call — should not have retried');
    return next;
  });

  const result = await parseRosterImageOllama(Buffer.from('fake-image-bytes'), 'image/png', 'test.png', '2026-08-17');

  assert.equal(callCount, 2, 'baseline + single extraction attempt only, no retry needed');
  assert.equal(result.rows.length, 1);
});

// Excluded from the default test run: measured live on this reference
// machine (RTX 4050, 6GB VRAM — the model doesn't fully fit, so Ollama
// splits inference ~50/50 CPU/GPU), the full structured extraction on this
// specific 21-employee/160+-shift reference image took 10+ minutes and
// still hadn't completed. That's an accepted, known tradeoff for this rare
// last-resort path (deliberate choice: stay fully local with no API
// dependency, see MEMORY.md) rather than a bug to keep chasing — most real
// photo uploads (a small venue's WhatsApp screenshot) are expected to be
// far lighter than this maximally-dense stress-test file and likely
// complete much faster, but that's unverified until real usage confirms
// it. Run manually with RUN_OLLAMA_LIVE_TEST=1 when you want to check
// actual throughput on a given machine/model — not part of `npm test`.
test(
  'live: real reference-venue roster image through the local Ollama vision model',
  { skip: process.env.RUN_OLLAMA_LIVE_TEST ? await ollamaUnavailable() : 'set RUN_OLLAMA_LIVE_TEST=1 to run — can take 10+ minutes on constrained hardware' },
  async () => {
    const buffer = readFileSync('server/test-fixtures/real-roster.png');
    const result = await parseRosterImageOllama(buffer, 'image/png', 'real-roster.png', '2026-08-17');
    // A different, smaller local model won't match Gemini's accuracy exactly
    // — this just checks the pipeline produces a plausible non-empty result,
    // not exact ground truth (that's what the deterministic-path tests hold
    // to a strict standard; this path is the last-resort fallback).
    console.log(`[live Ollama test] ${result.rows.length} rows, ${result.anomalies.length} anomalies, ${result.leaveRecords.length} leave records`);
    assert.ok(result.rows.length > 0, 'expected at least some shifts extracted from a real roster image');
  },
);

async function ollamaUnavailable(): Promise<string | boolean> {
  try {
    const res = await fetch(`${process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return 'Ollama not reachable';
    const data = (await res.json()) as { models?: { name: string }[] };
    const model = process.env.OLLAMA_VLM_MODEL || 'qwen2.5vl:7b';
    const hasModel = (data.models ?? []).some((m) => m.name === model || m.name.startsWith(model.split(':')[0]));
    return hasModel ? false : `model "${model}" not pulled locally`;
  } catch {
    return 'Ollama not reachable';
  }
}
