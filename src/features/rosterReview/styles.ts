import { cn } from '../../lib/utils';

/**
 * Class names for the roster review. Tailwind theme tokens only (bg-surface,
 * text-foreground, accent...), so the same components take the app's palette on Scheduling
 * and the onboarding palette inside `.rr-onboarding` (see onboarding.css). Every control is at
 * least 44px tall.
 */

export const btnBase =
  'inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm transition-[background-color,border-color,color,opacity] duration-150 disabled:cursor-not-allowed';

export const btnPrimary = cn(
  btnBase,
  'bg-accent px-4 font-semibold text-primary-foreground hover:bg-accent/90 disabled:bg-foreground/10 disabled:text-foreground/40',
);

export const btnGhost = cn(btnBase, 'border border-border text-foreground/75 hover:border-foreground/30 hover:text-foreground disabled:opacity-40');

export const btnLink = cn(btnBase, 'px-1 text-accent/90 underline-offset-4 hover:text-accent hover:underline');

/** One option of a two- or three-way choice ("Same person" / "New person"). */
export function segmentClass(on: boolean): string {
  return cn(
    btnBase,
    'border',
    on ? 'border-accent/70 bg-accent/10 font-medium text-accent' : 'border-border text-foreground/70 hover:border-foreground/30 hover:text-foreground',
  );
}

export const inputClass =
  'min-h-11 w-full rounded-lg border border-border bg-background/60 px-3 text-sm text-foreground placeholder:text-foreground/40 focus:border-accent/70 focus:outline-none';
