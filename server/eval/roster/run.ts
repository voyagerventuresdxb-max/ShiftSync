/**
 * npm run eval:roster [-- options]
 *
 * Scores the roster parsers against the eval corpus (server/eval/roster/corpus/, see generate.ts)
 * and writes a markdown report. The deterministic path always runs, offline. The vision path
 * runs only where the upload route would escalate (or on every roster with --vision-all):
 *
 *   --vision=none      (default) deterministic only
 *   --vision=mock      a MockVisionProvider that answers with the truth — checks the pipeline
 *                      and the scorer, NOT a model score
 *   --vision=recorded  replays server/eval/roster/recorded/<id>.json (captured with --record)
 *   --vision=live      the configured provider (Vertex/Gemini); refuses without credentials
 *   --record           with --vision=live, saves each answer to recorded/<id>.json
 *   --price-in=N --price-out=N   USD per 1M input/output tokens, for the cost column
 *   --out=PATH         report path (default server/eval/roster/out/report.md, gitignored)
 *
 * Logs and the report carry roster ids and numbers only — never a name or a phone number.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mapVlmResponseToResult } from '../../src/parsing/parseVision.js';
import { getVisionProvider, MockVisionProvider, type VisionOutput, type VisionProvider } from '../../src/parsing/visionProvider.js';
import { CORPUS_DIR } from './generate.js';
import { runDeterministic } from './pipeline.js';
import { pct, score, totals, truthAsVlmJson, type Score } from './score.js';
import type { Truth } from './spec.js';

type Mode = 'none' | 'mock' | 'recorded' | 'live';
const RECORDED_DIR = join('server', 'eval', 'roster', 'recorded');

export interface EvalOptions {
  vision: Mode;
  visionAll: boolean;
  record: boolean;
  priceIn: number | null;
  priceOut: number | null;
}

interface VisionRow {
  id: string;
  model: string;
  ms: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  score: Score | null;
  note: string;
}

export interface EvalReport {
  markdown: string;
  deterministic: { id: string; path: string; escalation: string | null; expected: string | null; ms: number; score: Score }[];
  vision: VisionRow[];
}

function loadCorpus(): (Truth & { file: string; expectEscalation: string | null; tags: string[] })[] {
  if (!existsSync(CORPUS_DIR)) throw new Error(`no corpus at ${CORPUS_DIR} — run npm run eval:roster:generate`);
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.truth.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')));
}

function cost(tokensIn: number | null, tokensOut: number | null, o: EvalOptions): number | null {
  if (o.priceIn === null || o.priceOut === null || tokensIn === null || tokensOut === null) return null;
  return (tokensIn * o.priceIn + tokensOut * o.priceOut) / 1_000_000;
}

const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;

export async function runEval(o: EvalOptions): Promise<EvalReport> {
  const corpus = loadCorpus();
  const deterministic: EvalReport['deterministic'] = [];
  const vision: VisionRow[] = [];

  let provider: VisionProvider | null = null;
  if (o.vision === 'live') {
    provider = getVisionProvider();
    if (!provider) throw new Error('--vision=live needs a configured vision provider (GEMINI_VERTEX_PROJECT or GEMINI_API_KEY).');
  }

  for (const truth of corpus) {
    const data = readFileSync(join(CORPUS_DIR, truth.file));
    const run = await runDeterministic(data, truth.file, truth.weekStart);
    deterministic.push({ id: truth.id, path: run.path, escalation: run.escalation, expected: truth.expectEscalation, ms: run.ms, score: score(run.result, truth) });

    if (o.vision === 'none' || !run.visionInput || (!run.escalation && !o.visionAll)) continue;
    let output: (VisionOutput & { ms: number | null }) | null = null;
    let note = '';
    try {
      if (o.vision === 'mock') {
        const mock = new MockVisionProvider(truthAsVlmJson(truth), 'mock (truth echo)');
        output = { ...(await mock.readRoster(run.visionInput)), ms: null };
        note = 'pipeline check only — echoes the truth';
      } else if (o.vision === 'recorded') {
        const file = join(RECORDED_DIR, `${truth.id}.json`);
        if (existsSync(file)) output = JSON.parse(readFileSync(file, 'utf8'));
        else note = 'no recording';
      } else {
        const started = performance.now();
        const answer = await provider!.readRoster(run.visionInput);
        output = { ...answer, ms: Math.round(performance.now() - started) };
        if (o.record) {
          mkdirSync(RECORDED_DIR, { recursive: true });
          writeFileSync(join(RECORDED_DIR, `${truth.id}.json`), JSON.stringify(output));
        }
      }
    } catch (err) {
      note = `provider error (${(err as { kind?: string }).kind ?? 'error'})`;
    }
    const scored = output ? score(mapVlmResponseToResult(JSON.parse(output.raw), truth.weekStart), truth) : null;
    vision.push({
      id: truth.id,
      model: output?.model ?? '—',
      ms: output?.ms ?? null,
      tokensIn: output?.usage.promptTokens ?? null,
      tokensOut: output?.usage.outputTokens ?? null,
      costUsd: output ? cost(output.usage.promptTokens, output.usage.outputTokens, o) : null,
      score: scored,
      note,
    });
  }

  const det = totals(deterministic.map((d) => d.score));
  const escalated = deterministic.filter((d) => d.escalation).length;
  const escalationAgrees = deterministic.filter((d) => (d.escalation ?? null) === (d.expected ?? null)).length;
  const lines: string[] = [
    `# Roster parser eval — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Corpus: ${corpus.length} synthetic rosters (server/eval/roster/corpus). Vision mode: \`${o.vision}\`${o.visionAll ? ' (every roster)' : ' (escalated rosters only)'}.`,
    '',
    '## Deterministic path (no AI)',
    '',
    row(['field', 'accuracy', 'count']),
    row(['---', '---', '---']),
    ...(['name', 'day', 'start', 'end', 'role', 'leave', 'flagged'] as const).map((k) => row([k, pct(det[k]), `${det[k].ok}/${det[k].of}`])),
    row(['extra shifts (not in truth)', '', det.extraShifts]),
    '',
    `Escalation rate: **${escalated}/${corpus.length}** rosters would go to the AI reader (with consent). Rules agree with the expected escalation on ${escalationAgrees}/${corpus.length}.`,
    '',
    row(['roster', 'path', 'escalation (expected)', 'ms', 'name', 'day', 'start', 'end', 'role', 'leave', 'flagged', 'extra']),
    row(Array(12).fill('---')),
    ...deterministic.map((d) =>
      row([d.id, d.path, `${d.escalation ?? '—'} (${d.expected ?? '—'})`, d.ms, pct(d.score.name), pct(d.score.day), pct(d.score.start), pct(d.score.end), pct(d.score.role), pct(d.score.leave), pct(d.score.flagged), d.score.extraShifts]),
    ),
  ];
  if (o.vision !== 'none') {
    const scored = vision.filter((v) => v.score).map((v) => v.score!);
    const vt = scored.length ? totals(scored) : null;
    const withCost = vision.filter((v) => v.costUsd !== null);
    lines.push(
      '',
      '## Vision path',
      '',
      vt ? `Totals over ${scored.length} roster(s): day ${pct(vt.day)}, start ${pct(vt.start)}, end ${pct(vt.end)}, role ${pct(vt.role)}, leave ${pct(vt.leave)}, extra shifts ${vt.extraShifts}.` : 'No vision results.',
      withCost.length ? `Estimated cost per roster: $${(withCost.reduce((a, v) => a + v.costUsd!, 0) / withCost.length).toFixed(5)} (prices given on the command line).` : 'Cost: n/a (pass --price-in / --price-out, USD per 1M tokens, with live or recorded token counts).',
      '',
      row(['roster', 'model', 'latency ms', 'tokens in', 'tokens out', 'cost USD', 'day', 'start', 'end', 'role', 'leave', 'note']),
      row(Array(12).fill('---')),
      ...vision.map((v) =>
        row([v.id, v.model, v.ms ?? '—', v.tokensIn ?? '—', v.tokensOut ?? '—', v.costUsd === null ? '—' : v.costUsd.toFixed(5), v.score ? pct(v.score.day) : '—', v.score ? pct(v.score.start) : '—', v.score ? pct(v.score.end) : '—', v.score ? pct(v.score.role) : '—', v.score ? pct(v.score.leave) : '—', v.note || '']),
      ),
    );
  }
  return { markdown: `${lines.join('\n')}\n`, deterministic, vision };
}

export function parseArgs(argv: string[]): EvalOptions & { out: string } {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const vision = (get('vision') ?? 'none') as Mode;
  if (!['none', 'mock', 'recorded', 'live'].includes(vision)) throw new Error(`--vision must be none|mock|recorded|live`);
  const num = (v: string | undefined) => (v === undefined ? null : Number(v));
  return {
    vision,
    visionAll: argv.includes('--vision-all'),
    record: argv.includes('--record'),
    priceIn: num(get('price-in')),
    priceOut: num(get('price-out')),
    out: get('out') ?? join('server', 'eval', 'roster', 'out', 'report.md'),
  };
}

if (process.argv[1] && /run\.ts$/.test(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runEval(opts);
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, report.markdown);
  console.log(report.markdown);
  console.log(`[eval:roster] report written to ${opts.out}`);
}
