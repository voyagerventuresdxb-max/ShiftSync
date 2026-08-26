/**
 * Local Docling table-extraction sidecar client — tried before the Ollama
 * vision fallback, but ONLY on the no-text-layer PDF path.
 *
 * Scope note (deliberately narrow — see server/docling-sidecar/*.py verify
 * scripts and the accompanying report): Docling was evaluated against both
 * permanent test fixtures. On the text-layer, borderless-grid PDF
 * (Gattopardo), its layout model never detected a Table region at all —
 * every cell came back as unstructured `text`, strictly worse than the
 * existing deterministic pdfjs parser. On the scanned, no-text-layer PDF
 * (Bar des Pres), it correctly detected and structured the table (22x9,
 * including hyphen-chain and slash-segmented shift codes) in ~47s versus
 * Ollama's 10+ minutes. So this client is wired ONLY into the
 * !hasPdfTextLayer branch in schedules.ts, ahead of Ollama — the
 * deterministic-parser-fails path for text-layer PDFs/Excel is untouched
 * and still goes straight to Ollama.
 *
 * The sidecar (server/docling-sidecar/service.py) does structure extraction
 * only — it returns a merge-expanded 2D grid of cell text, the same shape
 * buildMergeExpandedGrid() produces for Excel's !merges. All shift/role/
 * leave-code semantics stay in the existing TypeScript grid interpreter
 * (parseExcelGrid) — no logic is duplicated on the Python side.
 *
 * Runs fully local: no external API key, no third-party network call, no
 * roster data leaving the venue's own machine. Requires the sidecar process
 * to be started separately (npm run docling:sidecar) — if it isn't running,
 * `isDoclingAvailable`/`extractGridViaDocling` fail fast and the caller
 * falls through to Ollama, exactly like an unreachable Ollama host today.
 */
import { parseExcelGrid } from './deterministicGridParser.js';
import type { ParsedVisionResult } from './types.js';

const DOCLING_HOST = process.env.DOCLING_SIDECAR_HOST || 'http://127.0.0.1:8901';
// Table-structure inference (TableFormer, ACCURATE mode) on a full-page
// scan measured ~47s warm-cache on the reference fixture. 90s gives that
// headroom without hanging as long as the 10-minute Ollama timeout when the
// sidecar is simply down (the connect-level failure below is much faster).
const DOCLING_TIMEOUT_MS = Number(process.env.DOCLING_TIMEOUT_MS) || 90_000;
const DOCLING_CONNECT_TIMEOUT_MS = 3_000;

export class DoclingUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DoclingUnavailableError';
  }
}

interface ConvertResponse {
  numTables: number;
  grid: string[][] | null;
}

/**
 * Cheap reachability check (short connect timeout) so the caller can decide
 * to skip straight to Ollama without waiting out a full conversion timeout
 * when the sidecar was never started.
 */
export async function isDoclingAvailable(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOCLING_CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${DOCLING_HOST}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sends a PDF buffer to the Docling sidecar and returns its merge-expanded
 * grid, or `null` if Docling ran successfully but found no table region
 * (the expected outcome for inputs its layout model can't structure —
 * the caller should fall through to Ollama, not treat this as an error).
 * Throws `DoclingUnavailableError` if the sidecar can't be reached at all
 * or the request fails/times out.
 */
export async function extractGridViaDocling(pdfBuffer: Buffer, fileName: string): Promise<string[][] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOCLING_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' }), fileName);

    const response = await fetch(`${DOCLING_HOST}/convert`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new DoclingUnavailableError(`Docling sidecar request failed (${response.status}): ${text || response.statusText}`);
    }
    const data = (await response.json()) as ConvertResponse;
    return data.numTables > 0 ? data.grid : null;
  } catch (err) {
    if (err instanceof DoclingUnavailableError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DoclingUnavailableError(`Docling sidecar request timed out after ${DOCLING_TIMEOUT_MS}ms.`, err);
    }
    throw new DoclingUnavailableError(
      `Could not reach Docling sidecar at ${DOCLING_HOST} (is "npm run docling:sidecar" running?): ${(err as Error).message}`,
      err,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Full no-text-layer-PDF attempt: reachability check, convert, then run the
 * resulting grid through the same interpreter the Excel/text-layer-PDF
 * paths use. Returns `null` when Docling is unavailable or found no table —
 * both cases mean "fall through to Ollama" to the caller in schedules.ts.
 */
export async function parseScannedPdfViaDocling(
  pdfBuffer: Buffer,
  fileName: string,
  weekStart: string,
): Promise<ParsedVisionResult | null> {
  if (!(await isDoclingAvailable())) return null;
  const grid = await extractGridViaDocling(pdfBuffer, fileName);
  if (!grid) return null;
  return parseExcelGrid(grid, weekStart);
}
