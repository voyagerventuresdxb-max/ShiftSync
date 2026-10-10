import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../../lib/utils';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The rota bottom sheet (Design board A2 "Bottom sheet · dialog"): grabber,
 * 55 % scrim, rises from the bottom on a phone and sits centred (≤ 560 px)
 * on wider screens. Focus moves into the sheet, is trapped there, and goes
 * back to whatever opened it; Escape closes it, and so does a scrim tap
 * unless the sheet is a confirmation (`dismissible={false}`).
 *
 * Rendered through a portal on <body>: rota screens sit inside animated
 * (transformed) wrappers, which would otherwise turn `position: fixed` into
 * "fixed to the wrapper". It covers the app's bottom dock (z-30), so nothing
 * in it ever sits under the dock; its own bottom padding clears the
 * home-indicator inset.
 */
export function BottomSheet(props: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** Scrim tap closes the sheet. Off for confirm sheets (Escape and Cancel still work). */
  dismissible?: boolean;
  className?: string;
}) {
  const { label, onClose, children, dismissible = true, className } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === firstItem || !panelRef.current.contains(active))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (active === lastItem || !panelRef.current.contains(active))) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div aria-hidden="true" className="absolute inset-0 bg-background/55" onClick={dismissible ? () => closeRef.current() : undefined} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[90dvh] w-full max-w-[560px] flex-col gap-3 overflow-y-auto overscroll-contain rounded-t-3xl border border-b-0 border-border-strong bg-surface-raised px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2.5 text-foreground shadow-lux focus:outline-none motion-safe:animate-rise sm:rounded-3xl sm:border-b',
          className,
        )}
      >
        <span aria-hidden="true" className="mx-auto h-1 w-10 shrink-0 rounded-full bg-foreground/25" />
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Sheet header: gold eyebrow, title, optional sub-line, and a Close button. */
export function SheetHeader(props: { eyebrow: string; title: ReactNode; sub?: ReactNode; onClose?: () => void; display?: boolean }) {
  const { eyebrow, title, sub, onClose, display = false } = props;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span className="eyebrow text-accent">{eyebrow}</span>
        <span className={cn('min-w-0', display ? "font-['Instrument_Serif',ui-serif,Georgia,serif] text-2xl leading-tight" : 'text-lg font-semibold leading-snug')}>{title}</span>
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </div>
      {onClose && (
        <button type="button" onClick={onClose} className="min-h-11 shrink-0 rounded-xl px-3 text-sm font-semibold text-muted-foreground hover:text-foreground">
          Close
        </button>
      )}
    </div>
  );
}
