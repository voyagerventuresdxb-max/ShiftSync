import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Dialog, DISPLAY, btn } from './Dialog';

export interface ConfirmDetails {
  eyebrow?: string;
  /** Full name — never shortened in a confirm sheet (A2). */
  personName: string | null;
  initials?: string;
  /** "Floor · Waiter" */
  roleLine?: string | null;
  /** "Thursday 8 October 2026" */
  dateLine: string;
  /** "Morning · 07:00 – 16:00" */
  timesLine?: string | null;
  /** "Replaces: Day off" when the cell was not empty. */
  replaces?: string | null;
  /** Consequences beyond the cell: "Declines Person A's request". */
  consequences?: string[];
  confirmLabel?: string;
  /** Destructive confirm (delete, decline). */
  danger?: boolean;
}

/**
 * The A2 confirm-sheet pattern: full name, role, weekday + full date, times;
 * one big Confirm above a smaller Edit and Cancel. Used whenever an action
 * has a consequence beyond the cell — a drop onto a pending request, an
 * approval, a delete, publish.
 */
export function ConfirmSheet(props: {
  details: ConfirmDetails;
  onConfirm: () => Promise<void> | void;
  onEdit?: () => void;
  onCancel: () => void;
  disabled?: boolean;
  disabledReason?: React.ReactNode;
}) {
  const { details, onConfirm, onEdit, onCancel, disabled = false, disabledReason } = props;
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={details.dateLine} eyebrow={details.eyebrow ?? 'Confirm shift'} onClose={onCancel} width="sm" dismissable={false} hideClose>
      <div className="space-y-4">
        {details.personName !== null && (
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-border-strong bg-surface-raised text-sm font-bold">{details.initials ?? '?'}</span>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">{details.personName}</p>
              {details.roleLine && <p className="truncate text-xs text-muted-foreground">{details.roleLine}</p>}
            </div>
          </div>
        )}
        <div className="space-y-1">
          {details.timesLine && <p className={cn(DISPLAY, 'text-xl text-foreground')}>{details.timesLine}</p>}
          {details.replaces && <p className="text-sm text-muted-foreground">Replaces: {details.replaces}</p>}
          {details.consequences?.map((c) => (
            <p key={c} className="text-sm font-medium text-warning">
              {c}
            </p>
          ))}
        </div>
        <button type="button" data-autofocus onClick={() => void run()} disabled={busy || disabled} className={cn(btn.base, btn.lg, 'w-full', details.danger ? 'border-destructive bg-destructive text-destructive-foreground' : btn.gold)}>
          {busy ? 'Saving…' : (details.confirmLabel ?? 'Confirm')}
        </button>
        {disabledReason}
        <div className="grid grid-cols-2 gap-2">
          {onEdit ? (
            <button type="button" onClick={onEdit} disabled={busy} className={cn(btn.base, btn.plain)}>
              Edit
            </button>
          ) : (
            <span />
          )}
          <button type="button" onClick={onCancel} disabled={busy} className={cn(btn.base, btn.ghost)}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
