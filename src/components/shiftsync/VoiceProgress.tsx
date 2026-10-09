import { cn } from '@/lib/utils';
import { voiceStepLabel, voiceStepPosition, type VoiceOrigin, type VoiceStep } from '@/lib/voiceSteps';

/**
 * Where a voice (or typed) command is up to: the step in words over a segmented bar of the whole
 * sequence. One polite live region that stays in place says each step to a screen reader (so a
 * change is always announced); the visible line may word it for the eye. The current segment
 * pulses only when the person allows motion.
 */
export function VoiceProgress({
  step,
  origin,
  kind = 'change',
  label,
  announce,
  warning = false,
  className,
}: {
  step: VoiceStep;
  origin: VoiceOrigin;
  kind?: 'change' | 'read';
  /** Overrides the step's own words on screen (e.g. while the words are being edited). */
  label?: string;
  /** What a screen reader hears, when it should differ from the words on screen. */
  announce?: string;
  /** The line asks for attention (e.g. the preview is out of date). */
  warning?: boolean;
  className?: string;
}) {
  const { index, total } = voiceStepPosition(step, origin, kind);
  const shown = label ?? voiceStepLabel(step);
  return (
    <div className={cn('min-w-0', className)}>
      <p role="status" aria-live="polite" className="sr-only">
        {announce ?? shown}
      </p>
      <p className={cn('truncate text-sm font-semibold', warning ? 'text-warning' : 'text-foreground/87')} aria-hidden>
        {shown}
      </p>
      <div className="mt-2 flex gap-1" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cn(
              'h-1 flex-1 rounded-full motion-safe:transition-colors motion-safe:duration-300',
              i < index - 1 ? 'bg-accent/60' : i === index - 1 ? 'bg-accent motion-safe:animate-pulse' : 'bg-foreground/10',
            )}
          />
        ))}
      </div>
    </div>
  );
}
