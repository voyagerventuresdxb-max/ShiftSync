"""
Local Docling table-extraction sidecar.

Purpose-built for exactly one job: turn a scanned/no-text-layer roster PDF
into a merge-expanded 2D grid of cell text, in the same shape the Excel path
already produces via buildMergeExpandedGrid() (server/src/parsing/*.ts). All
shift/role/leave-code semantics stay in the existing TypeScript grid
interpreter (parseExcelGrid) — this service does structure extraction only.

Runs fully local/offline after the one-time model download on first
conversion (Docling layout+TableFormer weights from Hugging Face, RapidOCR
weights from ModelScope — both cached under the user profile / venv).
Binds to 127.0.0.1 only — never exposed beyond localhost.

Start with: npm run docling:sidecar (see server/package.json)
"""
import io
import logging

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.document import DocumentStream
from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("docling-sidecar")

app = FastAPI(title="ShiftSync Docling Sidecar")

_opts = PdfPipelineOptions()
_opts.do_table_structure = True
_opts.table_structure_options.mode = TableFormerMode.ACCURATE
_opts.table_structure_options.do_cell_matching = True

# Built once at process start so model weights load into memory a single
# time and stay resident across requests, not per-call (that's the entire
# reason this is a long-running sidecar instead of a spawned-per-parse CLI).
_converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=_opts)})


class ConvertResponse(BaseModel):
    numTables: int
    grid: list[list[str]] | None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/convert", response_model=ConvertResponse)
async def convert(file: UploadFile = File(...)):
    if file.content_type not in ("application/pdf", "application/octet-stream", None):
        raise HTTPException(400, f"Expected a PDF, got content_type={file.content_type}")

    raw = await file.read()
    stream = DocumentStream(name=file.filename or "upload.pdf", stream=io.BytesIO(raw))

    try:
        result = _converter.convert(stream)
    except Exception as exc:  # noqa: BLE001 — surfaced to the caller, not swallowed
        logger.exception("Docling conversion failed")
        raise HTTPException(500, f"Docling conversion failed: {exc}") from exc

    doc = result.document
    if not doc.tables:
        # No table region detected at all (this is the expected/normal
        # outcome for some inputs — see the Gattopardo finding: a borderless,
        # positionally-laid-out grid with no visible table lines is not
        # reliably detected as a Table region by Docling's layout model).
        # The Node caller falls through to Ollama in this case.
        return ConvertResponse(numTables=0, grid=None)

    # Only the first/largest table region is used — a roster PDF is expected
    # to contain exactly one schedule table per page. Merge-expand spanned
    # cells (row_span/col_span > 1) by repeating the cell's text across its
    # full span, matching the convention buildMergeExpandedGrid() already
    # uses for Excel's !merges — so the shared grid interpreter on the Node
    # side (parseExcelGrid) sees the same shape regardless of source format.
    table = max(doc.tables, key=lambda t: t.data.num_rows * t.data.num_cols)
    num_rows = table.data.num_rows
    num_cols = table.data.num_cols
    grid: list[list[str]] = [["" for _ in range(num_cols)] for _ in range(num_rows)]

    for row in table.data.grid:
        for cell in row:
            text = (cell.text or "").strip()
            if not text:
                continue
            for r in range(cell.start_row_offset_idx, cell.end_row_offset_idx):
                for c in range(cell.start_col_offset_idx, cell.end_col_offset_idx):
                    if 0 <= r < num_rows and 0 <= c < num_cols:
                        grid[r][c] = text

    return ConvertResponse(numTables=len(doc.tables), grid=grid)
