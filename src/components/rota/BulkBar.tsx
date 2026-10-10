import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { ShiftTypeDto } from '../../../shared/rotaWeek';
import { btn } from './Dialog';

/**
 * Bulk actions (Design board B5): a floating bar while two or more cells are
 * selected (day header = column, name = row, Shift / ⌘ / Ctrl-click to
 * extend). Each action is one patch and one undo step; approved leave is
 * skipped and the toast says so ("Applied to 7 of 8 · 1 on leave skipped").
 */
export function BulkBar(props: {
  count: number;
  description: string;
  types: ShiftTypeDto[];
  disabled: boolean;
  onApply: (shiftTypeId: string) => void;
  onDayOff: () => void;
  onCopy: () => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  const { count, description, types, disabled, onApply, onDayOff, onCopy, onClear, onCancel } = props;
  const [typeId, setTypeId] = useState<string>(types[0]?.id ?? '');
  const chosen = types.find((t) => t.id === typeId) ?? types[0];
  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="fixed inset-x-0 bottom-24 z-40 mx-auto flex w-[min(100%-24px,900px)] flex-wrap items-center gap-2 rounded-2xl border border-border-strong bg-surface-raised p-2.5 shadow-lux motion-safe:animate-[rise_220ms_cubic-bezier(0.22,1,0.36,1)_both]"
    >
      <span className="me-1 min-w-0 truncate px-1.5 text-sm font-semibold">
        {count} cells{description ? ` · ${description}` : ''}
      </span>
      <span className="flex-1" />
      <span className="inline-flex items-stretch overflow-hidden rounded-[10px] border border-accent">
        <button type="button" disabled={disabled || !chosen} onClick={() => chosen && onApply(chosen.id)} className={cn(btn.base, btn.sm, btn.gold, 'rounded-none border-0')}>
          Apply {chosen?.name ?? 'type'}
        </button>
        <label htmlFor="bulk-type" className="sr-only">
          Shift type to apply
        </label>
        <select
          id="bulk-type"
          value={chosen?.id ?? ''}
          onChange={(e) => setTypeId(e.target.value)}
          disabled={disabled || types.length === 0}
          className="min-h-11 w-11 cursor-pointer appearance-none bg-accent text-center text-accent-foreground"
        >
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </span>
      <button type="button" disabled={disabled} onClick={onDayOff} className={cn(btn.base, btn.sm, btn.plain)}>
        Set day off
      </button>
      <button type="button" onClick={onCopy} className={cn(btn.base, btn.sm, btn.plain)}>
        Copy
      </button>
      <button type="button" disabled={disabled} onClick={onClear} className={cn(btn.base, btn.sm, btn.plain)}>
        Clear
      </button>
      <button type="button" onClick={onCancel} className={cn(btn.base, btn.sm, btn.ghost)}>
        Cancel
      </button>
    </div>
  );
}
