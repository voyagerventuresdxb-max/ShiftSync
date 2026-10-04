import { useDroppable } from '@dnd-kit/react';
import type { AssignmentSectionDto } from '../../api/floorPlan';
import { firstName } from './staffFormat';
import { SectionPin, truncateNote } from './SectionPin';

interface Props {
  section: AssignmentSectionDto;
  warn: boolean;
  onTap: () => void;
}

/** "Unassigned" / "Kalim" / "Kalim +2" depending on headcount. */
function primaryLabel(section: AssignmentSectionDto): string {
  const [first, ...rest] = section.assignments;
  if (!first) return 'Unassigned';
  return rest.length > 0 ? `${firstName(first.staffName)} +${rest.length}` : firstName(first.staffName);
}

/**
 * One section on the Daily Assignment board: a pin (section number + primary
 * assignee + pax ratio) at the section's point on the plan. The pin itself is
 * both the dnd-kit drop target for staff chips and the tap target that opens
 * the full-detail panel (assignee list, notes, unassign, assign staff).
 *
 * Sections used to be drawn polygons whose bounding box was the drop target
 * (2026-09-29: replaced by pin-only sections, see Decisions.md). In dense
 * clusters pins can overlap at 1x — zooming in (planZoom.tsx) separates them.
 */
export default function SectionOverlay({ section, warn, onTap }: Props) {
  const { ref, isDropTarget } = useDroppable({ id: section.id });

  return (
    <SectionPin
      ref={ref}
      label={section.label}
      x={section.pinX}
      y={section.pinY}
      secondary={primaryLabel(section)}
      tertiary={`${section.assignments.length}/${section.paxCapacity}`}
      tone={warn ? 'warn' : isDropTarget ? 'active' : 'default'}
      note={section.notes}
      onClick={onTap}
      role="button"
      tabIndex={0}
      aria-label={`${section.label}, ${primaryLabel(section)}, ${section.assignments.length} of ${section.paxCapacity} pax${
        section.notes ? `, note: ${truncateNote(section.notes)}` : ''
      }`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onTap();
      }}
    />
  );
}
