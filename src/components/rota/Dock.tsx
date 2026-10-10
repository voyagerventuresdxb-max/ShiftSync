import { memo } from 'react';
import { useDraggable } from '@dnd-kit/react';
import { Feedback } from '@dnd-kit/dom';
import { Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRange, type LeaveTypeCode, type ShiftTint, type ShiftTypeDto } from '../../../shared/rotaWeek';
import type { DragSource } from '@/engine/rotaGrid';
import type { Clock } from './chips';

/**
 * The palette dock (B1, A3 "palette dock item"): the venue's shift types,
 * then Day off / Leave / Sick, on its own row that wraps instead of hiding
 * items. Each item is a draggable that always COPIES (its feedback is a
 * clone, the item stays put); 1–9 / 0 place the same items on the focused
 * cell, and a tap places on the focused cell too (touch tablets).
 */

const STATUS_ITEMS: { type: LeaveTypeCode; name: string; key?: string; swatch: React.CSSProperties }[] = [
  { type: 'DAY_OFF', name: 'Day off', key: '0', swatch: { border: '1px dashed color-mix(in oklab, var(--text) 45%, transparent)' } },
  { type: 'ANNUAL_LEAVE', name: 'Leave', swatch: { border: '1px solid color-mix(in oklab, var(--rota-sand) 65%, transparent)' } },
  { type: 'SICK_LEAVE', name: 'Sick', swatch: { border: '1px solid color-mix(in oklab, var(--rota-clay) 75%, transparent)' } },
];

export function tintSwatch(tint: ShiftTint): React.CSSProperties {
  return { background: `color-mix(in oklab, var(--rota-${tint}) 60%, transparent)` };
}

export function Dock(props: {
  types: ShiftTypeDto[];
  clock: Clock;
  disabled: boolean;
  onPick: (source: DragSource, label: string) => void;
  onEditTypes: () => void;
}) {
  const { types, clock, disabled, onPick, onEditTypes } = props;
  return (
    <div role="toolbar" aria-label="Shift types and statuses — drag onto the grid, or press the number key" className="flex flex-wrap items-center gap-1.5">
      <span className="eyebrow me-1">Drag onto the grid</span>
      {types.map((t, i) => (
        <DockItem
          key={t.id}
          id={`type:${t.id}`}
          source={{ kind: 'type', shiftTypeId: t.id }}
          name={t.name}
          time={`${t.ranges.map((r) => formatRange(r, clock)).join(' · ')}${t.endsNextDay ? ' +1' : ''}`}
          keyHint={i < 9 ? String(i + 1) : undefined}
          swatch={tintSwatch(t.tint)}
          disabled={disabled}
          onPick={onPick}
          aria={`${t.name} ${t.ranges.map((r) => `${r.start} to ${r.end}`).join(' and ')}${t.endsNextDay ? ', ends next day' : ''}${i < 9 ? `, drag or press ${i + 1}` : ''}`}
        />
      ))}
      <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-border-strong" />
      {STATUS_ITEMS.map((s) => (
        <DockItem
          key={s.type}
          id={`status:${s.type}`}
          source={{ kind: 'status', leaveType: s.type }}
          name={s.name}
          keyHint={s.key}
          swatch={s.swatch}
          disabled={disabled}
          onPick={onPick}
          aria={`${s.name}${s.key ? `, drag or press ${s.key}` : ''}`}
        />
      ))}
      <button
        type="button"
        onClick={onEditTypes}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-surface-raised hover:text-foreground"
      >
        <Settings2 aria-hidden="true" className="h-4 w-4" /> Shift types
      </button>
    </div>
  );
}

const CLONE = [Feedback.configure({ feedback: 'clone' })];

const DockItem = memo(function DockItem(p: {
  id: string;
  source: DragSource;
  name: string;
  time?: string;
  keyHint?: string;
  swatch: React.CSSProperties;
  disabled: boolean;
  aria: string;
  onPick: (source: DragSource, label: string) => void;
}) {
  const { ref, isDragging } = useDraggable({ id: p.id, data: p.source, disabled: p.disabled, plugins: CLONE });
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={p.disabled ? -1 : 0}
      aria-disabled={p.disabled || undefined}
      aria-label={p.aria}
      onClick={() => !p.disabled && p.onPick(p.source, p.name)}
      onKeyDown={(e) => {
        if (p.disabled) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          p.onPick(p.source, p.name);
        }
      }}
      className={cn(
        'inline-flex min-h-10 shrink-0 touch-manipulation select-none items-center gap-2 whitespace-nowrap rounded-[10px] border border-border-strong bg-surface-raised pe-2.5 ps-1.5 text-[13px] font-semibold outline-none [-webkit-touch-callout:none] focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_70%,transparent)]',
        p.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-grab',
        isDragging && 'shadow-lux ring-1 ring-accent',
      )}
    >
      <span aria-hidden="true" className="grid h-3.5 w-2 grid-cols-2 gap-0.5">
        {Array.from({ length: 6 }, (_, i) => (
          <i key={i} className="block h-[2.5px] w-[2.5px] rounded-full bg-muted-foreground/60" />
        ))}
      </span>
      <span aria-hidden="true" className="h-5 w-2.5 shrink-0 rounded-[3px]" style={p.swatch} />
      <span>{p.name}</span>
      {p.time && <span className="font-medium tabular-nums text-muted-foreground">{p.time}</span>}
      {p.keyHint && <span className="rounded-[5px] border border-border-strong px-[5px] text-[11px] font-semibold leading-[1.5] text-muted-foreground">{p.keyHint}</span>}
    </div>
  );
});
