/**
 * npm run eval:roster [-- options]
 *
 * Scores the roster readers and writes a markdown report, over two corpora:
 *  - the original 18-roster corpus (server/eval/roster/corpus/, see generate.ts): the
 *    deterministic path always runs, offline; the vision path runs only where the upload route
 *    would escalate (or on every roster with --vision-all);
 *  - the layout families (families.ts, 36 rosters, generated into out/families): every file
 *    read through the production upload path (parsing/readUpload.ts) with no client weekStart.
 *
 *   --vision=none      legacy: deterministic only (default). Families: no AI configured.
 *   --vision=mock      legacy: a truth echo. Families (their default): truth with perturbations.
 *                      Pipeline checks, NOT a model score.
 *   --vision=recorded  replays answers captured with --record (offline)
 *   --vision=live      the configured provider (Vertex/Gemini), every call through the spend cap
 *                      (withAiBudget); refuses without credentials
 *   --record           with --vision=live, saves each answer (recorded/, or beside the private truth)
 *   --corpus=legacy|families|all   (default all)
 *   --only=A01,B1      families whose id starts with one of these
 *   --now=ISO          the reading's "today" (default: now)
 *   --dev-private      also the private DEV files (SHIFTSYNC_PRIVATE_FIXTURES_DIR) against the
 *                      hand-verified truth in SHIFTSYNC_DEV_TRUTH_DIR — report outside the repo
 *   --price-in=N --price-out=N   USD per 1M input/output tokens, for the cost column
 *   --out=PATH         report path (default server/eval/roster/out/report.md, gitignored)
 *
 * Logs and the report carry roster ids and numbers only — never a name or a phone number.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mapVlmResponseToResult } from '../../src/parsing/parseVision.js';
import { getVisionProvider, MockVisionProvider, type VisionOutput, type VisionProvider } from '../../src/parsing/visionProvider.js';
import { CORPUS_DIR } from './generate.js';
import { runDeterministic } from './pipeline.js';
import { pct, score, totals, truthAsVlmJson, type Score } from './score.js';
import type { Truth } from './spec.js';
import { FAMILY_DIR, generateFamilies, loadFamilies } from './familyCorpus.js';
import { runFamilyEval } from './familyRun.js';
import type { FamilyVisionMode } from './familyPipeline.js';
import { privateFixturesDir } from '../../src/parsing/privateFixtures.js';

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

export interface CliOptions extends EvalOptions {
  out: string;
  /** Which corpora: the original 18-roster corpus, the layout families, or both. */
  corpus: 'legacy' | 'families' | 'all';
  /** The families' AI reader: the --vision mode when given, else the mock. */
  familyVision: FamilyVisionMode;
  /** Also read the private DEV files (SHIFTSYNC_PRIVATE_FIXTURES_DIR) against SHIFTSYNC_DEV_TRUTH_DIR. */
  devPrivate: boolean;
  only: string[];
  now: Date;
}

export function parseArgs(argv: string[]): CliOptions {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const given = get('vision');
  const vision = (given ?? 'none') as Mode;
  if (!['none', 'mock', 'recorded', 'live'].includes(vision)) throw new Error(`--vision must be none|mock|recorded|live`);
  const corpus = (get('corpus') ?? 'all') as CliOptions['corpus'];
  if (!['legacy', 'families', 'all'].includes(corpus)) throw new Error('--corpus must be legacy|families|all');
  const num = (v: string | undefined) => (v === undefined ? null : Number(v));
  return {
    vision,
    visionAll: argv.includes('--vision-all'),
    record: argv.includes('--record'),
    priceIn: num(get('price-in')),
    priceOut: num(get('price-out')),
    out: get('out') ?? join('server', 'eval', 'roster', 'out', 'report.md'),
    corpus,
    familyVision: (given ?? 'mock') as FamilyVisionMode,
    devPrivate: argv.includes('--dev-private'),
    only: (get('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    now: get('now') ? new Date(get('now')!) : new Date(),
  };
}

/** The layout-family corpus (and, with --dev-private, the private DEV files) through the upload path. */
async function runFamilies(opts: CliOptions): Promise<string> {
  if (!loadFamilies().length) {
    console.log('[eval:roster] generating the layout-family corpus (Chromium, about a minute)…');
    await generateFamilies();
  }
  let live: VisionProvider | null = null;
  if (opts.familyVision === 'live') {
    live = getVisionProvider();
    if (!live) throw new Error('--vision=live needs a configured vision provider (GEMINI_VERTEX_PROJECT or GEMINI_API_KEY).');
  }
  const common = { now: opts.now, mode: opts.familyVision, live, record: opts.record, only: opts.only };
  const parts: string[] = [];
  const synthetic = await runFamilyEval({ ...common, dataDir: FAMILY_DIR, truths: loadFamilies(), label: `Layout families (AI reader: ${opts.familyVision})` });
  parts.push(synthetic.markdown);
  if (opts.devPrivate) {
    const truthDir = process.env.SHIFTSYNC_DEV_TRUTH_DIR?.trim();
    if (!truthDir || !existsSync(truthDir)) throw new Error('--dev-private needs SHIFTSYNC_DEV_TRUTH_DIR (hand-verified truth, kept outside the repo).');
    const truths = readdirSync(truthDir).filter((f) => f.endsWith('.truth.json')).sort().map((f) => JSON.parse(readFileSync(join(truthDir, f), 'utf8')));
    // Real names: recordings of the private files stay beside their truth, outside the repo.
    const dev = await runFamilyEval({ ...common, only: [], dataDir: privateFixturesDir(), truths, label: `Private DEV files (AI reader: ${opts.familyVision})`, recordDir: join(truthDir, 'recorded') });
    parts.push(dev.markdown);
  }
  return parts.join('\n');
}

if (process.argv[1] && /run\.ts$/.test(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  // The private files' report names no one, but it is kept beside them, never in the repository.
  if (opts.devPrivate && resolve(opts.out).startsWith(resolve(process.cwd()))) throw new Error('--dev-private: write the report outside the repository (--out=<path>).');
  const sections: string[] = [];
  if (opts.corpus !== 'families') sections.push((await runEval(opts)).markdown);
  if (opts.corpus !== 'legacy') sections.push(await runFamilies(opts));
  const markdown = sections.join('\n');
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, markdown);
  console.log(markdown);
  console.log(`[eval:roster] report written to ${opts.out}`);
}
