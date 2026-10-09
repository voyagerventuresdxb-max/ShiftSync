/**
 * Live voice eval against the real AI provider, through the real local API and the local
 * spend cap. Hard spend ceiling across every run (EVAL_SPEND_CEILING_USD, default 1.50):
 * the running estimated spend lives in EVAL_SPEND_LOG (a private file, one JSON line per
 * call); a call whose worst case could cross the ceiling is never started, and the in-process
 * monthly budget is capped at the remaining amount as a second stop.
 *
 *   tsx server/eval/voice/live.ts text  <case ids | sample>
 *   tsx server/eval/voice/live.ts audio <manifest.json>
 *
 * Results (per case, private) go to EVAL_OUT_DIR. Requires a configured AI backend in the
 * environment (e.g. Vertex via Application Default Credentials). Local database only.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { issueSession } from '../../src/lib/identity.js';
import { aiBudgetConfig, budgetKeys, costUsd, MAX_OUTPUT_TOKENS } from '../../src/lib/aiBudget.js';
import { parseIntentRateLimiter, transcribeRateLimiter } from '../../src/middleware/rateLimit.js';
import { checkDatabaseHost } from '../../src/lib/testVenueCleanup.js';
import { describeVoiceConfig } from '../../src/lib/aiConfig.js';
import type { ParsedIntent } from '../../src/voice/intentSchema.js';
import { CORPUS, type VoiceCase } from './corpus.js';
import { MATRIX, expandText } from './matrix.js';
import { cleanupFixture, seedFixture, snapshot, type Fixture } from './fixture.js';
import { CALLER, scoreCase, type CaseScore } from './score.js';
import { wordErrorRate } from './wer.js';

const CEILING = Number(process.env.EVAL_SPEND_CEILING_USD ?? '1.50');
const SPEND_LOG = process.env.EVAL_SPEND_LOG ?? '';
const OUT_DIR = process.env.EVAL_OUT_DIR ?? '';

if (!SPEND_LOG || !OUT_DIR) throw new Error('Set EVAL_SPEND_LOG and EVAL_OUT_DIR (private paths outside the repo).');
const host = checkDatabaseHost(process.env.DATABASE_URL);
if (!host.ok || host.production) throw new Error('The live eval runs against a local database only.');
mkdirSync(OUT_DIR, { recursive: true });

function spentSoFar(): number {
  if (!existsSync(SPEND_LOG)) return 0;
  const lines = readFileSync(SPEND_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? Number(JSON.parse(lines[lines.length - 1]!).cumulativeUsd) : 0;
}

const prisma = new PrismaClient();
const config = aiBudgetConfig();
/** Worst case of one call of this feature, with a generous input allowance. */
const worst = (feature: 'voice_transcribe' | 'voice_intent', inputTokens: number) => costUsd(inputTokens, MAX_OUTPUT_TOKENS[feature], config);

async function monthSpend(): Promise<number> {
  const row = await prisma.aiSpendMonth.findUnique({ where: { month: budgetKeys(new Date()).month } });
  return Number(row?.spentUsd ?? 0) + Number(row?.reservedUsd ?? 0);
}

class CeilingReached extends Error {}

/** Runs one live call, refusing to start it when its worst case could cross the ceiling; logs the settled cost. */
async function guarded<T>(kind: string, caseId: string, worstCase: number, call: () => Promise<T>): Promise<{ value: T; usd: number; ms: number }> {
  const before = spentSoFar();
  if (before + worstCase > CEILING) throw new CeilingReached(`ceiling: ${before.toFixed(4)} spent + ${worstCase.toFixed(4)} worst case > ${CEILING}`);
  process.env.AI_MONTHLY_BUDGET_USD = String((await monthSpend()) + (CEILING - before));
  const ledgerBefore = await monthSpend();
  const started = Date.now();
  const value = await call();
  const ms = Date.now() - started;
  const usd = Math.max(0, (await monthSpend()) - ledgerBefore);
  appendFileSync(SPEND_LOG, `${JSON.stringify({ at: new Date().toISOString(), kind, caseId, usd: Number(usd.toFixed(6)), cumulativeUsd: Number((before + usd).toFixed(6)) })}\n`);
  return { value, usd, ms };
}

let base = '';
async function token(fx: Fixture, role: VoiceCase['role']): Promise<string> {
  const userId = fx.users[CALLER[role]];
  parseIntentRateLimiter.resetKey(userId);
  transcribeRateLimiter.resetKey(userId);
  return (await issueSession(userId)).plainToken;
}

async function parseIntent(tok: string, transcript: string): Promise<{ status: number; intent?: ParsedIntent; hasAdditionalRequest?: boolean; error?: string }> {
  const res = await fetch(`${base}/api/voice/parse-intent`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ transcript }) });
  const body = (await res.json()) as { intent?: ParsedIntent; hasAdditionalRequest?: boolean; error?: string };
  return { status: res.status, ...body };
}

async function transcribe(tok: string, wav: Buffer): Promise<{ status: number; transcript?: string; error?: string }> {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'clip.wav');
  const res = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: form });
  return { status: res.status, ...((await res.json()) as { transcript?: string; error?: string }) };
}

interface Row {
  caseId: string;
  category: string;
  role: string;
  expected: string;
  got: string;
  score: CaseScore | null;
  falseExecution: boolean;
  parseMs: number;
  parseUsd: number;
  error?: string;
  /** For UNRECOGNIZED: why (the model's or the propose-time check's reason). */
  reason?: string;
  /** What the confirm sheet would have shown (made-up data; private results only). */
  response?: ParsedIntent;
  clip?: { clipId: string; voice: string; snr: string; transcript: string; wer: number; transcribeMs: number; transcribeUsd: number };
}

async function runCase(fx: Fixture, c: VoiceCase, transcriptOverride?: string): Promise<Row> {
  const tok = await token(fx, c.role);
  const transcript = transcriptOverride ?? expandText(fx.today, c.text);
  const before = await snapshot(prisma, [fx.locationId, fx.otherLocationId]);
  const { value, usd, ms } = await guarded('parse', c.id, worst('voice_intent', 6_000), () => parseIntent(tok, transcript));
  const after = await snapshot(prisma, [fx.locationId, fx.otherLocationId]);
  const expected = c.expect.outcome === 'intent' ? c.expect.intent : c.expect.outcome;
  if (value.status !== 200 || !value.intent) {
    return { caseId: c.id, category: c.category, role: c.role, expected, got: `HTTP ${value.status}`, score: null, falseExecution: before !== after, parseMs: ms, parseUsd: usd, error: value.error };
  }
  return {
    caseId: c.id,
    category: c.category,
    role: c.role,
    expected,
    got: value.intent.intent,
    score: scoreCase(fx, c, value.intent, value.hasAdditionalRequest ?? false, CALLER[c.role], transcript),
    response: value.intent,
    falseExecution: before !== after,
    parseMs: ms,
    parseUsd: usd,
    reason: value.intent.intent === 'UNRECOGNIZED' ? value.intent.reason : undefined,
  };
}

function selectCases(spec: string): VoiceCase[] {
  // The Run 16 command matrix (matrix.ts): all of it, or from a case id on (matrix:m050).
  if (spec === 'matrix' || spec.startsWith('matrix:')) return MATRIX.filter((c) => !spec.includes(':') || c.id >= spec.slice(7));
  if (spec.startsWith('sample:')) {
    // sample:<per intent> — that many positive cases per intent (spread across the list), every
    // safety negative (role, injection, cross-venue, silence, non-English, compound), and two of
    // each other negative kind. Sized to the live spend ceiling.
    const per = Number(spec.slice(7));
    const safety = new Set(['wrong-role', 'injection', 'cross-venue', 'empty', 'non-english', 'compound']);
    const picked: VoiceCase[] = [];
    const byIntent = new Map<string, VoiceCase[]>();
    const otherNegatives = new Map<string, VoiceCase[]>();
    for (const c of CORPUS) {
      if (safety.has(c.category)) picked.push(c);
      else if (c.expect.outcome === 'intent') byIntent.set(c.expect.intent, [...(byIntent.get(c.expect.intent) ?? []), c]);
      else otherNegatives.set(c.category, [...(otherNegatives.get(c.category) ?? []), c]);
    }
    for (const cases of byIntent.values()) picked.push(...cases.filter((_, i) => i % Math.max(1, Math.floor(cases.length / per)) === 0).slice(0, per));
    for (const cases of otherNegatives.values()) picked.push(...cases.slice(0, 2));
    return picked;
  }
  const ids = new Set(spec.split(','));
  return [...CORPUS, ...MATRIX].filter((c) => ids.has(c.id));
}

async function main() {
  const [mode, arg = ''] = process.argv.slice(2);
  if (mode !== 'text' && mode !== 'audio') throw new Error('mode must be text or audio');
  console.log(`[voice-eval] ${describeVoiceConfig()}; ceiling USD ${CEILING}; spent so far USD ${spentSoFar().toFixed(4)}`);
  const fx = await seedFixture(prisma);
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rows: Row[] = [];
  const outFile = join(OUT_DIR, `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  try {
    if (mode === 'text') {
      for (const c of selectCases(arg)) {
        const row = await runCase(fx, c);
        rows.push(row);
        appendFileSync(outFile, `${JSON.stringify({ ...row, text: expandText(fx.today, c.text) })}\n`);
        console.log(`${row.caseId} ${row.score?.ok ? 'ok ' : 'MISS'} ${row.expected} → ${row.got} ${row.parseMs}ms $${row.parseUsd.toFixed(4)}`);
      }
    } else {
      const manifest = JSON.parse(readFileSync(arg, 'utf8')) as { clipId: string; file: string; caseId: string; voice: string; snr: string }[];
      for (const clip of manifest) {
        const c = [...CORPUS, ...MATRIX].find((x) => x.id === clip.caseId)!;
        const tok = await token(fx, c.role);
        const t = await guarded('transcribe', clip.clipId, worst('voice_transcribe', 4_000), () => transcribe(tok, readFileSync(clip.file)));
        const transcript = t.value.transcript ?? '';
        const row: Row = t.value.status === 200
          ? await runCase(fx, c, transcript)
          : { caseId: c.id, category: c.category, role: c.role, expected: 'n/a', got: `transcribe HTTP ${t.value.status}`, score: null, falseExecution: false, parseMs: 0, parseUsd: 0, error: t.value.error };
        row.clip = { clipId: clip.clipId, voice: clip.voice, snr: clip.snr, transcript, wer: wordErrorRate(c.text, transcript), transcribeMs: t.ms, transcribeUsd: t.usd };
        rows.push(row);
        appendFileSync(outFile, `${JSON.stringify({ ...row, text: c.text })}\n`);
        console.log(`${clip.clipId} wer=${row.clip.wer.toFixed(2)} ${row.score?.ok ? 'ok ' : 'MISS'} ${row.expected} → ${row.got} ${t.ms}+${row.parseMs}ms`);
      }
    }
  } catch (err) {
    if (err instanceof CeilingReached) console.log(`[voice-eval] STOPPED: ${err.message}`);
    else throw err;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await cleanupFixture(prisma, fx);
    await prisma.$disconnect();
  }
  writeFileSync(`${outFile}.done`, '');
  console.log(`[voice-eval] ${rows.length} cases; spent so far USD ${spentSoFar().toFixed(4)}; results in the private output folder`);
}

main().catch((err) => {
  console.error('[voice-eval] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
