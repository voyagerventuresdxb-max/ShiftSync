import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  DEFAULT_VERTEX_LOCATION,
  DEFAULT_VISION_FALLBACK_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_VOICE_MODEL,
  describeVisionConfig,
  describeVoiceConfig,
  vertexCredentials,
  VertexCredentialsError,
  visionConfig,
  voiceConfig,
} from './aiConfig.js';

test('nothing set: vision is not configured, and the verified default models apply', () => {
  const v = visionConfig({});
  assert.equal(v.backend, null);
  assert.equal(v.model, DEFAULT_VISION_MODEL);
  assert.equal(v.fallbackModel, DEFAULT_VISION_FALLBACK_MODEL);
  assert.equal(v.location, null);
  assert.equal(v.timeoutMs, 30_000);
  assert.equal(voiceConfig({}).model, DEFAULT_VOICE_MODEL);
  assert.match(describeVisionConfig(v), /not configured/);
});

test('the defaults are the IDs verified on 2026-10-04, and Vertex defaults to the EU multi-region', () => {
  assert.equal(DEFAULT_VISION_MODEL, 'gemini-3.6-flash');
  assert.equal(DEFAULT_VISION_FALLBACK_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(DEFAULT_VOICE_MODEL, 'gemini-3.6-flash');
  // Neither model is offered in any single EU region (europe-west4 included); `eu` keeps processing in the EU.
  assert.equal(DEFAULT_VERTEX_LOCATION, 'eu');
});

test('a Vertex project selects Vertex (default location eu); a key alone selects the Developer API', () => {
  const vertex = visionConfig({ GEMINI_VERTEX_PROJECT: 'proj-1', GEMINI_API_KEY: 'k' });
  assert.equal(vertex.backend, 'vertex');
  assert.equal(vertex.location, 'eu');
  assert.equal(vertex.project, 'proj-1');
  const devApi = visionConfig({ GEMINI_API_KEY: 'k' });
  assert.equal(devApi.backend, 'developer-api');
  assert.equal(devApi.location, null);
});

test('overrides are read from the environment, trimmed, and blank values fall back to the defaults', () => {
  const v = visionConfig({
    GEMINI_VERTEX_PROJECT: ' proj-2 ',
    GEMINI_VERTEX_LOCATION: ' global ',
    VLM_MODEL: ' model-a ',
    VLM_FALLBACK_MODEL: '  ',
    GEMINI_HTTP_TIMEOUT_MS: '45000',
  });
  assert.deepEqual([v.project, v.location, v.model, v.fallbackModel, v.timeoutMs], ['proj-2', 'global', 'model-a', DEFAULT_VISION_FALLBACK_MODEL, 45000]);
  assert.equal(visionConfig({ GEMINI_HTTP_TIMEOUT_MS: 'nope' }).timeoutMs, 30_000);
  assert.equal(voiceConfig({ VOICE_MODEL: 'model-v' }).model, 'model-v');
});

test('voice uses the same backend, project, region and timeout as vision; only the model is its own', () => {
  const env = { GEMINI_VERTEX_PROJECT: 'proj-3', GEMINI_VERTEX_LOCATION: 'us', GEMINI_HTTP_TIMEOUT_MS: '20000', VOICE_MODEL: 'model-v', VLM_MODEL: 'model-a' };
  const v = voiceConfig(env);
  assert.deepEqual([v.backend, v.project, v.location, v.timeoutMs, v.model], ['vertex', 'proj-3', 'us', 20000, 'model-v']);
  assert.equal(voiceConfig({ GEMINI_API_KEY: 'k' }).backend, 'developer-api');
  assert.equal(voiceConfig({}).backend, null);
});

test('describeVoiceConfig names backend, model and region but never the project id or any key', () => {
  const line = describeVoiceConfig(voiceConfig({ GEMINI_VERTEX_PROJECT: 'secret-project-id', GEMINI_API_KEY: 'key-value-xyz' }));
  assert.equal(line, 'voice: vertex location=eu model=gemini-3.6-flash');
  assert.match(describeVoiceConfig(voiceConfig({})), /not configured/);
});

test('describeVisionConfig names backend, model and region but never the project id or any key', () => {
  const line = describeVisionConfig(visionConfig({ GEMINI_VERTEX_PROJECT: 'secret-project-id', GEMINI_API_KEY: 'key-value-xyz' }));
  assert.match(line, /vertex location=eu model=gemini-3\.6-flash fallback=gemini-3\.5-flash-lite/);
  assert.ok(!line.includes('secret-project-id'));
  assert.ok(!line.includes('key-value-xyz'));
});

test('GOOGLE_SERVICE_ACCOUNT_JSON: unset → ADC; valid → credentials; malformed → a message that never echoes the value', () => {
  assert.equal(vertexCredentials({}), undefined);
  const value = JSON.stringify({ type: 'service_account', client_email: 'sa@example.iam', private_key: 'PRIVATE-MATERIAL-123' });
  assert.deepEqual(vertexCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: value }), { client_email: 'sa@example.iam', private_key: 'PRIVATE-MATERIAL-123' });
  for (const bad of ['{"private_key": "PRIVATE-MATERIAL-123"', JSON.stringify({ private_key: 'PRIVATE-MATERIAL-123' })]) {
    assert.throws(
      () => vertexCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: bad }),
      (err: unknown) => err instanceof VertexCredentialsError && !err.message.includes('PRIVATE-MATERIAL'),
    );
  }
});

test('no model-ID literal anywhere in server code or scripts outside lib/aiConfig.ts (tests excluded)', () => {
  const roots = ['server/src', 'server/scripts', 'src', 'shared'];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'node_modules' && name !== '__fixtures__') walk(p);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(name) || /\.test\.|\.spec\./.test(name)) continue;
      const rel = relative('.', p).replace(/\\/g, '/');
      if (rel === 'server/src/lib/aiConfig.ts') continue;
      if (/['"`]gemini-\d/.test(readFileSync(p, 'utf8'))) offenders.push(rel);
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], `model IDs must live in server/src/lib/aiConfig.ts only: ${offenders.join(', ')}`);
});
