import Tesseract from 'tesseract.js';
import { readFileSync } from 'node:fs';

const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms));

const targets = [
  'server/test-fixtures/rendered-page-1.png',
  'server/test-fixtures/real-roster.png',
];

const worker = await Promise.race([
  Tesseract.createWorker('eng', 1, { langPath: process.cwd() }),
  timeout(30000),
]);
console.log('[verify] worker created');

for (const t of targets) {
  const buf = readFileSync(t);
  console.log(`[verify] ${t}: ${Math.round(buf.length / 1024)}KB`);
  const result = await Promise.race([
    worker.recognize(buf),
    timeout(60000),
  ]);
  const data = (result as any).data;
  const words = data.words ?? [];
  console.log(`[verify]   -> ${words.length} words, text="${(data.text ?? '').slice(0, 60)}"`);
}

await worker.terminate();
