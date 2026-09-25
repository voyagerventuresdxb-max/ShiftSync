#!/usr/bin/env node
/**
 * Creates the throwaway self-signed TLS certificate e2e/golden-path.spec.ts
 * uses for its local Web Push receiver. web-push only ever delivers over
 * HTTPS, so the spec runs an HTTPS "push service" on localhost and points a
 * PushSubscription at it; the API server must trust that certificate, which
 * is what NODE_EXTRA_CA_CERTS is for.
 *
 * NODE_EXTRA_CA_CERTS is deliberately set ONLY in the environment of the
 * test command — never in .env, playwright.config.ts or package.json — so no
 * dev or deployed server ever trusts this certificate:
 *
 *   node scripts/e2e-push-sink-cert.mjs
 *   NODE_EXTRA_CA_CERTS="<printed cert path>" npm run test:e2e -- golden-path --grep-invert @live
 *
 * (PowerShell: $env:NODE_EXTRA_CA_CERTS="<path>"; npm run test:e2e -- ...)
 *
 * The API server must be started BY that command (Playwright's webServer
 * inherits the env) — an already-running `npm run server:dev` without it
 * will fail the push step with a clear message. Files land in the OS temp
 * dir, never in the repo. Idempotent: an existing cert is reused.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PUSH_SINK_DIR = join(tmpdir(), 'shiftsync-e2e-push-sink');
export const PUSH_SINK_CERT = join(PUSH_SINK_DIR, 'cert.pem');
export const PUSH_SINK_KEY = join(PUSH_SINK_DIR, 'key.pem');

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  if (!existsSync(PUSH_SINK_CERT) || !existsSync(PUSH_SINK_KEY)) {
    mkdirSync(PUSH_SINK_DIR, { recursive: true });
    const r = spawnSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30',
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout', PUSH_SINK_KEY, '-out', PUSH_SINK_CERT,
      ],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) {
      console.error('\n[e2e-push-sink-cert] openssl failed or is not on PATH (on Windows it ships with Git for Windows: add "C:\\Program Files\\Git\\usr\\bin" to PATH).');
      process.exit(1);
    }
  }
  console.log(`[e2e-push-sink-cert] certificate: ${PUSH_SINK_CERT}`);
  console.log(`[e2e-push-sink-cert] run with:    NODE_EXTRA_CA_CERTS="${PUSH_SINK_CERT}" npm run test:e2e -- golden-path --grep-invert @live`);
}
