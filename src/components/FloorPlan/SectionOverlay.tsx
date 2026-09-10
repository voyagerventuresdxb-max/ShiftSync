import type { CSSProperties } from 'react';
import { MapPin } from 'lucide-react';
import { useDroppable } from '@dnd-kit/react';
import { cn } from '../../lib/utils';
import type { AssignmentSectionDto, Point } from '../../api/floorPlan';
import { firstName, sectionPinName } from './staffFormat';

interface Props {
  section: AssignmentSectionDto;
  warn: boolean;
  onTap: () => void;
}

/**
 * Positions this overlay's DOM box to the section polygon's own bounding
 * rectangle (not the whole image) and clips to the polygon shape within
 * that box. This is what makes the box a meaningful dnd-kit drop target —
 * dnd-kit's hit-detection uses the *rectangle*, not the clip-path, so a
 * drop right at a bbox corner of a tightly-packed cluster can register
 * even when it's visually outside the shape. Accepted for v1 per the
 * kickoff brief; revisit only if real usage shows mis-drops.
 *
 * Also returns the polygon's centroid, expressed as a percent position
 * *within this same box* — that's where the pin badge is anchored, so it
 * sits over the actual drawn shape rather than the (possibly very
 * differently-proportioned) bounding box's geometric center.
 */
function boxGeometry(polygon: Point[]): { style: CSSProperties; centroid: { xPct: number; yPct: number } } {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 0.0001);
  const h = Math.max(maxY - minY, 0.0001);
  const clip = polygon
    .map((p) => `${(((p.x - minX) / w) * 100).toFixed(2)}% ${(((p.y - minY) / h) * 100).toFixed(2)}%`)
    .join(', ');
  const centroidX = polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length;
  const centroidY = polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length;
  return {
    style: {
      left: `${minX * 100}%`,
      top: `${minY * 100}%`,
      width: `${w * 100}%`,
      height: `${h * 100}%`,
      clipPath: `polygon(${clip})`,
    },
    centroid: {
      xPct: ((centroidX - minX) / w) * 100,
      yPct: ((centroidY - minY) / h) * 100,
    },
  };
}

/** "Unassigned" / "Andrea" / "Andrea +2" depending on headcount. */
function primaryLabel(section: AssignmentSectionDto): string {
  const [first, ...rest] = section.assignments;
  if (!first) return 'Unassigned';
  return rest.length > 0 ? `${firstName(first.staffName)} +${rest.length}` : firstName(first.staffName);
}

/**
 * A small pin-style marker (section number + primary assignee + pax ratio)
 * anchored to the drawn polygon's centroid. The polygon's own bounding box
 * — invisible here, just the drop target — still spans the full drawn
 * shape underneath, so drag-and-drop keeps its existing full-shape hit
 * area; only the *visual* changed to a compact pin. Tapping anywhere in
 * that area opens the full-detail panel (assignee list, notes, unassign,
 * assign staff) rather than showing everything inline on the canvas.
 */
export default function SectionOverlay({ section, warn, onTap }: Props) {
  const { ref, isDropTarget } = useDroppable({ id: section.id });
  const { style, centroid } = boxGeometry(section.polygon);

  return (
    <div
      ref={ref}
      className="absolute cursor-pointer"
      style={style}
      onClick={onTap}
      role="button"
      tabIndex={0}
      aria-label={`${section.label}, ${primaryLabel(section)}, ${section.assignments.length} of ${section.paxCapacity} pax`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onTap();
      }}
    >
      <div
        className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5"
        style={{ left: `${centroid.xPct}%`, top: `${centroid.yPct}%` }}
      >
        <span
          className={cn(
            'flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 shadow-sm backdrop-blur transition-colors',
            warn
              ? 'border-warning bg-warning/15 text-warning'
              : isDropTarget
                ? 'border-accent bg-accent/20 text-accent'
                : 'border-border-strong bg-background/90 text-foreground',
          )}
        >
          <MapPin className="h-2.5 w-2.5 shrink-0" />
          <span className="text-[9px] font-semibold leading-none">{sectionPinName(section.label)}</span>
        </span>
        <span className="whitespace-nowrap rounded-full bg-background/85 px-1.5 py-0.5 text-[8px] font-medium leading-none text-foreground shadow-sm">
          {primaryLabel(section)}
        </span>
        <span
          className={cn(
            'whitespace-nowrap rounded-full px-1.5 py-0.5 text-[8px] font-semibold leading-none',
            warn ? 'bg-warning/20 text-warning' : 'bg-muted text-muted-foreground',
          )}
        >
          {section.assignments.length}/{section.paxCapacity}
        </span>
      </div>
    </div>
  );
}
