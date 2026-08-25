import { UserPlus, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { AssignmentSectionDto } from '../../api/floorPlan';
import { initials } from './staffFormat';

interface Props {
  section: AssignmentSectionDto;
  warn: boolean;
  onClose: () => void;
  onAssign: () => void;
  onRemoveAssignment: (assignmentId: string) => void;
}

/**
 * Full detail for one section, opened by tapping its pin on the canvas —
 * label, note, pax ratio (with the same warning reasoning shown as text,
 * not just a color), the full assignee list with per-person unassign, and
 * an entry point into the existing tap-to-pick staff picker.
 */
export default function SectionDetail({ section, warn, onClose, onAssign, onRemoveAssignment }: Props) {
  return (
    <div className="fp-picker-backdrop" onClick={onClose}>
      <div className="fp-picker" onClick={(e) => e.stopPropagation()}>
        <header className="fp-picker-head">
          <div className="min-w-0">
            <p className="eyebrow">Section</p>
            <h3 className="truncate">{section.label}</h3>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <div
          className={cn(
            'rounded-lg border px-3 py-2 text-sm',
            warn ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border bg-surface-raised text-muted-foreground',
          )}
        >
          <span className="font-semibold text-foreground">
            {section.assignments.length} / {section.paxCapacity}
          </span>{' '}
          pax assigned
          {warn && <p className="mt-1 text-xs">Looks understaffed compared to the venue's other sections.</p>}
        </div>

        {section.notes && (
          <p className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs text-muted-foreground">
            {section.notes}
          </p>
        )}

        <ul className="space-y-2">
          {section.assignments.map((a) => (
            <li key={a.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-border px-2.5 py-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border-strong bg-muted text-[10px] font-semibold">
                {initials(a.staffName)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{a.staffName}</p>
                {a.dutyLabel && <p className="truncate text-[11px] text-muted-foreground">{a.dutyLabel}</p>}
              </div>
              <button
                onClick={() => onRemoveAssignment(a.id)}
                aria-label={`Remove ${a.staffName}`}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border transition-colors hover:border-destructive/50 hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {section.assignments.length === 0 && <p className="hint">No staff assigned yet.</p>}
        </ul>

        <button
          onClick={onAssign}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-xs font-medium transition-colors hover:border-accent/50 hover:text-accent"
        >
          <UserPlus className="h-3.5 w-3.5" /> Assign staff
        </button>
      </div>
    </div>
  );
}
