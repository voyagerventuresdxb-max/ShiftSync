/**
 * Reads one layout-family file through the production upload path (parsing/readUpload.ts, the
 * same function POST /api/schedules/upload calls): no client weekStart (the server's default),
 * the manager agreed to the AI reader, and the AI reader is
 *  - mock      answers from the truth with perturbations (mockVision.ts) — no network
 *  - none      not configured: what a manager gets without AI
 *  - recorded  replays answers saved by a live run (recorded/<id>/<request>.json) — offline
 *  - live      the configured provider, every call through the spend cap (withAiBudget)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readUploadedRoster } from '../../src/parsing/readUpload.js';
import { memoryReadingCache, type ReadingCache } from '../../src/parsing/readingCache.js';
import { MockVisionProvider, VisionProviderError, type VisionInput, type VisionOutput, type VisionProvider } from '../../src/parsing/visionProvider.js';
import { venueDateOf } from '../../src/lib/venueWeek.js';
import type { FamilyTruth } from './families.js';
import type { ReadingUnderTest } from './familyScore.js';
import { transcriptionAnswer } from './mockVision.js';

export type FamilyVisionMode = 'mock' | 'none' | 'recorded' | 'live';
export const RECORDED_FAMILY_DIR = join('server', 'eval', 'roster', 'recorded', 'families');

export interface PipelineRun {
  reading: ReadingUnderTest | null;
  path: string;
  aiCalls: number;
  ms: number;
  /** Output size of the AI answers (characters), to estimate live output tokens. */
  answerChars: number[];
  error?: string;
  report?: unknown;
}

const MIME: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' };

const requestKey = (input: VisionInput) =>
  `${input.framing === 'columns' ? 'cols-' : ''}${input.focus ? `p${input.focus.page}${input.focus.rows ? `r${input.focus.rows.from}-${input.focus.rows.to ?? 'end'}` : ''}${input.strict ? 's' : ''}` : `all${input.strict ? 's' : ''}`}`;

function providerFor(mode: FamilyVisionMode, truth: FamilyTruth, live: VisionProvider | null, record: boolean, recordDir: string): VisionProvider | null {
  if (mode === 'none') return null;
  if (mode === 'mock') {
    return new MockVisionProvider((input) => ({ raw: transcriptionAnswer(truth, { ...(input.focus ? { focus: input.focus } : {}), ...(input.strict ? { strict: true } : {}), ...(input.framing ? { framing: input.framing } : {}) }), model: 'mock', usage: { promptTokens: null, outputTokens: null } }));
  }
  const dir = join(recordDir, truth.id);
  if (mode === 'recorded') {
    return new MockVisionProvider((input) => {
      const file = join(dir, `${requestKey(input)}.json`);
      // A request never recorded is an AI reader that could not answer (the pipeline reports it, never crashes).
      if (!existsSync(file)) throw new VisionProviderError('No recording for this request.', 'failed');
      return JSON.parse(readFileSync(file, 'utf8')) as VisionOutput;
    }, 'recorded');
  }
  if (!live) return null;
  return {
    name: live.name,
    model: live.model,
    fallbackModel: live.fallbackModel,
    region: live.region,
    async readRoster(input: VisionInput) {
      const out = await live.readRoster(input);
      if (record) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${requestKey(input)}.json`), JSON.stringify(out));
      }
      return out;
    },
  };
}

export async function readLikeUploadRoute(
  data: Buffer,
  truth: FamilyTruth,
  now: Date,
  opts: { mode?: FamilyVisionMode; live?: VisionProvider | null; record?: boolean; recordDir?: string; cache?: ReadingCache } = {},
): Promise<PipelineRun> {
  const started = performance.now();
  const mode = opts.mode ?? 'mock';
  const base = providerFor(mode, truth, opts.live ?? null, !!opts.record, opts.recordDir ?? RECORDED_FAMILY_DIR);
  const answerChars: number[] = [];
  let aiCalls = 0;
  const provider: VisionProvider | null = base && {
    name: base.name,
    model: base.model,
    fallbackModel: base.fallbackModel,
    region: base.region,
    async readRoster(input) {
      aiCalls++;
      const out = await base.readRoster(input);
      answerChars.push(out.raw.length);
      return out;
    },
  };
  const ext = truth.file.split('.').pop()!.toLowerCase();
  const outcome = await readUploadedRoster(
    { buffer: data, mimetype: MIME[ext] ?? 'application/octet-stream', originalname: truth.file, size: data.length },
    {
      locationId: null,
      userId: null,
      today: venueDateOf(now, 'Asia/Dubai'),
      clientWeekStart: null,
      aiConsent: true,
      provider,
      aiBlockedReason: async () => null,
      markAiUsed: async () => {},
      cache: opts.cache ?? memoryReadingCache(),
      deadline: Date.now() + 95_000,
    },
  );
  const ms = Math.round(performance.now() - started);
  if (!outcome.ok) return { reading: null, path: `refused (${String(outcome.body.errorCode ?? outcome.status)})`, aiCalls, ms, answerChars, error: String(outcome.body.errorCode ?? '') };
  const { result, reading } = outcome;
  return {
    reading: {
      rows: result.rows,
      leaveRecords: result.leaveRecords,
      anomalies: result.anomalies,
      people: result.people ?? [],
      unreadRows: result.unreadRows ?? [],
      weekStart: result.week.weekStart,
    },
    path: `ai=${reading.ai} table=${reading.table}${reading.rereadPages.length ? ` reread=${reading.rereadPages.join(',')}` : ''}${reading.disagreements ? ` disagree=${reading.disagreements}` : ''}`,
    aiCalls,
    ms,
    answerChars,
    report: reading,
  };
}
