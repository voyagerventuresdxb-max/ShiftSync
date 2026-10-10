import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface ToastState {
  id: number;
  message: string;
  tone: 'info' | 'error';
  /** Offer Undo for the last action. */
  undo: boolean;
}

/**
 * Rota toast (Design board A2 "Cards · toasts"): one line, an optional Undo,
 * pinned above the app's bottom dock so it never hides under it. A polite
 * live region, so a screen reader hears what just happened.
 */
export function Toast(props: { toast: ToastState | null; onUndo: () => void; onDismiss: () => void }) {
  const { toast, onUndo, onDismiss } = props;
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-4 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-md" role="status" aria-live="polite">
      {toast && (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto flex items-center gap-2 rounded-2xl border bg-surface-raised py-1.5 pl-4 pr-1.5 text-sm font-medium text-foreground shadow-lux motion-safe:animate-rise',
            toast.tone === 'error' ? 'border-destructive/50' : 'border-border-strong',
          )}
        >
          {toast.tone === 'error' && <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />}
          <span className="min-w-0 flex-1 py-2">{toast.message}</span>
          {toast.undo && (
            <button type="button" onClick={onUndo} className="min-h-11 shrink-0 rounded-xl border border-border-strong px-3 text-sm font-semibold hover:border-accent/50 hover:text-accent">
              Undo
            </button>
          )}
          <button type="button" onClick={onDismiss} aria-label="Dismiss" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted-foreground hover:text-foreground">
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
