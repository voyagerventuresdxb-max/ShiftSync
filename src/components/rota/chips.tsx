import { FileText } from 'lucide-react';
import { LEAVE_LABELS, formatRange, type LeaveTypeCode, type ShiftTint, type ShiftTypeDto, type WeekShiftDto } from '../../../shared/rotaWeek';

/**
 * Rota builder v2 chip primitives (Design board A3), shared by the week grid,
 * the phone views, Team Matrix and the staff week. Styling lives in
 * src/styles/rota.css (theme variables only — no colour literals).
 */

export type Clock = '12h' | '24h';

/** A shift's display name: its venue type's name, else "Custom". */
export function shiftName(shift: Pick<WeekShiftDto, 'shiftTypeId'>, types: ShiftTypeDto[]): string {
  return types.find((t) => t.id === shift.shiftTypeId)?.name ?? 'Custom';
}

export function shiftTint(shift: Pick<WeekShiftDto, 'shiftTypeId'>, types: ShiftTypeDto[]): ShiftTint {
  return types.find((t) => t.id === shift.shiftTypeId)?.tint ?? 'cream';
}

/** One-letter code for dense views (Team Matrix, paint tiles): the type's initial, "S" for split, "C" for custom. */
export function shiftCode(shift: Pick<WeekShiftDto, 'shiftTypeId' | 'ranges'>, types: ShiftTypeDto[]): string {
  const name = types.find((t) => t.id === shift.shiftTypeId)?.name;
  if (name) return name.trim().charAt(0).toUpperCase();
  return shift.ranges.length > 1 ? 'S' : 'C';
}

/** Screen-reader sentence for a shift: "Omar Al-Rashid, Friday 9 October, Evening 16:00 to 01:00, ends next day, published". */
export function shiftAccessibleName(input: {
  personName: string | null;
  date: string;
  shift: WeekShiftDto;
  types: ShiftTypeDto[];
}): string {
  const { personName, date, shift, types } = input;
  const day = new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const times = shift.ranges.map((r) => `${r.start} to ${r.end}`).join(' and ');
  const parts = [personName ?? 'Open shift', day, `${shiftName(shift, types)} ${times}`];
  if (shift.endsNextDay) parts.push('ends next day');
  if (shift.note) parts.push(`note: ${shift.note}`);
  parts.push(shift.status === 'draft' || shift.editedSincePublish ? 'unpublished change' : 'published');
  return parts.join(', ');
}

export function ShiftChip(props: {
  shift: WeekShiftDto;
  types: ShiftTypeDto[];
  clock: Clock;
  compact?: boolean;
  ghost?: boolean;
  /** Open (unassigned) shift: dashed ochre, "Needs 1 more". */
  open?: boolean;
  /** The week has been published at least once, so a new draft shift is an unpublished change too. */
  weekPublished?: boolean;
  className?: string;
}) {
  const { shift, types, clock, compact = false, ghost = false, open = shift.userId === null, weekPublished = false, className } = props;
  const unpublished = shift.editedSincePublish || (weekPublished && shift.status === 'draft');
  const last = shift.ranges.length - 1;
  return (
    <div
      className={`rota-chip${className ? ` ${className}` : ''}`}
      data-tint={shiftTint(shift, types)}
      data-open={open ? 'true' : undefined}
      data-ghost={ghost ? 'true' : undefined}
      data-compact={compact ? 'true' : undefined}
    >
      <span className="rota-chip__name">
        <span>{shiftName(shift, types)}</span>
        {shift.note && <FileText aria-hidden="true" size={12} strokeWidth={2} className="shrink-0 opacity-85" />}
      </span>
      {shift.ranges.map((r, i) => (
        <span key={i} className="rota-chip__time">
          {formatRange(r, clock)}
          {i === last && shift.endsNextDay && (
            <span className="rota-next-day" title="Ends next day">
              +1
            </span>
          )}
        </span>
      ))}
      {open && <span className="rota-chip__time">Needs 1 more</span>}
      {!open && unpublished && <span className="rota-edited-dot" title="Changed since publish" />}
    </div>
  );
}

export function StatusChip(props: { type: LeaveTypeCode | 'OFF_REQUESTED'; compact?: boolean; requested?: boolean; edited?: boolean; locked?: boolean }) {
  const { type, compact = false, requested = false, edited = false, locked = false } = props;
  const label = type === 'OFF_REQUESTED' ? 'Off requested' : `${LEAVE_LABELS[type]}${requested ? ' · requested' : ''}`;
  return (
    <div
      className="rota-status"
      data-type={type === 'OFF_REQUESTED' ? 'DAY_OFF' : type}
      data-requested={requested || type === 'OFF_REQUESTED' ? 'true' : undefined}
      data-compact={compact ? 'true' : undefined}
    >
      {locked && (
        <svg aria-label="Locked" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="10" width="16" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      )}
      <span>{label}</span>
      {edited && <span className="rota-edited-dot" title="Changed since publish" />}
    </div>
  );
}
