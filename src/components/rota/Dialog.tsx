import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCloseOnBack } from '@/lib/backNavigation';

/**
 * Centred dialog for the week builder (Spec §1 "Sheets and dialogs":
 * tablet/desktop get centred dialogs, 420–720 px). Focus moves in on open,
 * is trapped while open, and returns to whatever had it before; Escape and
 * browser/hardware back close it; the scrim closes only non-destructive
 * dialogs (Spec §6).
 */
export function Dialog(props: {
  title: ReactNode;
  eyebrow?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg';
  /** Scrim tap closes it (off for anything that would lose input or confirm a write). */
  dismissable?: boolean;
  /** Accessible label when the title is not plain text. */
  label?: string;
  hideClose?: boolean;
}) {
  const { title, eyebrow, onClose, children, footer, width = 'md', dismissable = true, label, hideClose = false } = props;
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useCloseOnBack(true, onClose);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.hasAttribute('disabled') && n.offsetParent !== null);
    if (items.length === 0) return;
    const firstEl = items[0]!;
    const lastEl = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-background/55 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={label ? undefined : titleId}
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          'panel flex max-h-[calc(100dvh-24px)] w-full flex-col shadow-lux outline-none motion-safe:animate-[rise_220ms_cubic-bezier(0.22,1,0.36,1)_both]',
          width === 'sm' ? 'max-w-[420px]' : width === 'md' ? 'max-w-[560px]' : 'max-w-[720px]',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border p-4 sm:p-5">
          <div className="min-w-0">
            {eyebrow && <p className="eyebrow text-accent">{eyebrow}</p>}
            <h2 id={titleId} className={cn(DISPLAY, 'text-2xl leading-tight')}>
              {title}
            </h2>
          </div>
          {!hideClose && (
            <button type="button" onClick={onClose} aria-label="Close" className="hit-44 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-surface-raised hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4 sm:px-5">{footer}</footer>}
      </div>
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Instrument Serif for display titles (the app's existing display face; no new font). */
export const DISPLAY = "font-['Instrument_Serif',ui-serif,Georgia,serif] font-normal tracking-[-0.005em]";

/** Button recipes from board A2 (44 px targets; gold primary; ghost). */
export const btn = {
  base: 'inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl border px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:border-dashed disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-70',
  gold: 'border-accent bg-accent text-accent-foreground hover:brightness-110',
  plain: 'border-border-strong bg-surface-raised text-foreground hover:bg-surface',
  ghost: 'border-transparent bg-transparent text-muted-foreground hover:bg-surface-raised hover:text-foreground',
  danger: 'border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10',
  sm: 'hit-44 min-h-9 rounded-[10px] px-3 text-[13px]',
  lg: 'min-h-14 text-base',
};
