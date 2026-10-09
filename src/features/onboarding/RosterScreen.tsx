import { useRef, useState } from 'react';
import { uploadRoster, ApiError, type UploadResponse, type UploadStage } from '../../api/schedules';
import { useIdentity } from '../../state/IdentityContext';
import { useOnboardingState } from '../../state/OnboardingStateContext';
import OnboardingScreenShell from './OnboardingScreenShell';
import { ReadingProgress } from '../rosterReview/ReadingProgress';
import { newUploadId, rosterFileKind, type RosterFileKind } from '../rosterReview/uploadProgress';
import { StatusOrb } from '../../components/StatusOrb';
import type { StatusOrbPhase } from '../../lib/statusOrb';

/**
 * Onboarding · 03 · Roster — ported from `ShiftSync Roster.dc.html`.
 *
 * Two deliberate deviations from the prototype, both dictated by the real
 * pipeline rather than guessed:
 *  - The prototype simulates picking a file by cycling through 3 canned
 *    samples on tap and defers "reading" the file to an off-screen effect
 *    of Continue. The real deterministic-parser/Gemini-VLM pipeline parses
 *    AS PART OF the upload call itself (`uploadRoster` — see
 *    `api/schedules.ts`) — there's no server-side notion of "attached but
 *    not yet read" — so here, picking a file immediately calls the real
 *    upload endpoint (spinner in the zone), and Continue is just gated on
 *    that having succeeded.
 *  - The prototype allows a file AND a photo to be attached at once ("Two
 *    inputs, equal footing"). The real upload endpoint parses exactly one
 *    file per batch, so the two zones here share one underlying selection —
 *    picking either replaces whatever the other zone held.
 *
 * Skip routes straight to Invite (per product spec), not to Review as the
 * prototype's own mock does — Review has nothing to show when nothing was
 * uploaded.
 */

type ZoneState =
  | { phase: 'empty' }
  | { phase: 'uploading'; fileName: string; uploadId: string; kind: RosterFileKind }
  | { phase: 'ready'; fileName: string; ext: string; sizeLabel: string; result: UploadResponse; viaPhoto: boolean }
  | { phase: 'error'; fileName: string; message: string }
  // The server needs the manager's go-ahead before this file goes to the third-party AI reader; nothing was sent yet.
  | { phase: 'consent'; fileName: string; message: string };

function extOf(name: string) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1]!.toUpperCase() : 'FILE';
}

function sizeLabel(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RosterScreen({
  onBack,
  onContinue,
  onSkip,
}: {
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const { session } = useIdentity();
  const { uploadResult, uploadFile, setUploadResult } = useOnboardingState();

  // A batch already parsed this session (Back from Review, or a reload on
  // this step) is still the attached file — starting from 'empty' here used
  // to show a blank zone with Continue disabled, forcing a needless
  // re-upload even though Review still had the rows.
  const [zone, setZone] = useState<ZoneState>(() => {
    if (!uploadResult) return { phase: 'empty' };
    const fileName = uploadFile?.name ?? 'Uploaded roster';
    return {
      phase: 'ready',
      fileName,
      ext: uploadFile ? extOf(fileName) : 'FILE',
      sizeLabel: uploadFile ? sizeLabel(uploadFile.size) : `${uploadResult.summary.totalRows} shifts found`,
      result: uploadResult,
      viaPhoto: uploadFile?.viaPhoto ?? false,
    };
  });
  const [viaPhoto, setViaPhoto] = useState(uploadFile?.viaPhoto ?? false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  // The file being read, so "Send to the AI reader" doesn't make the manager pick it again.
  const pickedRef = useRef<{ file: File; viaPhoto: boolean } | null>(null);
  // The read's current stage (from the progress steps below), for the orb: reading, then matching.
  const [stage, setStage] = useState<UploadStage | null>(null);

  const handlePick = async (file: File, pickedViaPhoto: boolean, aiConsent = false) => {
    pickedRef.current = { file, viaPhoto: pickedViaPhoto };
    setViaPhoto(pickedViaPhoto);
    const uploadId = newUploadId();
    setStage(null);
    setZone({ phase: 'uploading', fileName: file.name, uploadId, kind: rosterFileKind(file) });
    if (!session) {
      setZone({ phase: 'error', fileName: file.name, message: 'You need to be signed in to upload a roster.' });
      return;
    }
    try {
      const result = await uploadRoster(session.token, file, { aiConsent, uploadId });
      setZone({ phase: 'ready', fileName: file.name, ext: extOf(file.name), sizeLabel: sizeLabel(file.size), result, viaPhoto: pickedViaPhoto });
      // Reflected into shared state the moment parsing succeeds, not deferred
      // to Continue — this is already-fetched, side-effect-free preview data
      // (unlike Venue's PATCH), so there's no reason for it to sit stale in
      // local state. Also what makes "picking one zone replaces the other"
      // correct from Review's perspective, not just this screen's.
      setUploadResult(result, { name: file.name, size: file.size, viaPhoto: pickedViaPhoto });
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === 'ai_consent_required') {
        setZone({ phase: 'consent', fileName: file.name, message: err.message });
        return;
      }
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not read that file.';
      setZone({ phase: 'error', fileName: file.name, message });
    }
  };

  const sendToAiReader = () => {
    if (pickedRef.current) void handlePick(pickedRef.current.file, pickedRef.current.viaPhoto, true);
  };

  const clear = () => {
    setZone({ phase: 'empty' });
    pickedRef.current = null;
    setUploadResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (photoInputRef.current) photoInputRef.current.value = '';
  };

  const ready = zone.phase === 'ready';
  const uploading = zone.phase === 'uploading';

  const handleContinue = () => {
    if (zone.phase !== 'ready') return;
    onContinue();
  };

  const handleSkip = () => {
    setUploadResult(null);
    onSkip();
  };

  const orbPhase: StatusOrbPhase | null =
    zone.phase === 'uploading'
      ? stage === 'matching' || stage === 'done'
        ? 'connecting'
        : 'working'
      : zone.phase === 'ready'
        ? 'done'
        : zone.phase === 'error'
          ? 'problem'
          : zone.phase === 'consent'
            ? 'rest'
            : null;

  const fileZoneFilled = ready && !zone.viaPhoto;
  const photoZoneFilled = ready && zone.viaPhoto;

  return (
    <OnboardingScreenShell
      stepIndex={2}
      eyebrow="Step 3 of 5 · Roster"
      title="Bring your team with you."
      onBack={onBack}
      footer={
        <>
          <button
            onClick={handleContinue}
            disabled={!ready}
            style={{
              width: '100%',
              padding: '16px 20px',
              borderRadius: 14,
              background: ready ? 'var(--ob-bone)' : 'color-mix(in srgb, var(--bone) 10%, transparent)',
              color: ready ? 'var(--ink-cta)' : 'var(--ob-dim-2)',
              font: "600 14px/1 'Manrope'",
              letterSpacing: '.005em',
              transition: 'background-color var(--ob-t), color var(--ob-t)',
              cursor: ready ? 'pointer' : 'default',
            }}
          >
            Continue
          </button>
          <div style={{ textAlign: 'center', marginTop: 14, font: "500 10px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-dim-2)' }}>
            Next · Review
          </div>
        </>
      }
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -8 }}>
        <button
          className="hit-44"
          onClick={handleSkip}
          style={{ padding: 8, font: "500 10px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)', background: 'transparent', border: 0 }}
        >
          Skip for now, I&apos;ll add staff later
        </button>
      </div>

      {/* File upload zone */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Reset immediately (not just on Remove) — otherwise re-picking the
          // exact same file in a row is a no-op: the input's value hasn't
          // changed from the browser's point of view, so no second `change`
          // event fires and the re-pick silently does nothing.
          e.target.value = '';
          if (f) void handlePick(f, false);
        }}
      />
      {/* A real <button> can't validly contain the nested Remove-file button below,
          so this is a plain div, made keyboard/AT-accessible only in its empty
          (click-to-browse) state — once filled, the remove control is the only
          interactive element inside it. */}
      <div
        role={fileZoneFilled ? undefined : 'button'}
        tabIndex={fileZoneFilled ? undefined : 0}
        onClick={() => {
          if (!fileZoneFilled) fileInputRef.current?.click();
        }}
        onKeyDown={(e) => {
          if (!fileZoneFilled && (e.key === 'Enter' || e.key === ' ')) fileInputRef.current?.click();
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: fileZoneFilled ? '16px 16px' : '22px 20px',
          borderRadius: 16,
          border: `1px ${fileZoneFilled ? 'solid color-mix(in srgb, var(--champagne) 60%, transparent)' : 'dashed color-mix(in srgb, var(--champagne) 28%, transparent)'}`,
          background: fileZoneFilled ? 'color-mix(in srgb, var(--champagne) 7%, transparent)' : 'color-mix(in srgb, var(--bone) 2%, transparent)',
          transition: 'background-color var(--ob-t), border-color var(--ob-t), color var(--ob-t)',
          textAlign: 'left',
          justifyContent: fileZoneFilled ? 'flex-start' : 'center',
          cursor: fileZoneFilled ? 'default' : 'pointer',
        }}
      >
        {!fileZoneFilled ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '6px 0', width: '100%' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {['XLSX', 'CSV', 'PDF'].map((ext, i) => (
                <div
                  key={ext}
                  style={{
                    width: 44,
                    height: 52,
                    borderRadius: 8,
                    border: '1px solid color-mix(in srgb, var(--champagne) 35%, transparent)',
                    display: 'flex',
                    alignItems: 'flex-end',
                    justifyContent: 'center',
                    paddingBottom: 8,
                    font: "600 9px/1 'Manrope'",
                    letterSpacing: '.08em',
                    color: 'var(--ob-champagne)',
                    background: 'color-mix(in srgb, var(--champagne) 5%, transparent)',
                    transform: i === 1 ? 'translateY(-6px)' : undefined,
                  }}
                >
                  {ext}
                </div>
              ))}
            </div>
            <div style={{ textAlign: 'center' }}>
              <div className="ob-serif" style={{ fontSize: 19, lineHeight: 1.2, color: 'var(--ob-bone)' }}>
                {uploading && !viaPhoto ? `Reading ${zone.fileName}…` : 'Upload your roster'}
              </div>
              <div style={{ font: "400 11.5px/1.5 'Manrope'", color: 'var(--ob-bronze)', marginTop: 5 }}>
                {zone.phase === 'error' && !viaPhoto ? zone.message : 'Excel, CSV or PDF — exports, old templates, anything.'}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                width: 44,
                height: 52,
                borderRadius: 8,
                border: '1px solid color-mix(in srgb, var(--champagne) 60%, transparent)',
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
                paddingBottom: 8,
                font: "600 9px/1 'Manrope'",
                letterSpacing: '.08em',
                color: 'var(--ob-champagne)',
                background: 'color-mix(in srgb, var(--champagne) 10%, transparent)',
                flexShrink: 0,
              }}
            >
              {zone.ext}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ob-serif" style={{ fontSize: 17, lineHeight: 1.2, color: 'var(--ob-bone)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {zone.fileName}
              </div>
              <div style={{ font: "400 11px/1.4 'Manrope'", color: 'var(--ob-bronze)', marginTop: 4 }}>{zone.sizeLabel}</div>
            </div>
            <button
              type="button"
              className="hit-44"
              aria-label="Remove file"
              onClick={(e) => {
                e.stopPropagation();
                clear();
              }}
              style={{ width: 32, height: 32, borderRadius: 9, border: '1px solid color-mix(in srgb, var(--bone) 10%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ob-bronze)', flexShrink: 0 }}
            >
              <svg width={12} height={12} viewBox="0 0 12 12" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round">
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* Photo option */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void handlePick(f, true);
        }}
      />
      <div
        role={photoZoneFilled ? undefined : 'button'}
        tabIndex={photoZoneFilled ? undefined : 0}
        onClick={() => {
          if (!photoZoneFilled) photoInputRef.current?.click();
        }}
        onKeyDown={(e) => {
          if (!photoZoneFilled && (e.key === 'Enter' || e.key === ' ')) photoInputRef.current?.click();
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '14px 16px',
          borderRadius: 16,
          border: `1px ${photoZoneFilled ? 'solid color-mix(in srgb, var(--champagne) 60%, transparent)' : 'dashed color-mix(in srgb, var(--champagne) 28%, transparent)'}`,
          background: photoZoneFilled ? 'color-mix(in srgb, var(--champagne) 7%, transparent)' : 'color-mix(in srgb, var(--bone) 2%, transparent)',
          transition: 'background-color var(--ob-t), border-color var(--ob-t), color var(--ob-t)',
          textAlign: 'left',
          cursor: photoZoneFilled ? 'default' : 'pointer',
        }}
      >
        <div style={{ width: 40, height: 40, borderRadius: 11, border: '1px solid color-mix(in srgb, var(--champagne) 35%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ob-champagne)', background: 'color-mix(in srgb, var(--champagne) 5%, transparent)', flexShrink: 0 }}>
          <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7.5c0-.8.7-1.5 1.5-1.5h1.7l1.1-1.6c.2-.3.5-.4.8-.4h3.8c.3 0 .6.1.8.4L13.8 6h1.7c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-11C3.7 15 3 14.3 3 13.5z" />
            <circle cx={10} cy={10.5} r={2.6} />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <div className="ob-serif" style={{ fontSize: 16, lineHeight: 1.2, color: 'var(--ob-bone)' }}>
            {uploading && viaPhoto ? `Reading ${zone.fileName}…` : photoZoneFilled ? zone.fileName : 'Photograph a printed roster'}
          </div>
          <div style={{ font: "400 11px/1.45 'Manrope'", color: 'var(--ob-bronze)', marginTop: 3 }}>
            {zone.phase === 'error' && viaPhoto
              ? zone.message
              : photoZoneFilled
                ? zone.sizeLabel
                : 'Printed or handwritten. Read by a third-party AI reader, only if you agree.'}
          </div>
        </div>
        {photoZoneFilled ? (
          <button
            type="button"
            className="hit-44"
            aria-label="Remove photo"
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            style={{ width: 32, height: 32, borderRadius: 9, border: '1px solid color-mix(in srgb, var(--bone) 10%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ob-bronze)', flexShrink: 0 }}
          >
            <svg width={12} height={12} viewBox="0 0 12 12" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        ) : (
          <svg width={14} height={14} viewBox="0 0 14 14" fill="none" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--dim-2)', flexShrink: 0 }}>
            <path d="M5 2.5 9.5 7 5 11.5" />
          </svg>
        )}
      </div>

      {orbPhase && (
        <div style={{ display: 'flex', justifyContent: 'center' }} data-testid="roster-orb">
          <StatusOrb phase={orbPhase} size={orbPhase === 'done' || orbPhase === 'problem' ? 72 : 112} />
          <p className="sr-only" role="status" aria-live="polite">
            {zone.phase === 'ready' ? 'Roster read. Continue to review it.' : zone.phase === 'error' ? zone.message : ''}
          </p>
        </div>
      )}

      {zone.phase === 'uploading' && (
        <ReadingProgress key={zone.uploadId} className="rr-onboarding" token={session?.token} uploadId={zone.uploadId} fileKind={zone.kind} onStage={setStage} />
      )}

      {(zone.phase === 'consent' || (zone.phase === 'ready' && zone.result.escalation)) && (
        <div
          role={zone.phase === 'consent' ? 'alertdialog' : 'status'}
          data-testid={zone.phase === 'consent' ? 'ai-consent-panel' : 'escalation-banner'}
          style={{ border: '1px solid color-mix(in srgb, var(--champagne) 35%, transparent)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <div style={{ font: "400 12px/1.55 'Manrope'", color: 'var(--ob-bone)' }}>
            {zone.phase === 'consent' ? zone.message : zone.phase === 'ready' ? zone.result.escalation!.message : null}
          </div>
          {(zone.phase === 'consent' || (zone.phase === 'ready' && zone.result.escalation?.status === 'needs_consent')) && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="hit-44"
                onClick={sendToAiReader}
                data-testid="ai-consent-send"
                style={{ padding: '0 14px', borderRadius: 10, border: '1px solid var(--ob-champagne)', color: 'var(--ob-champagne)', font: "500 13px 'Manrope'" }}
              >
                Send to the AI reader
              </button>
              {zone.phase === 'consent' && (
                <button
                  type="button"
                  className="hit-44"
                  onClick={clear}
                  style={{ padding: '0 14px', borderRadius: 10, border: '1px solid color-mix(in srgb, var(--bone) 10%, transparent)', color: 'var(--ob-bronze)', font: "500 13px 'Manrope'" }}
                >
                  Choose another file
                </button>
              )}
            </div>
          )}
          {zone.phase === 'consent' && (
            <div style={{ font: "400 11px/1.45 'Manrope'", color: 'var(--ob-bronze)' }}>
              Or skip this step and add staff by hand later: People → Add staff member.
            </div>
          )}
        </div>
      )}

      {/* Expectation line */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '2px 4px 0' }}>
        <svg width={14} height={14} viewBox="0 0 14 14" fill="none" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--bronze)', flexShrink: 0, marginTop: 2 }}>
          <circle cx={7} cy={7} r={5.5} />
          <path d="M4.5 7.2l1.7 1.7L9.6 5.5" />
        </svg>
        <div style={{ font: "400 12px/1.55 'Manrope'", color: 'var(--ob-bronze)' }}>
          We&apos;ll read it and show you what we found — you confirm every name and shift before anything goes live.
        </div>
      </div>
    </OnboardingScreenShell>
  );
}
