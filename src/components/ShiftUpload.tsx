import { useCallback, useRef, useState } from 'react';
import {
  ApiError,
  confirmRoster,
  uploadRoster,
  type PreviewRow,
  type UploadResponse,
} from '../api/schedules';

const ACCEPTED = '.xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp';

type Phase = 'idle' | 'uploading' | 'preview' | 'confirming' | 'done' | 'error';

interface Props {
  /** Location (venue) id the roster belongs to. */
  locationId: string;
  /** Optional id of the manager committing the roster (audit trail). */
  createdById?: string;
  /**
   * Called after a batch is successfully committed, with the reviewed shift
   * rows that were persisted. Lets the parent flush the committed shifts
   * into the main roster view state so the grid and weekly totals update
   * immediately instead of staying stale.
   *
   * `batchId` is passed alongside so the parent can build shift ids that are
   * unique across separate uploads, not just within one — `row.rowNumber` on
   * its own resets per file, so two uploads confirmed in the same session
   * can otherwise collide and silently drop a shift during the merge.
   */
  onCommitted?: (rows: PreviewRow[], batchId: string, persisted: { rowNumber: number; shiftId: string; userId: string | null }[]) => void;
}

export default function ShiftUpload({ locationId, createdById, onCommitted }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [data, setData] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [confirmResult, setConfirmResult] = useState<{
    createdCount: number;
    skippedCount: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setSessionExpired(false);
      setConfirmResult(null);
      setFileName(file.name);
      setPhase('uploading');
      try {
        const res = await uploadRoster(file, locationId);
        setData(res);
        setPhase('preview');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed.');
        setPhase('error');
      }
    },
    [locationId],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onConfirm = useCallback(async () => {
    if (!data) return;
    setPhase('confirming');
    try {
      const res = await confirmRoster(data.batchId, createdById);
      setConfirmResult({ createdCount: res.createdCount, skippedCount: res.skippedCount });
      setPhase('done');
      // Flush the reviewed rows into the parent's roster state so the grid
      // reflects the confirm outcome. `matched` rows were actually persisted
      // server-side. `unmatched_role` rows were NOT persisted (Shift.roleId
      // is a required FK, and we deliberately don't guess a role) — they're
      // still flushed so the manager can see them and act on it, rather than
      // having them silently vanish from the grid; the parent is responsible
      // for rendering them as a clearly-flagged, not-yet-saved row.
      onCommitted?.(
        data.preview.filter((r) => r.status === 'matched' || r.status === 'unmatched_role'),
        data.batchId,
        res.rows,
      );
    } catch (err) {
      // A 404 on confirm means the batchId is missing or expired (the upload
      // cache was wiped by a server restart, or the 15-min review window
      // lapsed). Surface a clear, actionable message instead of a bare 404.
      if (err instanceof ApiError && err.status === 404) {
        setError('Upload session expired, please re-upload the roster.');
        setSessionExpired(true);
      } else {
        setError(err instanceof Error ? err.message : 'Confirm failed.');
        setSessionExpired(false);
      }
      setPhase('error');
    }
  }, [data, createdById, onCommitted]);

  const reset = useCallback(() => {
    setPhase('idle');
    setData(null);
    setError(null);
    setSessionExpired(false);
    setConfirmResult(null);
    setFileName(null);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  return (
    <section className="upload-card">
      <header className="upload-header">
        <h2 className="section-title">Upload Roster</h2>
        <p className="hint">
          Drop an Excel or CSV shift rota. ShiftSync parses it, resolves staff
          and roles, and shows a review preview — nothing is saved until you
          confirm.
        </p>
      </header>

      {phase === 'idle' || phase === 'error' ? (
        <div
          className={`dropzone${dragOver ? ' dropzone-active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <div className="dropzone-icon" aria-hidden>
            ⇪
          </div>
          <p className="dropzone-title">
            Drag &amp; drop your roster here, or <span>browse</span>
          </p>
          <p className="dropzone-sub">.xlsx · .xls · .csv · .pdf · .png · .jpg · .webp — up to 10MB</p>
        </div>
      ) : null}

      {phase === 'uploading' && (
        <div className="status-block">
          <span className="spinner" aria-hidden />
          <p>Parsing <strong>{fileName}</strong>…</p>
        </div>
      )}

      {phase === 'error' && error && (
        <div className={`error-block${sessionExpired ? ' error-block-toast' : ''}`} role="alert">
          <p>{error}</p>
          <button className="btn btn-ghost" onClick={reset}>
            Try another file
          </button>
        </div>
      )}

      {phase === 'preview' && data && (
        <PreviewReview
          data={data}
          onConfirm={onConfirm}
          onReset={reset}
        />
      )}

      {phase === 'confirming' && (
        <div className="status-block">
          <span className="spinner" aria-hidden />
          <p>Committing shifts…</p>
        </div>
      )}

      {phase === 'done' && confirmResult && (
        <div className="success-block" role="status">
          <p>
            <strong>{confirmResult.createdCount}</strong> shift
            {confirmResult.createdCount === 1 ? '' : 's'} committed.
            {confirmResult.skippedCount > 0 && (
              <span className="success-warn">
                {' '}
                {confirmResult.skippedCount} skipped (unresolved role).
              </span>
            )}
          </p>
          <button className="btn btn-primary" onClick={reset}>
            Upload another roster
          </button>
        </div>
      )}
    </section>
  );
}

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
