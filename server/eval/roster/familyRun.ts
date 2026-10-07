/**
 * The layout-family eval: every file in a family directory (generated synthetic corpus, or the
 * private DEV files with hand-verified truth kept outside the repo) read through the production
 * upload path, scored per roster and per family. Reports carry ids and numbers only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FamilyTruth } from './families.js';
import { familyTotals, percentile, pct1, scoreFamily, type FamilyScore } from './familyScore.js';
import { readLikeUploadRoute, type FamilyVisionMode } from './familyPipeline.js';
import type { VisionProvider } from '../../src/parsing/visionProvider.js';

export interface FamilyRow {
  id: string;
  family: string;
  format: string;
  path: string;
  ms: number;
  aiCalls: number;
  score: FamilyScore;
  /** Largest AI answer of the file, in characters (about 3.6 per output token). */
  maxAnswerChars: number;
}

export interface FamilyEvalOptions {
  /** Where `<file>` and `<id>.truth.json` live (truth files may sit in a separate directory). */
  dataDir: string;
  truths: FamilyTruth[];
  now: Date;
  label: string;
  mode?: FamilyVisionMode;
  live?: VisionProvider | null;
  record?: boolean;
  /** Where live answers are saved / recorded answers are read (default recorded/families in the repo). */
  recordDir?: string;
  /** Only these roster ids (prefix match). */
  only?: string[];
}

export async function runFamilyEval(o: FamilyEvalOptions): Promise<{ rows: FamilyRow[]; markdown: string }> {
  const rows: FamilyRow[] = [];
  for (const truth of o.truths) {
    const path = join(o.dataDir, truth.file);
    if (!existsSync(path)) continue;
    if (o.only?.length && !o.only.some((p) => truth.id.startsWith(p))) continue;
    const run = await readLikeUploadRoute(readFileSync(path), truth, o.now, { mode: o.mode ?? 'mock', live: o.live ?? null, record: !!o.record, ...(o.recordDir ? { recordDir: o.recordDir } : {}) });
    rows.push({ id: truth.id, family: truth.family, format: truth.format, path: run.path, ms: run.ms, aiCalls: run.aiCalls, score: scoreFamily(run.reading, truth), maxAnswerChars: Math.max(0, ...run.answerChars) });
  }
  return { rows, markdown: familyMarkdown(rows, o) };
}

const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;

export function familyMarkdown(rows: FamilyRow[], o: Pick<FamilyEvalOptions, 'label' | 'now'>): string {
  const out: string[] = [`## ${o.label}`, '', `Reading as of ${o.now.toISOString().slice(0, 10)} (the production default: no client weekStart).`, ''];
  const answers = rows.filter((r) => r.maxAnswerChars > 0);
  if (answers.length) out.push(`Largest AI answer per file: p50 ≈ ${Math.round(percentile(answers.map((r) => r.maxAnswerChars), 50) / 3.6)} / max ≈ ${Math.round(Math.max(...answers.map((r) => r.maxAnswerChars)) / 3.6)} output tokens (≈3.6 characters a token; cap 16,384).`, '');
  const families = [...new Set(rows.map((r) => r.family))].sort();
  out.push(line(['family', 'rosters', 'staff recall', 'staff exact', 'staff precision', 'shift recall', 'exact time', 'saved exact', 'exact or shown', 'role', 'week', 'flagged', 'silent people', 'silent shifts', 'shifts shown to check', 'silent wrong times', 'silent misspelt names', 'wrong times saved', 'wrong day saved', 'extra shifts', 'rows flagged', 'p50 ms', 'p95 ms']));
  out.push(line(Array(23).fill('---')));
  for (const f of families) {
    const fr = rows.filter((r) => r.family === f);
    const t = familyTotals(fr.map((r) => r.score));
    const ms = fr.map((r) => r.ms);
    out.push(line([f, fr.length, pct1(t.staffRecall), pct1(t.staffExact), pct1(t.staffPrecision), pct1(t.shiftRecall), pct1(t.exactTime), pct1({ ok: t.exactTime.ok, of: t.shiftRecall.ok }), pct1({ ok: t.exactTime.ok + t.surfacedShifts, of: t.exactTime.of }), pct1(t.role), `${t.week.ok}/${t.week.of}`, pct1(t.flagged), t.silentPeople, t.silentShifts, t.surfacedShifts, t.silentTimeErrors, t.silentNameErrors, t.wrongSaved, t.wrongDay, t.extraShifts, pct1(t.flaggedRows), percentile(ms, 50), percentile(ms, 95)]));
  }
  out.push('', line(['roster', 'format', 'path', 'AI calls', 'ms', 'staff', 'precision', 'shifts', 'exact', 'role', 'week', 'silent p/s/t', 'to check', 'extra', 'wrong day', 'rows flagged']));
  out.push(line(Array(16).fill('---')));
  for (const r of rows) {
    const s = r.score;
    out.push(line([r.id, r.format, r.path, r.aiCalls, r.ms, `${s.staffRecall.ok}/${s.staffRecall.of}`, pct1(s.staffPrecision), `${s.shiftRecall.ok}/${s.shiftRecall.of}`, `${s.exactTime.ok}/${s.exactTime.of}`, pct1(s.role), s.week.ok ? 'ok' : 'WRONG', `${s.silentPeople}/${s.silentShifts}/${s.silentTimeErrors}`, s.surfacedShifts, s.extraShifts, s.wrongDay, `${s.flaggedRows.ok}/${s.flaggedRows.of}`]));
  }
  return `${out.join('\n')}\n`;
}
