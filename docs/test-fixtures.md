# Test fixtures: public vs private

**Rule: no real venue roster (or anything copied, rendered or transcribed from one) goes in the
repository.** Real rosters carry real staff names. They live in a gitignored directory on the
machines that have them; the public suite covers the same layouts with synthetic stand-ins.

## Private fixtures (local only)

| File | What it is | Used by |
|---|---|---|
| `real-roster.pdf` | the text-layer reference roster | `pdfTableExtractor.test.ts` (structure-only assertions), `server/scripts/verify-pdf-*.mts` |
| `real-roster.png`, `rendered-page-1.png` | images of the same roster | `server/scripts/verify-tesseract.mts` |
| `bar-des-pres-roster.pdf` | the scanned (image-only) reference roster | `doclingClient.test.ts` (live, needs the sidecar) |

- Location: `server/test-fixtures/private/` (gitignored), or set `SHIFTSYNC_PRIVATE_FIXTURES_DIR`
  to another directory.
- **Missing files are fine:** every test that wants one skips with
  `private fixture "<name>" is not on this machine … — skipped`.
- **Getting them back on a machine that had them in git:** `npm run fixtures:restore-private` copies
  them out of the last commit that still tracked them (`64de660`) into the private directory. It
  prints file names and sizes only. It stops working if that history is ever rewritten, so run it
  (or copy the files somewhere safe) first.
- The private-file tests assert structure only (counts, section labels, leave codes), never names.
- `server/scripts/verify-pdf-render.mts` writes its page renders into the private directory too.

## Synthetic stand-ins (public)

`server/test-fixtures/synthetic/`, regenerated with
`node server/scripts/make-synthetic-roster-fixtures.mjs` (every name is made up):

- `text-roster.pdf` — the text-layer layout's features: a covers caption above the listing,
  unlabeled management rows, section headers printed in a middle column beside a stray headcount
  number, AM/PM `11 17 18 25` cells, a blank-week employee inside a section, a legend box in a
  trailing column. Tested in `pdfTableExtractor.test.ts`.
- `roster.png` — the same roster as an image (OCR/vision tooling).
- `scanned-roster.pdf` — image-only per-row-title layout like the scanned roster (`OFF`, `12CL`,
  `10IN`, `UL`, `AL`, `4pm to 2am`, `10am/3pm-7pm/12am`). Tested for "no text layer", and in the
  live Docling test.

`barDesPresReference.test.ts` keeps the scanned layout's cell-by-cell interpretation test, with
every staff name replaced by a made-up one.

## Adding a fixture

Build it from made-up names (a generator script is best). If a real file is needed to reproduce a
bug, put it in the private directory, write the test to skip without it, and add a synthetic
stand-in that reproduces the same layout.
