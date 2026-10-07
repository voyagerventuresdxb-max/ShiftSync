import { cn } from '@/lib/utils';
import { voiceStepLabel, voiceStepPosition, type VoiceOrigin, type VoiceStep } from '@/lib/voiceSteps';

/**
 * Where a voice (or typed) command is up to: the step in words — a polite live region, so a screen
 * reader hears each step too — over a segmented bar of the whole sequence. The current segment
 * pulses only when the person allows motion.
 */
export function VoiceProgress({
  step,
  origin,
  kind = 'change',
  label,
  className,
}: {
  step: VoiceStep;
  origin: VoiceOrigin;
  kind?: 'change' | 'read';
  /** Overrides the step's own words (e.g. while the microphone permission prompt is up). */
  label?: string;
  className?: string;
}) {
  const { index, total } = voiceStepPosition(step, origin, kind);
  return (
    <div role="status" aria-live="polite" className={cn('min-w-0', className)}>
      <p className="truncate text-sm font-semibold text-foreground/87">{label ?? voiceStepLabel(step)}</p>
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
