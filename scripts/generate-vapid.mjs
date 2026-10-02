#!/usr/bin/env node
/**
 * Prints a fresh Web Push (VAPID) key pair and where to put it. Stdout only:
 * it never writes a file, reads .env, or calls any API — copy the values
 * into the Railway dashboard yourself. Usage: `npm run vapid:generate`.
 */
import { pathToFileURL } from 'node:url';
import webpush from 'web-push';

export function formatVapidInstructions({ publicKey, privateKey }) {
  return [
    'Fresh VAPID key pair (Web Push). Shown once — nothing was saved anywhere.',
    '',
    'Set these three variables on the Railway API service (shiftsync-api → Variables):',
    '',
    `  VAPID_PUBLIC_KEY=${publicKey}`,
    `  VAPID_PRIVATE_KEY=${privateKey}`,
    '  VAPID_SUBJECT=mailto:<an inbox the team actually reads>',
    '',
    'Rules:',
    '  - The PRIVATE key is a secret. Never commit it, never put it in .env.example, docs,',
    '    chat, tickets or screenshots. Paste it only into Railway\'s variable editor.',
    '  - VAPID_SUBJECT must start with "mailto:" or "https:". Anything else (or a typo in',
    '    either key) makes the API log "[push] VAPID config rejected" and run with push off.',
    '  - Vercel needs nothing: the frontend fetches the public key from',
    '    /api/push/vapid-public-key at runtime.',
    '  - Applying the variables redeploys the API (about 3 minutes of downtime while the',
    '    uploads volume moves to the new container). Check the deploy log: the line',
    '    "[push] ... push notifications are disabled" must NOT appear.',
    '  - Rotating (replacing) this pair later invalidates every existing browser',
    '    subscription: everyone has to turn notifications off and on again on each device.',
    '    Generate once per environment and keep the pair until it is compromised.',
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(formatVapidInstructions(webpush.generateVAPIDKeys()));
}
