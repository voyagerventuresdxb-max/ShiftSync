/**
 * npm run vlm:check — one live round trip through the configured vision provider.
 *
 * Sends a tiny synthetic roster image (server/scripts/fixtures/vlm-check-roster.png: two fake
 * staff, three days) and prints the backend, model, region, latency, token counts and
 * PASS/FAIL. It prints NO credential material (no key, prefix, length, project id or
 * service-account field) and no error text from the provider — only its kind and HTTP status.
 *
 * Exit codes: 0 pass, 1 fail, 2 not configured.
 * Production check: `railway run npm run vlm:check` (see docs/vlm-go-live.md).
 */
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { describeVisionConfig, VertexCredentialsError } from '../src/lib/aiConfig.js';
import { getVisionProvider, VisionProviderError } from '../src/parsing/visionProvider.js';
import { mapVlmResponseToResult } from '../src/parsing/parseVision.js';

// Under `railway run` the service's own variables are injected (RAILWAY_ENVIRONMENT_NAME among them):
// don't let a local .env fill gaps there, or a local key could stand in for production's real config.
if (!process.env.RAILWAY_ENVIRONMENT_NAME) loadDotenv();

const IMAGE = new URL('./fixtures/vlm-check-roster.png', import.meta.url);
const WEEK_START = '2026-08-17';
const EXPECTED_ROWS = 4;

async function main(): Promise<number> {
  console.log(`[vlm:check] ${describeVisionConfig()}`);
  const provider = getVisionProvider();
  if (!provider) {
    console.log('[vlm:check] RESULT: NOT CONFIGURED');
    return 2;
  }
  console.log(
    `[vlm:check] provider=${provider.name} model=${provider.model} fallback=${provider.fallbackModel} region=${provider.region ?? 'n/a'}`,
  );

  const started = Date.now();
  try {
    const output = await provider.readRoster({
      kind: 'file',
      data: readFileSync(IMAGE),
      mimeType: 'image/png',
      originalFilename: 'vlm-check-roster.png',
      weekStart: WEEK_START,
    });
    const ms = Date.now() - started;
    const result = mapVlmResponseToResult(JSON.parse(output.raw), WEEK_START);
    console.log(
      `[vlm:check] answered by model=${output.model} in ${ms}ms; tokens in/out=${output.usage.promptTokens ?? '?'}/${output.usage.outputTokens ?? '?'}; ` +
        `shift rows read=${result.rows.length} (expected ${EXPECTED_ROWS})`,
    );
    const pass = result.rows.length > 0;
    console.log(`[vlm:check] RESULT: ${pass ? 'PASS' : 'FAIL (the model answered but no shift rows were read)'}`);
    return pass ? 0 : 1;
  } catch (err) {
    const ms = Date.now() - started;
    const cause = (err as { cause?: unknown })?.cause;
    const credentials = cause instanceof VertexCredentialsError ? cause : null;
    const kind = credentials ? 'credentials' : err instanceof VisionProviderError ? err.kind : 'error';
    const status = (cause as { status?: unknown } | undefined)?.status;
    // Our own credential messages name the problem without echoing any value; nothing else is printed verbatim.
    const detail = credentials ? `: ${credentials.message}` : '';
    console.log(`[vlm:check] RESULT: FAIL (${kind}${typeof status === 'number' ? `, HTTP ${status}` : ''}) after ${ms}ms${detail}`);
    return 1;
  }
}

// exitCode, not process.exit(): exiting while the HTTP client's sockets are still closing trips
// a libuv assertion on Windows. The process ends on its own once they close.
main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.log('[vlm:check] RESULT: FAIL (unexpected error)');
    process.exitCode = 1;
  },
);
