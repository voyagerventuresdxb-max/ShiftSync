import { useEffect, useState } from 'react';
import { readingMessage } from './readingMessage';

/**
 * Calm "still reading" state for a roster upload: a slow indeterminate hairline and a message
 * that changes with elapsed time (see readingMessage.ts). Announced politely to screen readers.
 */
export function ReadingProgress({ className }: { className?: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className={className} data-testid="reading-progress">
      <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-foreground/10" aria-hidden>
        <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent/70 motion-safe:animate-[rr-reading_1.8s_ease-in-out_infinite]" />
      </div>
      <p className="mt-2 text-xs text-foreground/60" role="status" aria-live="polite">
        {readingMessage(elapsed)}
      </p>
    </div>
  );
}
