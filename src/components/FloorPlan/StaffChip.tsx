import { useDraggable } from '@dnd-kit/react';
import { cn } from '../../lib/utils';
import { initials } from './staffFormat';

interface Props {
  staffId: string;
  staffName: string;
  assignedCount: number;
  /** True for a non-manager session — assignment is a manager-only action, so the chip is inert rather than draggable (see AssignmentBoard). */
  disabled?: boolean;
}

/** A draggable roster-strip chip — the drag-and-drop source for staff assignment. */
export default function StaffChip({ staffId, staffName, assignedCount, disabled = false }: Props) {
  const { ref, isDragging } = useDraggable({ id: staffId, data: { staffName }, disabled });
  return (
    <div
      ref={ref}
      className={cn(
        'flex shrink-0 touch-none select-none items-center gap-2 rounded-full border border-border bg-surface-raised px-2.5 py-1.5 text-sm text-foreground transition-opacity',
        disabled ? 'cursor-default' : 'cursor-grab',
        isDragging && 'border-accent opacity-50',
      )}
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border-strong bg-muted text-[10px] font-semibold">
        {initials(staffName)}
      </span>
      <span className="truncate">{staffName}</span>
      {assignedCount > 0 && (
        <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground">
          {assignedCount}
        </span>
      )}
    </div>
  );
}
