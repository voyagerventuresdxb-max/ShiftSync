import type { ReactNode } from 'react';
import { Check, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

const STEPS = ['Upload your floor plan', 'Tap the plan where a section sits', 'Name it — Terrace, Bar, Main floor'];

/**
 * The Floor Plan page for a manager before the venue has any section:
 * "Add your first section", the three steps of the existing setup flow
 * (upload → tap to place → name) with the ones already done ticked, and one
 * primary `action` for the next step. `children` go under the action
 * (format hint, error, the hidden file input).
 */
export function AddFirstSection({ planUploaded, action, children }: { planUploaded: boolean; action: ReactNode; children?: ReactNode }) {
  return (
    <div className="panel-raised p-5 motion-safe:animate-rise" data-testid="floor-plan-empty">
      <span className="grid h-11 w-11 place-items-center rounded-full border border-accent/30 bg-accent/10 text-accent" aria-hidden>
        <MapPin className="h-5 w-5" strokeWidth={1.6} />
      </span>
      <h3 className="mt-3 text-lg font-semibold tracking-tight">Add your first section</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Sections are the parts of your floor you put people on each shift. Name them the way your team says them.
      </p>
      <ol className="mt-4 space-y-2.5 text-sm">
        {STEPS.map((step, i) => {
          const done = i === 0 && planUploaded;
          return (
            <li key={step} className="flex items-center gap-2.5">
              <span
                className={cn(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-semibold',
                  done ? 'border-success/40 bg-success/10 text-success' : 'border-accent/35 text-accent',
                )}
                aria-hidden
              >
                {done ? <Check className="h-3.5 w-3.5" strokeWidth={2.4} /> : i + 1}
              </span>
              <span className={done ? 'text-muted-foreground' : undefined}>
                {step}
                {done && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-5">{action}</div>
      {children}
    </div>
  );
}

/** The Floor Plan page for staff while the venue has no sections yet. */
export function FloorPlanNotSetUp() {
  return (
    <div className="panel-raised p-5" data-testid="floor-plan-not-set-up" role="status">
      <span className="grid h-11 w-11 place-items-center rounded-full border border-border text-muted-foreground" aria-hidden>
        <MapPin className="h-5 w-5" strokeWidth={1.6} />
      </span>
      <h3 className="mt-3 text-base font-semibold tracking-tight">Your manager hasn't set up the floor plan yet</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Once they add the venue's sections, you'll see them here, with where you're working each shift.
      </p>
    </div>
  );
}
