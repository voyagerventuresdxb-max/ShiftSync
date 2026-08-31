import { useCallback, useEffect, useMemo, useState } from 'react';
import { DragDropProvider } from '@dnd-kit/react';
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import {
  ApiError,
  assignStaff,
  fetchAssignments,
  notifyAssignment,
  publishAssignments,
  removeAssignment,
  type AssignmentSectionDto,
  type FloorPlanImageDto,
} from '../../api/floorPlan';
import { fetchStaffDirectory, type StaffDirectoryEntry } from '../../api/staffDirectory';
import { useIdentity } from '../../state/IdentityContext';
import { useAuthenticatedBlobUrl } from '../../hooks/useAuthenticatedBlobUrl';
import StaffChip from './StaffChip';
import SectionOverlay from './SectionOverlay';
import SectionDetail from './SectionDetail';
import SectionPicker from './SectionPicker';

// Local calendar date, not UTC — `toISOString()` would show yesterday's
// date for the first ~4 hours of the day in Dubai (UTC+4), which is exactly
// when a floor manager might be publishing the next day's assignments.
function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Per the kickoff brief: touch gets a delay (so scrolling the roster strip
// doesn't accidentally start a drag), mouse gets a distance threshold. A
// documented dnd-kit config option, not custom hit-testing code.
const sensors = [
  PointerSensor.configure({
    activationConstraints(event: PointerEvent) {
      return event.pointerType === 'touch'
        ? [new PointerActivationConstraints.Delay({ value: 500, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 8 })];
    },
  }),
  KeyboardSensor,
];

interface Props {
  locationId: string;
  onEditSections: () => void;
}

/**
 * Phase 2 — daily assignment screen. Renders the floor plan as a static
 * `<img>` with each saved section as an absolutely-positioned DOM overlay
 * (the real dnd-kit drop target — Konva shapes are never drop targets, see
 * the kickoff brief). Drag-and-drop and tap-to-pick both write through the
 * same `assignStaff` call.
 */
export default function AssignmentBoard({ locationId, onEditSections }: Props) {
  // The signed-in manager. Every mutation below writes an AuditLog row with
  // the actor derived server-side from this session's Bearer token — never
  // from a client-supplied id.
  const { session } = useIdentity();
  const [date, setDate] = useState(todayIso());
  const [period, setPeriod] = useState<'AM' | 'PM'>('AM');
  const [image, setImage] = useState<FloorPlanImageDto | null>(null);
  // Floor-plan images are now session-gated (see MEMORY.md) — a plain <img
  // src> can't attach the Bearer header the file route now requires.
  const imageBlobUrl = useAuthenticatedBlobUrl(image?.fileUrl, session?.token);
  const [sections, setSections] = useState<AssignmentSectionDto[]>([]);
  const [staff, setStaff] = useState<StaffDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSectionId, setExpandedSectionId] = useState<string | null>(null);
  const [pickerSectionId, setPickerSectionId] = useState<string | null>(null);
  const [suppressClick, setSuppressClick] = useState(false);
  // Capture the date/period the publish actually ran against alongside its
  // count, so switching date or AM/PM afterwards can't leave the banner
  // describing a publish that never happened for the newly-selected key.
  const [publishResult, setPublishResult] = useState<{ count: number; date: string; period: 'AM' | 'PM' } | null>(null);
  const [publishing, setPublishing] = useState(false);

  const load = useCallback(() => {
    // Both the assignments read and the Staff Directory read are
    // session-gated server-side now — with no session yet there is no token
    // to send, so skip the load entirely rather than firing requests that
    // can only 401.
    if (!session) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    Promise.all([fetchAssignments(session.token, locationId, date, period), fetchStaffDirectory(session.token, locationId)])
      .then(([data, staffList]) => {
        setImage(data.image);
        setSections(data.sections);
        // Staff Directory now returns terminated staff too (so managers can
        // see/un-terminate them) — the Floor Plan board must not offer them
        // as assignable, so filter to active staff before it ever reaches
        // state used by the roster strip or the section picker.
        setStaff(staffList.filter((s) => s.isActive !== false));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the floor plan.'))
      .finally(() => setLoading(false));
  }, [locationId, date, period, session]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAssign = useCallback(
    async (sectionId: string, staffId: string, dutyLabel?: string | null) => {
      // Assigning is manager-only server-side; with no session there is no
      // token to send and the request could only ever 401.
      if (!session) return;
      try {
        // Only send the dutyLabel key when the caller actually gave one
        // (the tap-to-pick picker, with something typed). A plain
        // drag-drop assign — or a picker pick with the duty field left
        // blank — omits the key entirely, so the server's upsert leaves
        // any label already on that row untouched instead of wiping it
        // back to null on every re-assign.
        await assignStaff(session.token, {
          sectionId,
          staffId,
          shiftDate: date,
          period,
          ...(dutyLabel ? { dutyLabel } : {}),
        });
        load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not assign staff.');
      }
    },
    [date, period, load, session],
  );

  const handleRemove = useCallback(
    async (assignmentId: string) => {
      // Removing is manager-only server-side; with no session there is no
      // token to send and the request could only ever 401.
      if (!session) return;
      try {
        await removeAssignment(session.token, assignmentId);
        load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not remove that assignment.');
      }
    },
    [load, session],
  );

  const handleNotify = useCallback(
    async (assignmentId: string) => {
      // Notifying is manager-only server-side; with no session there is no
      // token to send and the request could only ever 401.
      if (!session) return;
      try {
        await notifyAssignment(session.token, assignmentId);
        load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not mark this assignment notified.');
      }
    },
    [load, session],
  );

  const handleUpdateDutyLabel = useCallback(
    async (assignmentId: string, dutyLabel: string) => {
      // Duty-label edits reuse the same upsert-friendly assign endpoint the
      // Task 5 picker already writes through — but an edit must target the
      // EXISTING assignment's own section/staff/date/period, not re-derive
      // them, since this handler only ever receives an assignmentId. Look
      // the assignment up in current `sections` state to get its real
      // sectionId/staffId before calling assignStaff.
      const owning = sections.find((s) => s.assignments.some((a) => a.id === assignmentId));
      const assignment = owning?.assignments.find((a) => a.id === assignmentId);
      if (!owning || !assignment) return;
      // Editing is manager-only server-side; with no session there is no
      // token to send and the request could only ever 401.
      if (!session) return;
      try {
        await assignStaff(session.token, {
          sectionId: owning.id,
          staffId: assignment.staffId,
          shiftDate: date,
          period,
          dutyLabel,
        });
        load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not update the duty label.');
      }
    },
    [sections, date, period, load, session],
  );

  const handlePublish = useCallback(async () => {
    // Publishing is manager-only server-side; with no session there is no
    // token to send and the request could only ever 401.
    if (!session) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      const res = await publishAssignments(session.token, locationId, date, period);
      setPublishResult({ count: res.publishedCount, date, period });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not publish assignments.');
    } finally {
      setPublishing(false);
    }
  }, [locationId, date, period, load, session]);

  // Soft pax-capacity warning: flag a high-capacity section whose
  // assigned-headcount ratio looks thin next to sections that do have
  // staff on them — a comparative signal (per the brief), not a fixed
  // headcount floor, and never a hard block.
  const warnedSectionIds = useMemo(() => {
    const withStaff = sections.filter((s) => s.assignments.length > 0 && s.paxCapacity > 0);
    if (withStaff.length < 2 || sections.length === 0) return new Set<string>();
    const avgRatio = withStaff.reduce((sum, s) => sum + s.assignments.length / s.paxCapacity, 0) / withStaff.length;
    const avgCapacity = sections.reduce((sum, s) => sum + s.paxCapacity, 0) / sections.length;
    const flagged = new Set<string>();
    for (const s of sections) {
      if (s.paxCapacity <= 0 || s.paxCapacity < avgCapacity) continue;
      const ratio = s.assignments.length / s.paxCapacity;
      if (ratio < avgRatio * 0.5) flagged.add(s.id);
    }
    return flagged;
  }, [sections]);

  const pickerSection = sections.find((s) => s.id === pickerSectionId) ?? null;
  const expandedSection = sections.find((s) => s.id === expandedSectionId) ?? null;

  if (loading) {
    return (
      <div className="status-block">
        <span className="spinner" aria-hidden />
        <p>Loading floor plan…</p>
      </div>
    );
  }

  if (error && !image && sections.length === 0) {
    return (
      <div className="error-block" role="alert">
        <p>{error}</p>
      </div>
    );
  }

  if (!image) {
    return (
      <div className="status-block">
        <p>No floor plan uploaded for this venue yet.</p>
        <button className="btn btn-primary" onClick={onEditSections}>
          Upload floor plan
        </button>
      </div>
    );
  }

  if (sections.length === 0) {
    return (
      <div className="status-block">
        <p>Floor plan uploaded, but no sections drawn yet.</p>
        <button className="btn btn-primary" onClick={onEditSections}>
          Draw sections
        </button>
      </div>
    );
  }

  return (
    <div className="fp-board">
      <div className="fp-toolbar">
        <input type="date" className="staff-directory-input" value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="fp-period-toggle" role="tablist" aria-label="Period">
          {(['AM', 'PM'] as const).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={period === p}
              className={`chip${period === p ? ' chip-active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p}
            </button>
          ))}
        </div>
        <button className="btn btn-ghost" onClick={onEditSections}>
          Edit sections
        </button>
        <button className="btn btn-primary" onClick={() => void handlePublish()} disabled={publishing}>
          {publishing ? 'Publishing…' : 'Publish & notify'}
        </button>
      </div>

      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}

      {publishResult !== null && (
        <div className="success-block" role="status">
          <p>
            {publishResult.count} assignment{publishResult.count === 1 ? '' : 's'} published and marked notified for{' '}
            {publishResult.date} ({publishResult.period}).
          </p>
        </div>
      )}

      <DragDropProvider
        sensors={sensors}
        onDragStart={() => setSuppressClick(true)}
        onDragEnd={(event) => {
          setTimeout(() => setSuppressClick(false), 200);
          if (event.canceled) return;
          const staffId = event.operation.source?.id;
          const sectionId = event.operation.target?.id;
          if (staffId == null || sectionId == null) return;
          void handleAssign(String(sectionId), String(staffId));
        }}
      >
        <div className="fp-roster-strip">
          {staff.map((s) => (
            <StaffChip
              key={s.id}
              staffId={s.id}
              staffName={s.fullName}
              assignedCount={sections.reduce((n, sec) => n + sec.assignments.filter((a) => a.staffId === s.id).length, 0)}
            />
          ))}
          {staff.length === 0 && <p className="hint">No staff in the directory yet.</p>}
        </div>

        <div className="fp-canvas-wrap">
          {imageBlobUrl && <img src={imageBlobUrl} alt="Venue floor plan" className="fp-image" draggable={false} />}
          {sections.map((section) => (
            <SectionOverlay
              key={section.id}
              section={section}
              warn={warnedSectionIds.has(section.id)}
              onTap={() => {
                if (!suppressClick) setExpandedSectionId(section.id);
              }}
            />
          ))}
        </div>
      </DragDropProvider>

      {expandedSection && (
        <SectionDetail
          section={expandedSection}
          warn={warnedSectionIds.has(expandedSection.id)}
          onClose={() => setExpandedSectionId(null)}
          onAssign={() => {
            setPickerSectionId(expandedSection.id);
            setExpandedSectionId(null);
          }}
          onRemoveAssignment={(assignmentId) => void handleRemove(assignmentId)}
          onNotify={handleNotify}
          onUpdateDutyLabel={(assignmentId, dutyLabel) => void handleUpdateDutyLabel(assignmentId, dutyLabel)}
        />
      )}

      {pickerSection && (
        <SectionPicker
          sectionLabel={pickerSection.label}
          staff={staff}
          onPick={(staffId, dutyLabel) => {
            void handleAssign(pickerSection.id, staffId, dutyLabel);
            setPickerSectionId(null);
          }}
          onClose={() => setPickerSectionId(null)}
        />
      )}
    </div>
  );
}
