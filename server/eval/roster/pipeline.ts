import { buildMergeExpandedGrid, gridToTsvText, parseWorkbookBuffer, TemplateDetectionError } from '../../src/parsing/parseWorkbook.js';
import { parseExcelGrid, RosterExtractionAnomalyError } from '../../src/parsing/deterministicGridParser.js';
import { processRowsIntoRoster } from '../../src/parsing/deterministicParser.js';
import { extractPdfGrid, hasPdfTextLayer } from '../../src/parsing/pdfTableExtractor.js';
import { deterministicEscalationReason, type EscalationReason } from '../../src/parsing/escalation.js';
import type { ParsedVisionResult } from '../../src/parsing/types.js';
import type { VisionInput } from '../../src/parsing/visionProvider.js';

export interface DeterministicRun {
  /** What a manager gets with no AI reader (null: nothing usable). */
  result: ParsedVisionResult | null;
  /** Which path produced it (for the report). */
  path: string;
  /** Why the upload route would escalate to the AI reader, or null. */
  escalation: EscalationReason | null;
  ms: number;
  /** What would be sent to the vision provider if escalated. */
  visionInput: VisionInput | null;
}

const empty = (label: string): ParsedVisionResult => ({ templateLabel: label, rows: [], issues: [], anomalies: [], leaveRecords: [], legend: [] });

/**
 * The upload route's deterministic decisions (server/src/routes/schedules.ts), without the
 * database, consent or network: template → grid parser → escalation rules. When the grid parser
 * doesn't recognise the shape, the no-AI result is the local fallback the route would use.
 */
export async function runDeterministic(data: Buffer, file: string, weekStart: string): Promise<DeterministicRun> {
  const started = performance.now();
  const done = (r: Omit<DeterministicRun, 'ms'>): DeterministicRun => ({ ...r, ms: Math.round(performance.now() - started) });

  if (/\.(png|jpe?g|webp|gif)$/i.test(file)) {
    return done({ result: null, path: 'image', escalation: 'image_or_scan', visionInput: { kind: 'file', data, mimeType: 'image/png', originalFilename: file, weekStart } });
  }
  if (/\.pdf$/i.test(file)) {
    const pdfInput: VisionInput = { kind: 'file', data, mimeType: 'application/pdf', originalFilename: file, weekStart };
    if (!(await hasPdfTextLayer(data))) return done({ result: null, path: 'scanned pdf', escalation: 'image_or_scan', visionInput: pdfInput });
    try {
      const r = parseExcelGrid(await extractPdfGrid(data), weekStart);
      if (r.templateLabel !== 'Deterministic Grid Parser') return done({ result: null, path: 'pdf (unrecognised)', escalation: 'unrecognized_layout', visionInput: pdfInput });
      return done({ result: r, path: 'pdf grid', escalation: deterministicEscalationReason(r), visionInput: pdfInput });
    } catch (err) {
      if (err instanceof RosterExtractionAnomalyError) return done({ result: null, path: 'pdf grid (data-loss)', escalation: 'extraction_anomaly', visionInput: pdfInput });
      throw err;
    }
  }
  try {
    const t = parseWorkbookBuffer(data, file);
    return done({ result: { ...empty(t.templateLabel ?? 'template'), rows: t.rows, issues: t.issues }, path: 'template', escalation: null, visionInput: null });
  } catch (err) {
    if (!(err instanceof TemplateDetectionError)) throw err;
  }
  const grid = buildMergeExpandedGrid(data, file);
  const gridInput: VisionInput = { kind: 'grid', text: gridToTsvText(grid), originalFilename: file, weekStart };
  try {
    const r = parseExcelGrid(grid, weekStart);
    if (r.templateLabel !== 'Deterministic Grid Parser') {
      return done({ result: processRowsIntoRoster(grid, weekStart), path: 'local fallback (unrecognised grid)', escalation: 'unrecognized_layout', visionInput: gridInput });
    }
    return done({ result: r, path: 'grid', escalation: deterministicEscalationReason(r), visionInput: gridInput });
  } catch (err) {
    if (err instanceof RosterExtractionAnomalyError) return done({ result: null, path: 'grid (data-loss)', escalation: 'extraction_anomaly', visionInput: gridInput });
    throw err;
  }
}
