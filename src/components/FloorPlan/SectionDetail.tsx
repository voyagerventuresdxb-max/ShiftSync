import { useState } from 'react';
import { BellRing, Check, UserPlus, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { AssignmentSectionDto } from '../../api/floorPlan';
import { initials } from './staffFormat';

interface Props {
  section: AssignmentSectionDto;
  warn: boolean;
  onClose: () => void;
  onAssign: () => void;
  onRemoveAssignment: (assignmentId: string) => void;
  onNotify: (assignmentId: string) => Promise<void>;
  onUpdateDutyLabel: (assignmentId: string, dutyLabel: string) => void;
  /** True for a non-manager session — view-only: no assign/notify/remove/duty-edit, matching the server's own manager-only gate on those writes. */
  readOnly?: boolean;
}

/**
 * Full detail for one section, opened by tapping its pin on the canvas —
 * label, note, pax ratio (with the same warning reasoning shown as text,
 * not just a color), the full assignee list with per-person unassign, and
 * an entry point into the existing tap-to-pick staff picker.
 */
export default function SectionDetail({
  section,
  warn,
  onClose,
  onAssign,
  onRemoveAssignment,
  onNotify,
  onUpdateDutyLabel,
  readOnly = false,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [notifyingId, setNotifyingId] = useState<string | null>(null);

  return (
    <div className="fp-picker-backdrop" onClick={onClose}>
      <div className="fp-picker" onClick={(e) => e.stopPropagation()}>
        <header className="fp-picker-head">
          <div className="min-w-0">
            <p className="eyebrow">Section</p>
            <h3 className="truncate">{section.label}</h3>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
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
            <li key={a.id} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border px-2.5 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border-strong bg-muted text-[10px] font-semibold">
                  {initials(a.staffName)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{a.staffName}</p>
                  {readOnly ? (
                    <p className="truncate text-[11px] text-muted-foreground">{a.dutyLabel || '—'}</p>
                  ) : editingId === a.id ? (
                    <input
                      autoFocus
                      className="staff-directory-input mt-0.5 w-full text-[11px]"
                      value={draftLabel}
                      onChange={(e) => setDraftLabel(e.target.value)}
                      onBlur={() => {
                        const trimmed = draftLabel.trim();
                        // Skip the write entirely when nothing actually
                        // changed — a plain tap-to-view-then-click-away
                        // shouldn't write an audit row or trigger a refetch.
                        if (trimmed !== (a.dutyLabel ?? '')) {
                          onUpdateDutyLabel(a.id, trimmed);
                        }
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                      }}
                    />
                  ) : (
                    <button
                      className="truncate text-left text-[11px] text-muted-foreground hover:text-accent"
                      onClick={() => {
                        setEditingId(a.id);
                        setDraftLabel(a.dutyLabel ?? '');
                      }}
                    >
                      {a.dutyLabel || 'Add duty…'}
                    </button>
                  )}
                </div>
                {!readOnly && (
                  <button
                    onClick={() => onRemoveAssignment(a.id)}
                    aria-label={`Remove ${a.staffName}`}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border transition-colors hover:border-destructive/50 hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 pl-9">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                    a.notifiedAt ? 'border-success/25 bg-success/12 text-success' : 'border-border bg-muted text-muted-foreground',
                  )}
                >
                  {a.notifiedAt ? <Check className="h-2.5 w-2.5" /> : <BellRing className="h-2.5 w-2.5" />}
                  {a.notifiedAt ? 'Notified' : 'Not sent'}
                </span>
                {/* Always available (to a manager): after a reassignment (or
                    a later shift change) a manager needs to be able to
                    notify the same person again — the badge to the left,
                    not this button's presence, is what reports notification
                    status. */}
                {!readOnly && (
                  <button
                    onClick={async () => {
                      setNotifyingId(a.id);
                      try {
                        await onNotify(a.id);
                      } finally {
                        setNotifyingId(null);
                      }
                    }}
                    disabled={notifyingId === a.id}
                    aria-label={`${a.notifiedAt ? 'Re-notify' : 'Notify'} ${a.staffName}`}
                    className="text-[10px] font-medium text-accent hover:underline disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {notifyingId === a.id ? 'Notifying…' : a.notifiedAt ? 'Re-notify' : 'Notify'}
                  </button>
                )}
              </div>
            </li>
          ))}
          {section.assignments.length === 0 && <p className="hint">No staff assigned yet.</p>}
        </ul>

        {!readOnly && (
          <button
            onClick={onAssign}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-xs font-medium transition-colors hover:border-accent/50 hover:text-accent"
          >
            <UserPlus className="h-3.5 w-3.5" /> Assign staff
          </button>
        )}
      </div>
    </div>
  );
}
