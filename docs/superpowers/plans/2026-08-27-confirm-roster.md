# Confirm Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Lovable's Confirm Roster UX pattern — needs-review-first grouping, a bulk "Confirm All Matched" gesture, and per-row skip — onto our existing, already-real, already-more-capable roster review screen (`ShiftUpload.tsx`'s `PreviewReview`). Per the directive: **no backend changes** — the parser, matching logic, and confirm endpoint are untouched; this phase is a frontend restructuring of an existing component only.

**Architecture:** `PreviewReview` currently renders every `PreviewRow` as one flat table, filterable by status via a chip bar, with a single unconditional "Confirm & commit N shifts" button that always commits every `matched` row in the batch (the backend has never supported partial/selective commit — `confirmRoster(batchId)` takes no row-level payload). This phase restructures that same component into two grouped sections — **Needs Review** (rows with `status !== 'matched'`) shown first, **Matched** shown after — mirroring Lovable's `review`/`matched` split, adds a **local-only** per-row "reviewed" toggle (Lovable's "skip" gesture — dismissing a needs-review row from the outstanding count) and a bulk "Mark all needs-review as reviewed" action (Lovable's "Confirm All Matched," reinterpreted since our matched rows are already always-included, not individually confirmable), and gates a re-labeled "Confirm & Commit" button on all needs-review rows having been explicitly looked at at least once — a forcing function that makes a manager triage problem rows before publishing, without needing the backend to accept a different payload than it already does. Nothing here changes what gets persisted; it changes what a manager is made to look at before the identical `confirmRoster(batchId)` call fires.

**Tech Stack:** No new dependencies. Pure React state + existing CSS conventions (`.chip`/`.chip-active`, `.badge*`, `.status-tag`, `.panel`) already used throughout `ShiftUpload.tsx` and the rest of this codebase.

**Spec:** This plan implements the "Confirm Roster" section of the user's 2026-08-25 build directive, quoted here in full since it is short:

> **Confirm Roster**
> No backend changes — ours is already real and more capable. Just port Lovable's UX pattern (bulk-confirm, needs-review-first, per-row skip) into our existing screen.

Lovable's reference implementation (`src/routes/confirm-roster.tsx` in the ported repo) is a fully mocked page over hardcoded `parsedRows`: a sticky header showing "`N of M confirmed`", a "Confirm All Matched" bulk button, two `RowSection`s ("Needs Review" first, "Matched" second) each rendering rows with a confidence dot, an inline-editable name field, a role `<select>`, a per-row skip button, a per-row confirm checkmark, and a sticky bottom "Publish Schedule — N rows left" button disabled while any row is neither confirmed nor skipped.

## Global Constraints

- **No backend changes, at all.** `server/src/routes/schedules.ts`, `src/api/schedules.ts`, the `PreviewRow`/`UploadResponse`/`ConfirmResponse` contracts, and `confirmRoster(batchId, createdById)`'s signature are all untouched. If any task's implementer believes a backend change is needed to satisfy this plan, that is a signal the plan has a defect — stop and flag it rather than adding one.
- **No inline name/role editing is built in this phase**, even though Lovable's reference has it. Explicit, deliberate scope cut, not an oversight: the backend confirm endpoint has no mechanism to accept per-row corrections (it re-processes whatever was cached server-side at upload time under that `batchId`), so an inline-edit UI here would either (a) silently do nothing when a manager "corrects" a name and hits confirm — a real, dangerous mock, precisely the kind this codebase's own conventions forbid — or (b) require a backend change, which the directive explicitly rules out. If a manager needs to fix a name/role, the existing, correct path remains: fix the source file and re-upload (the "Re-upload"/"Discard" action already in the component), or fix the underlying `User`/`Role` data in Staff Directory so a future upload matches. Note this limitation once, visibly, in the new UI copy so it isn't a silent gap.
- **"Per-row skip" is reinterpreted as a local-only "reviewed" acknowledgment, not a payload change.** In Lovable's mock, "skip" and "confirm" are both just client-side flags with no real backend underneath — skipping a row excludes it from the "outstanding" count that gates Publish. In our real system, non-`matched` rows are already never persisted by `confirmRoster` (the server already "skips" them automatically), and `matched` rows are always committed together as a unit — there is no way to selectively include/exclude one matched row from a commit today, and this plan does not add one. So here, "skip" means: a manager can mark an individual needs-review row as "I've looked at this, understood it won't be created automatically" — purely local UI state that unblocks the Confirm button, changing nothing about what the very same `confirmRoster(batchId)` call actually persists.
- **"Bulk-confirm" is reinterpreted analogously.** Lovable's "Confirm All Matched" selectively confirms only the rows already at high confidence, leaving needs-review rows still blocking Publish. Since our matched rows are unconditionally included in every commit regardless of any UI state, the equivalent, honest gesture here is a bulk "Mark all Needs Review rows as reviewed" action — it triages the *attention-requiring* rows in one click (the actual manual toil Lovable's button was designed to save), without pretending to selectively include/exclude anything from the real commit.
- **Route/component conventions**: this is a single existing component (`src/components/ShiftUpload.tsx`) getting restructured, not a new route. No new files unless a genuinely separable, reusable sub-component earns one (see Task 1). Follow this file's own existing patterns (`Phase` state machine, `.preview-*`/`.badge*`/`.chip*`/`.status-tag` CSS classes already defined in `global.css`) — do not introduce a parallel styling system.
- **No new tests are strictly required by Global Constraints for this phase** — this codebase's established testing convention (real `node:test` + `withServer()`) applies to backend logic, and this phase changes none. Existing tests (`src/engine/*.test.ts`, `server/src/**/*.test.ts`) must continue to pass untouched, and are the acceptance bar; no test file in this plan needs to be created or modified.
- **Commit hygiene**: stage only this plan's own named files — never `git add -A`/`.`. Never touch `.claude/settings.json`/`.claude/settings.local.json` under any circumstances; if any subagent hits a permission denial, it must stop and report BLOCKED, not attempt a workaround.
- **Judgment calls made while writing this plan** (documented here, not silently guessed — both reversible, neither hard-to-undo):
  1. Inline name/role editing is cut from scope (see above) — a real backend-capability gap, not a UI oversight, and re-adding it later is a separate, backend-touching phase if ever wanted.
  2. "Skip"/"bulk-confirm" are both reinterpreted as local review-state gestures rather than literal selective-commit features, because our backend was never built to support selective commit and this directive explicitly forbids adding that now.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/components/ShiftUpload.tsx` (modify) | `PreviewReview` restructured into Needs-Review/Matched sections with local per-row review state, bulk "mark all reviewed" action, and a gated Confirm button; `PreviewRowRow` gains a reviewed-toggle button. |
| `src/styles/global.css` (modify) | New rules for the two-section layout, the sticky reviewed-count bar, and the per-row reviewed toggle — reusing existing color tokens/utility patterns, not inventing new ones. |

---

### Task 1: Restructure `PreviewReview` into Needs-Review/Matched sections with local review state

**Files:**
- Modify: `src/components/ShiftUpload.tsx`

**Interfaces:**
- No exported interfaces change. `PreviewReview`'s internal state gains a `reviewed: Set<number>` (row numbers the manager has explicitly acknowledged) alongside its existing `filter` state.
- Consumed by: Task 2 (the sticky gating bar reads the same `reviewed` set).

- [ ] **Step 1: Read the current real file in full before editing** (already quoted above in this plan — but re-read it live, since this plan was written from a snapshot and no other task has touched this file in the interim within this same plan).

- [ ] **Step 2: Replace `PreviewReview`'s body**

Keep the existing `data`/`onConfirm`/`onReset` props and the existing `filter` state (still useful within each section for large batches), but add grouping and per-row review state:

```tsx
function PreviewReview({
  data,
  onConfirm,
  onReset,
}: {
  data: UploadResponse;
  onConfirm: () => void;
  onReset: () => void;
}) {
  const { preview, summary, templateDetected, parseIssues, anomalies, leaveRecords, legend } = data;
  const [filter, setFilter] = useState<'all' | 'error' | 'new_employee' | 'unmatched_role'>('all');
  const [reviewed, setReviewed] = useState<Set<number>>(new Set());

  const needsReview = preview.filter((r) => r.status !== 'matched');
  const matched = preview.filter((r) => r.status === 'matched');
  const visibleNeedsReview = needsReview.filter((r) => filter === 'all' || r.status === filter);

  const outstanding = needsReview.filter((r) => !reviewed.has(r.rowNumber)).length;

  const toggleReviewed = (rowNumber: number) => {
    setReviewed((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  };

  const markAllReviewed = () => {
    setReviewed(new Set(needsReview.map((r) => r.rowNumber)));
  };

  return (
    <div className="preview">
      <div className="preview-meta">
        <span className="badge">
          {templateDetected ? `Template: ${templateDetected}` : 'Template: auto'}
        </span>
        <span className="badge">{summary.totalRows} rows</span>
        <span className="badge badge-ok">{summary.matchedRows} matched</span>
        {summary.newEmployeeRows > 0 && (
          <span className="badge badge-new">{summary.newEmployeeRows} new staff</span>
        )}
        {summary.unmatchedRoleRows > 0 && (
          <span className="badge badge-warn">{summary.unmatchedRoleRows} unmatched role</span>
        )}
        {summary.errorRows > 0 && (
          <span className="badge badge-err">{summary.errorRows} errors</span>
        )}
      </div>

      {parseIssues.length > 0 && (
        <div className="parse-issues">
          <strong>Parser notes:</strong>
          <ul>
            {parseIssues.map((i, idx) => (
              <li key={idx}>
                Row {i.rowNumber}
                {i.field ? ` · ${i.field}` : ''}: {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {anomalies.length > 0 && (
        <div className="anomaly-block" role="alert">
          <strong>⚠ Needs manager review — {anomalies.length} unresolved item{anomalies.length === 1 ? '' : 's'}</strong>
          <p className="hint">
            The AI reader could not confidently place these cells (unrecognized codes,
            illegible text, or unresolved dates). They were left out of the shift list below —
            confirm or correct them manually before this roster is complete.
          </p>
          <ul>
            {anomalies.map((a, idx) => (
              <li key={idx}>
                {a.employeeName ? <strong>{a.employeeName}</strong> : <em>Unassigned</em>}
                {a.date ? ` · ${a.date}` : ''} — "{a.rawText}": {a.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {leaveRecords.length > 0 && (
        <div className="parse-issues">
          <strong>Non-working days detected ({leaveRecords.length}) — not imported as shifts:</strong>
          <ul>
            {leaveRecords.map((l, idx) => (
              <li key={idx}>
                {l.employeeName} · {l.date} — {l.leaveCode} ({l.category.replace('_', ' ')})
              </li>
            ))}
          </ul>
        </div>
      )}

      {legend.length > 0 && (
        <div className="parse-issues">
          <strong>Shift-code legend inferred from the image:</strong>
          <ul>
            {legend.map((l, idx) => (
              <li key={idx}>
                <strong>{l.code}</strong> — {l.meaning}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="preview-section preview-section-review">
        <header className="preview-section-header">
          <div>
            <p className="eyebrow">Needs Review</p>
            <p className="hint">
              These rows won't be turned into shifts automatically. Look them over, then mark each
              reviewed (or all at once) to unlock committing the roster.{' '}
              {needsReview.length > 0 && 'To correct a name or role, fix the source file and re-upload — inline edits aren\'t supported here.'}
            </p>
          </div>
          {needsReview.length > 0 && (
            <button className="btn btn-ghost" onClick={markAllReviewed} disabled={outstanding === 0}>
              Mark all reviewed
            </button>
          )}
        </header>

        {needsReview.length === 0 ? (
          <p className="hint px-1">Nothing needs review — every row matched cleanly.</p>
        ) : (
          <>
            <div className="filter-bar">
              {(
                [
                  ['all', 'All'],
                  ['error', 'Errors'],
                  ['new_employee', 'New staff'],
                  ['unmatched_role', 'Unmatched role'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={`chip${filter === key ? ' chip-active' : ''}`}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="preview-table-wrap">
              <table className="preview-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Staff</th>
                    <th>Role</th>
                    <th>Date</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Break</th>
                    <th>Status</th>
                    <th>Reviewed</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleNeedsReview.map((row) => (
                    <PreviewRowRow
                      key={row.rowNumber}
                      row={row}
                      reviewed={reviewed.has(row.rowNumber)}
                      onToggleReviewed={() => toggleReviewed(row.rowNumber)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="preview-section preview-section-matched">
        <header className="preview-section-header">
          <p className="eyebrow">Matched — will be committed</p>
        </header>
        <div className="preview-table-wrap">
          <table className="preview-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Staff</th>
                <th>Role</th>
                <th>Date</th>
                <th>Start</th>
                <th>End</th>
                <th>Break</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {matched.map((row) => (
                <PreviewRowRow key={row.rowNumber} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="preview-sticky-bar">
        <p className="preview-sticky-count">
          {outstanding > 0
            ? `${outstanding} needs-review row${outstanding === 1 ? '' : 's'} left`
            : needsReview.length > 0
              ? 'All needs-review rows reviewed'
              : null}
        </p>
        <div className="preview-actions">
          <button className="btn btn-ghost" onClick={onReset}>
            Discard
          </button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={outstanding > 0}>
            Confirm &amp; Commit {summary.matchedRows} shift{summary.matchedRows === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Note the Confirm button's label now says `summary.matchedRows` (what will actually be created) rather than `summary.totalRows` (what the old label said, which overstated the count whenever any non-matched rows existed) — this is a real, in-scope honesty fix consistent with this codebase's "don't overstate what's real" convention, surfaced by writing this plan against the real component, not a new requirement from the directive itself.

- [ ] **Step 3: Update `PreviewRowRow`**

Extend its props to optionally accept `reviewed`/`onToggleReviewed` (only passed for needs-review rows; the matched-section call site omits them):

```tsx
function PreviewRowRow({
  row,
  reviewed,
  onToggleReviewed,
}: {
  row: PreviewRow;
  reviewed?: boolean;
  onToggleReviewed?: () => void;
}) {
  const statusLabel: Record<PreviewRow['status'], string> = {
    matched: 'Matched',
    new_employee: 'New staff',
    unmatched_role: 'Unmatched role',
    error: 'Error',
  };
  return (
    <tr className={`row-${row.status}`}>
      <td className="cell-num">{row.rowNumber}</td>
      <td>{row.employeeName}</td>
      <td>{row.role || '—'}</td>
      <td>{row.date}</td>
      <td>{row.startTime}</td>
      <td>
        {row.endTime}
        {row.overnight && <span className="overnight-tag">+1</span>}
      </td>
      <td>{row.breakMinutes > 0 ? `${row.breakMinutes}m` : '—'}</td>
      <td>
        <span className={`status-tag status-${row.status}`}>{statusLabel[row.status]}</span>
        {row.issues.length > 0 && (
          <span className="row-issues" title={row.issues.map((i) => i.message).join('; ')}>
            ⚠
          </span>
        )}
      </td>
      {onToggleReviewed && (
        <td>
          <button
            className={`chip${reviewed ? ' chip-active' : ''}`}
            onClick={onToggleReviewed}
            aria-pressed={reviewed}
          >
            {reviewed ? 'Reviewed' : 'Mark reviewed'}
          </button>
        </td>
      )}
    </tr>
  );
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed. `outstanding`/`reviewed` state resets naturally on `reset()` since `PreviewReview` unmounts (its state isn't lifted into the parent) — confirm this is really true by reading `ShiftUpload.tsx`'s `phase` transitions (returning to `'idle'` unmounts `PreviewReview` entirely since it's only rendered when `phase === 'preview'`), not by assumption.

- [ ] **Step 5: Commit**

```bash
git add src/components/ShiftUpload.tsx
git commit -m "feat: restructure roster review into needs-review-first sections with local review gating"
```

---

### Task 2: Styling pass — sticky bar, section headers, reviewed toggle

**Files:**
- Modify: `src/styles/global.css`

**Interfaces:** none new — pure CSS additions.

- [ ] **Step 1: Read the current real `global.css`** around the existing `.preview*`/`.badge*`/`.chip*`/`.status-tag`/`.filter-bar` rules (used by the file this plan already touches) to match its exact conventions (color tokens, spacing scale, dark-luxury palette) before adding anything new.

- [ ] **Step 2: Add rules for the new structural elements** introduced in Task 1 — `.preview-section`, `.preview-section-header`, `.preview-sticky-bar`, `.preview-sticky-count` — following the same pattern as this file's existing sibling rules (e.g. `.fp-tab-header`, `.staff-directory-body` from earlier phases: a bordered panel-like section, a header row with title + optional action button, muted secondary text). The sticky bar should visually echo the existing `.preview-actions` bar it replaces (same button styling, same bottom-anchored position) but gain the outstanding-count text before the buttons.

- [ ] **Step 3: Verify**

Run: `npm run build` (Tailwind v4's `@utility`/`@theme inline` blocks are processed at build time — a typo here wouldn't fail typecheck, only visually; a clean build at least confirms no syntax error). Manually confirm by reading the built CSS output that the new class names actually appear (this codebase's Floor Plan phase caught a real case of new classes being referenced by a component but never actually defined — don't repeat that mistake; grep the build output for each new class name).

- [ ] **Step 4: Commit**

```bash
git add src/styles/global.css
git commit -m "style: add CSS for the needs-review/matched roster sections and sticky review bar"
```

---

### Task 3: Verification + MEMORY.md

**Files:**
- Modify: `MEMORY.md`

**Interfaces:** none new — acceptance gate for the phase.

- [ ] **Step 1: Full verification pass**

Run, in order: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npm run server:typecheck`, `npm run test:server`. All must succeed with zero regressions from the pre-phase baseline (this phase touches no backend/test files, so `test:server`'s result should be byte-identical to before this plan started — confirm that, don't just check it passes).

- [ ] **Step 2: Manual/structural verification of the "no backend changes" constraint**

Run `git diff main --stat` (against whatever branch this plan started from) and confirm ONLY `src/components/ShiftUpload.tsx` and `src/styles/global.css` appear — no file under `server/` or `src/api/` in the diff. This is the single most important thing to check for this phase, since violating it would directly contradict the directive's explicit instruction.

- [ ] **Step 3: State plainly what was NOT verified** — this phase's actual visual rendering (the two-section layout, the sticky bar, the reviewed-toggle interaction) has not been looked at by a human or a browser tool in this environment. This project has an existing, explicitly-tracked standing gap for exactly this class of verification (see `MEMORY.md`'s "STANDING PRE-LAUNCH GATE" entry from the People/Identity phase) — add this phase's screen to that same tracked list rather than creating a new, separate note, and do not claim visual verification happened.

- [ ] **Step 4: Update `MEMORY.md`**

Check off this phase's item under `## Completed Core Components`; reuse the existing `## Next Sprint Goals` heading structure (do not create a new duplicate heading — this exact mistake has already happened once in this project and must not repeat). Extend the existing "STANDING PRE-LAUNCH GATE" bullet (added at the end of the People/Identity phase) to also name this phase's restructured review screen, rather than adding a second, separate gate note.

- [ ] **Step 5: Commit**

```bash
git add MEMORY.md
git commit -m "docs: record Confirm Roster phase completion"
```

---

## Self-Review

**Spec coverage:**
- "No backend changes" → enforced by this plan's own file list (only 2 frontend files + MEMORY.md across all 3 tasks) and explicitly checked in Task 3. ✅
- "needs-review-first" → Task 1 restructures into two sections, Needs Review rendered before Matched. ✅
- "bulk-confirm" → Task 1's "Mark all reviewed" bulk action, reinterpreted per this plan's own documented judgment call (our matched rows were never individually confirmable to begin with, unlike Lovable's mock). ✅
- "per-row skip" → Task 1's per-row "reviewed" toggle, reinterpreted the same way (local UI gating, not a selective-commit payload change). ✅

**Placeholder scan:** the plan explicitly cuts inline name/role editing rather than half-building it — a real, documented scope decision, not a silently-abandoned mock. The Confirm button's relabeled count (`matchedRows` instead of `totalRows`) is a small, real honesty fix surfaced by grounding this plan in the actual current component, not a hidden change.

**Type consistency:** no new types are introduced; `PreviewRow`/`UploadResponse`/`ConfirmResponse` are untouched, matching the "no backend changes" constraint by construction.
