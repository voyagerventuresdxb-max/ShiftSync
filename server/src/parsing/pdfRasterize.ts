/**
 * PDF page rasterization — renders a PDF page to a real PNG image, for the
 * Ollama vision fallback path only.
 *
 * Root cause this fixes: `parseVisionOllama.ts` base64-encodes whatever
 * buffer it's handed and sends it to Ollama's vision API assuming it's
 * already an image. That's true for a direct image upload (isImage(req.file)
 * in schedules.ts), but false for a scanned/no-text-layer PDF that reaches
 * the Ollama fallback (e.g. after Docling also finds no table) — there the
 * buffer is still the original PDF file. Ollama's image loader can't decode
 * PDF container bytes as pixels and rejects them with "Failed to load image
 * or audio file" — confirmed by reproducing the exact failure directly
 * against Ollama's API outside this app, and by confirming a real rasterized
 * PNG of the same page is accepted instead.
 *
 * Implementation note (why this shells out to Python instead of staying
 * pure Node): the first attempt used pdfjs-dist (already a dependency) with
 * @napi-rs/canvas as its Node canvas backend — the standard recommended
 * pairing. `page.render()` segfaulted reproducibly in this environment
 * (isolated via 3 separate tests: full-size canvas, a much smaller canvas
 * ruling out a size/memory cause, and a version with try/catch that never
 * caught anything since the crash is below the JS layer) — a known,
 * documented category of pdfjs-dist/canvas-backend incompatibility, not
 * something specific to this file. Falls back to the Docling sidecar's
 * already-installed `pypdfium2` instead, invoked as a short-lived
 * subprocess per call (not routed through the sidecar's HTTP server —
 * rasterization has no model weights to keep warm, unlike Docling's table
 * extraction, so there's no benefit to that route, and it would make the
 * Ollama fallback depend on the sidecar's uptime, an unwanted new coupling
 * between two tiers that are supposed to be independent).
 */
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const PYTHON_EXE = process.env.DOCLING_PYTHON_PATH || join(REPO_ROOT, 'server', 'docling-sidecar', '.venv', 'Scripts', 'python.exe');
const RASTERIZE_SCRIPT = join(REPO_ROOT, 'server', 'docling-sidecar', 'rasterize_pdf.py');

export class PdfRasterizeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PdfRasterizeError';
  }
}

/**
 * Renders one page of a PDF to a PNG buffer. `scale` trades resolution
 * (legibility of small print for the vision model) against payload size —
 * 2.0 matches what was verified to work against Ollama directly during
 * root-cause diagnosis (a 331KB source PDF rendered to a ~280KB, 3126x1114
 * PNG that Ollama accepted and began processing).
 */
export async function rasterizePdfPageToPng(buffer: Buffer, pageNumber = 1, scale = 2.0): Promise<Buffer> {
  const tempPath = join(tmpdir(), `roster-rasterize-${randomUUID()}.pdf`);
  await writeFile(tempPath, buffer);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const proc = spawn(PYTHON_EXE, [RASTERIZE_SCRIPT, tempPath, String(pageNumber), String(scale)]);
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      proc.stdout.on('data', (c: Buffer) => chunks.push(c));
      proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
      proc.on('error', (err) => reject(new PdfRasterizeError(`Could not start Python rasterizer at ${PYTHON_EXE}: ${err.message}`, err)));
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new PdfRasterizeError(`PDF rasterization failed (exit ${code}): ${Buffer.concat(errChunks).toString('utf8')}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}
