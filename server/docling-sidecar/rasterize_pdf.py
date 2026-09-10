"""
Renders one page of a PDF to a PNG, written to stdout as raw bytes.

Usage: python rasterize_pdf.py <input.pdf> [page_number] [scale]

Standalone script, deliberately NOT part of the FastAPI service (service.py)
— invoked as a short-lived subprocess per call from pdfRasterize.ts. Unlike
Docling's table extraction, rasterization has no model weights to keep
resident in memory, so there's no benefit to routing it through the
long-running sidecar, and doing so would make the Ollama vision fallback
(the last-resort tier) depend on the sidecar's uptime — an unwanted new
coupling between two tiers that are supposed to be independent.

Uses pypdfium2, already a Docling dependency in this venv (no separate
install). This is the fallback chosen after pdfjs-dist + @napi-rs/canvas's
page.render() was confirmed to segfault reproducibly in this Node/Windows
environment (isolated via 3 separate tests, unrelated to canvas size) — a
known category of pdfjs-dist/canvas-backend compatibility issue, not
something specific to this file.
"""
import sys
import io
import pypdfium2 as pdfium


def main():
    if len(sys.argv) < 2:
        print("Usage: python rasterize_pdf.py <input.pdf> [page_number] [scale]", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    page_number = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    scale = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0

    pdf = pdfium.PdfDocument(input_path)
    if page_number < 1 or page_number > len(pdf):
        print(f"Requested page {page_number} but the PDF only has {len(pdf)} page(s).", file=sys.stderr)
        sys.exit(1)

    page = pdf[page_number - 1]
    bitmap = page.render(scale=scale)
    pil_image = bitmap.to_pil()

    buf = io.BytesIO()
    pil_image.save(buf, format="PNG")
    sys.stdout.buffer.write(buf.getvalue())


if __name__ == "__main__":
    main()
