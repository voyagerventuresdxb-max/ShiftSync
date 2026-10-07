import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useIdentity } from '../state/IdentityContext';
import { useConnectivity } from '../state/ConnectivityContext';
import {
  ApiError,
  confirmRoster,
  uploadRoster,
  type ConfirmResponse,
  type ConfirmRosterRequest,
  type PreviewRow,
  type UploadResponse,
} from '../api/schedules';
import { RosterReview } from '../features/rosterReview/RosterReview';
import { ImportResult } from '../features/rosterReview/ImportResult';
import { reviewPeople } from '../features/rosterReview/reviewModel';
import { btnPrimary } from '../features/rosterReview/styles';
import { ReadingProgress } from '../features/rosterReview/ReadingProgress';
import { newUploadId, rosterFileKind, type RosterFileKind } from '../features/rosterReview/uploadProgress';

const ACCEPTED = '.xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp';

type Phase = 'idle' | 'uploading' | 'consent' | 'preview' | 'confirming' | 'done' | 'error';

interface Props {
  /** Optional id of the manager committing the roster (audit trail). */
  createdById?: string;
  /**
   * Called after a batch is successfully committed, with the shift rows that
   * were written (named after the staff member each one now belongs to, dated
   * in the week they landed in). Lets the parent flush them into the roster
   * view, refresh the staff list and show the imported week.
   *
   * `batchId` is passed alongside so the parent can build shift ids that are
   * unique across separate uploads, not just within one — `row.rowNumber` on
   * its own resets per file, so two uploads confirmed in the same session
   * can otherwise collide and silently drop a shift during the merge.
   */
  onCommitted?: (
    rows: PreviewRow[],
    batchId: string,
    persisted: { rowNumber: number; shiftId: string; userId: string | null }[],
    importWeekStart?: string | null,
  ) => void;
  /**
   * Overrides the "Parsing {fileName}…" label shown while a file is
   * mid-upload/parse. Lets a caller with different framing (e.g. the
   * onboarding wizard) supply its own copy without changing the default
   * everywhere else this component is embedded (e.g. Scheduling).
   */
  uploadingLabel?: string;
}

export default function ShiftUpload({ createdById, onCommitted, uploadingLabel }: Props) {
  const { session } = useIdentity();
  const { online } = useConnectivity();
  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [data, setData] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [confirmResult, setConfirmResult] = useState<ConfirmResponse | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The file being read, kept so the manager can say "yes, send it to the AI reader" without picking it again.
  const fileRef = useRef<File | null>(null);
  const [consentMessage, setConsentMessage] = useState<string | null>(null);
  // The upload being read right now, so its real progress can be followed.
  const [reading, setReading] = useState<{ uploadId: string; kind: RosterFileKind } | null>(null);

  const handleFile = useCallback(
    async (file: File, aiConsent = false) => {
      fileRef.current = file;
      setError(null);
      setConsentMessage(null);
      setSessionExpired(false);
      setConfirmResult(null);
      setConfirmError(null);
      setFileName(file.name);
      const uploadId = newUploadId();
      setReading({ uploadId, kind: rosterFileKind(file) });
      setPhase('uploading');
      try {
        const res = await uploadRoster(session!.token, file, { aiConsent, uploadId });
        setData(res);
        setPhase('preview');
      } catch (err) {
        // Nothing has been sent anywhere yet: ask before the file goes to the third-party AI reader.
        if (err instanceof ApiError && err.errorCode === 'ai_consent_required') {
          setConsentMessage(err.message);
          setPhase('consent');
          return;
        }
        setError(err instanceof Error ? err.message : 'Upload failed.');
        setPhase('error');
      }
    },
    [session],
  );

  const sendToAiReader = useCallback(() => {
    if (fileRef.current) void handleFile(fileRef.current, true);
  }, [handleFile]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onConfirm = useCallback(
    async (request: ConfirmRosterRequest) => {
      if (!data) return;
      // Blocked outright while offline: committing a roster is a real,
      // non-undoable staffing action — a commit that actually lands minutes or
      // hours later than the manager thinks it did is worse than no commit at
      // all. No auto-retry — the manager clicks again once back online.
      if (!online) return;
      setPhase('confirming');
      setConfirmError(null);
      try {
        const res = await confirmRoster(session!.token, data.batchId, { ...request, createdById: createdById ?? request.createdById ?? null });
        setConfirmResult(res);
        setPhase('done');
        // Every written shift now belongs to a real staff member: hand the parent
        // those rows under the staff member's name and the date they landed on.
        const people = reviewPeople(data);
        const confirmedByPerson = new Map(res.people.map((p) => [p.personKey, p]));
        const personByRow = new Map(people.flatMap((p) => p.rowNumbers.map((n) => [n, p.personKey] as const)));
        const previewByRow = new Map(data.preview.map((r) => [r.rowNumber, r]));
        const written = res.rows.flatMap((w) => {
          const row = previewByRow.get(w.rowNumber);
          if (!row) return [];
          const confirmed = confirmedByPerson.get(personByRow.get(w.rowNumber) ?? '');
          return [{ ...row, employeeName: confirmed?.name ?? row.employeeName, role: confirmed?.roleName ?? row.role, date: w.date, status: 'matched' as const }];
        });
        onCommitted?.(written, data.batchId, res.rows, res.weekStart);
      } catch (err) {
        // A 404 on confirm means the batchId is missing or expired (the upload
        // cache was wiped by a server restart, or the 15-min review window
        // lapsed). Surface a clear, actionable message instead of a bare 404.
        if (err instanceof ApiError && err.status === 404) {
          setError('Upload session expired, please re-upload the roster.');
          setSessionExpired(true);
          setPhase('error');
        } else {
          // Anything else (a link to someone no longer on staff, a network blip):
          // keep the review and the manager's decisions on screen.
          setConfirmError(err instanceof Error ? err.message : 'Confirm failed.');
          setPhase('preview');
        }
      }
    },
    [data, createdById, onCommitted, session, online],
  );

  const reset = useCallback(() => {
    setPhase('idle');
    setData(null);
    setError(null);
    setSessionExpired(false);
    setConfirmResult(null);
    setConfirmError(null);
    setFileName(null);
    setConsentMessage(null);
    fileRef.current = null;
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  return (
    <section className="upload-card">
      <header className="upload-header">
        <h2 className="section-title">Upload Roster</h2>
        <p className="hint">
          Drop your roster. ShiftSync reads everyone on it and shows you each
          person before anything is saved. Confirming adds new people to your
          staff and their shifts to the rota; importing the same roster again
          adds nothing twice.
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
          <p className="dropzone-sub">
            Spreadsheets and text PDFs are read on ShiftSync's own server. Photos, scans and layouts it can't read can go to a
            third-party AI reader outside the UAE — only after you agree, each time (max 5MB, a few times per venue per week).
          </p>
        </div>
      ) : null}

      {phase === 'uploading' && (
        <>
          <div className="status-block">
            <p>{uploadingLabel ? uploadingLabel : <>Parsing <strong>{fileName}</strong>…</>}</p>
          </div>
          <ReadingProgress key={reading?.uploadId} className="px-6 pb-4" token={session?.token} uploadId={reading?.uploadId} fileKind={reading?.kind} />
        </>
      )}

      {phase === 'error' && error && (
        <div className={`error-block${sessionExpired ? ' error-block-toast' : ''}`} role="alert">
          <p>{error}</p>
          <button className="btn btn-ghost" onClick={reset}>
            Try another file
          </button>
        </div>
      )}

      {phase === 'consent' && consentMessage && (
        <div className="error-block" role="alertdialog" aria-labelledby="ai-consent-text" data-testid="ai-consent-panel">
          <p id="ai-consent-text">{consentMessage}</p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={sendToAiReader} data-testid="ai-consent-send">
              Send to the AI reader
            </button>
            <button className="btn btn-ghost" onClick={reset}>
              Choose another file
            </button>
          </div>
          <p className="hint">
            Or add staff by hand: <Link to="/people">People → Add staff member</Link>.
          </p>
        </div>
      )}

      {phase === 'preview' && data?.escalation && (
        <div className="hint" role="status" data-testid="escalation-banner" data-status={data.escalation.status}>
          <p>{data.escalation.message}</p>
          {data.escalation.status === 'needs_consent' && (
            <button className="btn btn-ghost" onClick={sendToAiReader} data-testid="escalation-reread">
              Re-read with the AI reader
            </button>
          )}
        </div>
      )}

      {(phase === 'preview' || phase === 'confirming') && data && (
        <RosterReview
          key={data.batchId}
          upload={data}
          variant="app"
          confirming={phase === 'confirming'}
          error={confirmError}
          createdById={createdById ?? session?.user.id ?? null}
          persistKey={session ? `shiftsync.rosterReview.${session.user.locationId}.${data.batchId}` : undefined}
          disabledReason={online ? null : "Requires connection — try again once you're back online."}
          onConfirm={(request) => void onConfirm(request)}
          onDiscard={reset}
        />
      )}

      {phase === 'done' && confirmResult && (
        <ImportResult
          result={confirmResult}
          actions={
            <button className={btnPrimary} onClick={reset}>
              Upload another roster
            </button>
          }
        />
      )}
    </section>
  );
}
