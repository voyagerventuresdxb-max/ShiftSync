import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { fetchUploadProgress, type UploadProgress, type UploadStage } from '../../api/schedules';
import { readingMessage } from './readingMessage';
import { progressSteps, type RosterFileKind, type StepState } from './uploadProgress';

/** How often the upload's progress is asked for while the upload request is open. */
const POLL_MS = 800;
/** With no progress at all by now, the server isn't telling us (an older API, or another instance). */
const NO_PROGRESS_FALLBACK_S = 8;

/**
 * Follows one upload's real progress (GET /api/schedules/upload-progress/:id) while it is mounted
 * (callers key the component by upload id, so each upload starts afresh).
 * `unavailable`: there is nothing to follow — no id, an API without the endpoint, or polls failing.
 */
function useUploadProgress(token: string | null | undefined, uploadId: string | null | undefined) {
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [unavailable, setUnavailable] = useState(!token || !uploadId);
  useEffect(() => {
    if (!token || !uploadId) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const r = await fetchUploadProgress(token, uploadId);
      if (stopped) return;
      if (r.kind === 'unavailable') return setUnavailable(true);
      if (r.kind === 'error') {
        if (++failures >= 3) setUnavailable(true);
      } else failures = 0;
      if (r.kind === 'progress') {
        setProgress(r.progress);
        if (r.progress.stage === 'done' || r.progress.stage === 'failed') return;
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_MS / 2);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [token, uploadId]);
  return { progress, unavailable };
}

function StepMark({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-accent/50 bg-accent/15 text-accent" aria-hidden>
        <Check className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-accent" aria-hidden>
        <span className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
      </span>
    );
  }
  return <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-foreground/20" aria-hidden />;
}

/**
 * The "reading your roster" state. With an upload id it shows the read's real steps as the server
 * reports them — done, current ("Reading page 1 of 2"), still to come — and announces each new
 * step politely to screen readers. Without one, or when the API can't say, it falls back to a slow
 * hairline and wording that calms down with elapsed time (readingMessage.ts): never a blank wait.
 * No motion beyond the current step's soft pulse, and none at all with reduced motion.
 */
export function ReadingProgress({
  className,
  token,
  uploadId,
  fileKind = 'sheet',
  onStage,
}: {
  className?: string;
  token?: string | null;
  uploadId?: string | null;
  fileKind?: RosterFileKind;
  /** Told each new stage the server reports (the onboarding orb follows it). */
  onStage?: (stage: UploadStage) => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const { progress, unavailable } = useUploadProgress(token, uploadId);
  const stage = progress?.stage;
  useEffect(() => {
    if (stage) onStage?.(stage);
  }, [stage, onStage]);

  if (!progress && (unavailable || elapsed >= NO_PROGRESS_FALLBACK_S)) {
    return (
      <div className={className} data-testid="reading-progress" data-mode="elapsed">
        <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-foreground/10" aria-hidden>
          <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent/70 motion-safe:animate-[rr-reading_1.8s_ease-in-out_infinite]" />
        </div>
        <p className="mt-2 text-xs text-foreground/60" role="status" aria-live="polite">
          {readingMessage(elapsed)}
        </p>
      </div>
    );
  }

  const steps = progressSteps(progress, fileKind);
  const current = steps.find((s) => s.state === 'current');
  return (
    <div className={className} data-testid="reading-progress" data-mode="steps">
      <ol className="m-0 flex list-none flex-col p-0" aria-label="Reading your roster">
        {steps.map((step, i) => (
          <li
            key={step.stage}
            className="relative flex items-start gap-3 pb-3 last:pb-0"
            data-testid="reading-step"
            data-state={step.state}
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            {i < steps.length - 1 && (
              <span className={cn('absolute bottom-0 left-[7.5px] top-5 w-px', step.state === 'done' ? 'bg-accent/40' : 'bg-foreground/10')} aria-hidden />
            )}
            <StepMark state={step.state} />
            <span
              className={cn(
                'text-sm leading-5 motion-safe:transition-colors motion-safe:duration-300',
                step.state === 'current' ? 'font-medium text-foreground/90' : step.state === 'done' ? 'text-foreground/60' : 'text-foreground/40',
              )}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>
      <p className="sr-only" role="status" aria-live="polite">
        {current?.label ?? ''}
      </p>
      {elapsed >= 25 && <p className="mt-3 text-xs text-foreground/50">{readingMessage(elapsed)}</p>}
    </div>
  );
}
