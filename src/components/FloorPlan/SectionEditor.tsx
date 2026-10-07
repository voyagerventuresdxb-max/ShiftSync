import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import {
  ApiError,
  createFloorSection,
  deleteFloorSection,
  updateFloorSection,
  uploadFloorPlanImage,
  type FloorPlanImageDto,
  type FloorSectionDto,
} from '../../api/floorPlan';
import { useIdentity } from '../../state/IdentityContext';
import { useAuthenticatedBlobUrl } from '../../hooks/useAuthenticatedBlobUrl';
import { useCloseOnBack } from '../../lib/backNavigation';
import { PlanZoomViewport } from './planZoom';
import { SectionPin } from './SectionPin';
import { AddFirstSection } from './FloorPlanEmptyState';
import { fallbackSectionLabel } from './sectionNaming';

interface Props {
  locationId: string;
  image: FloorPlanImageDto | null;
  sections: FloorSectionDto[];
  onChanged: (image: FloorPlanImageDto, sections: FloorSectionDto[]) => void;
  onDone: () => void;
}

/**
 * One-time-per-venue setup. A section is a named pin on the uploaded floor
 * plan (2026-09-29 — drawn polygon boundaries were removed: managers know
 * their own floor, and a pin at each section's approximate spot is enough).
 * Tap the plan to drop a pin, drag a pin to move it, tap a pin to rename it,
 * change its pax or note, or delete it. Pins are the same `SectionPin` the
 * Daily Assignment board renders, and the plan zooms/pans the same way.
 */
export default function SectionEditor({ locationId, image, sections, onChanged, onDone }: Props) {
  const { session } = useIdentity();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(
    async (file: File) => {
      // Uploading is manager-only server-side; with no session there is no
      // token to send and the request could only ever 401.
      if (!session) return;
      setUploading(true);
      setError(null);
      try {
        const res = await uploadFloorPlanImage(session.token, file, locationId);
        onChanged(res.image, res.sections);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not upload the floor plan.');
      } finally {
        setUploading(false);
      }
    },
    [locationId, onChanged, session],
  );

  if (!image) {
    // No plan yet means no section yet either (a section is a pin on the plan).
    return (
      <AddFirstSection
        planUploaded={false}
        action={
          <button className="btn btn-primary" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Upload floor plan'}
          </button>
        }
      >
        <p className="mt-2 text-xs text-muted-foreground">PDF, PNG or JPG. Everyone at the venue sees the same plan.</p>
        {error && (
          <div className="error-block mt-3" role="alert">
            <p>{error}</p>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleUpload(file);
          }}
        />
      </AddFirstSection>
    );
  }

  return <FloorPlanCanvas locationId={locationId} image={image} sections={sections} onChanged={onChanged} onDone={onDone} />;
}

const TAP_SLOP = 8; // px a pin may move and still count as a tap (same as planZoom.tsx)
const NUDGE_STEP = 0.01; // arrow-key move, as a fraction of the plan (Shift = 5x)

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** The plan fraction (0-1) under a pointer. `plan` is inside the zoom layer, so its box already includes the zoom/pan. */
function planFraction(plan: Element, clientX: number, clientY: number): { x: number; y: number } {
  const r = plan.getBoundingClientRect();
  return { x: clamp01((clientX - r.left) / r.width), y: clamp01((clientY - r.top) / r.height) };
}

type SectionValues = { label: string; paxCapacity: number; notes: string | null };
type DialogState = { mode: 'new'; x: number; y: number } | { mode: 'edit'; section: FloorSectionDto };

function FloorPlanCanvas({
  locationId,
  image,
  sections,
  onChanged,
  onDone,
}: {
  locationId: string;
  image: FloorPlanImageDto;
  sections: FloorSectionDto[];
  onChanged: (image: FloorPlanImageDto, sections: FloorSectionDto[]) => void;
  onDone: () => void;
}) {
  const { session } = useIdentity();
  const imageBlobUrl = useAuthenticatedBlobUrl(image.fileUrl, session?.token);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  // While a pin is being dragged (and until its move is saved), its live position.
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<{ id: string; pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);

  // Section writes are manager-only server-side; with no session there is no
  // token to send and the request could only ever 401.
  const tokenOrError = (): string | null => {
    if (session) return session.token;
    setError('Your session has expired. Please sign in again.');
    return null;
  };

  const run = async (write: (token: string) => Promise<FloorSectionDto[]>, failure: string): Promise<boolean> => {
    const token = tokenOrError();
    if (!token) return false;
    try {
      onChanged(image, await write(token));
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : failure);
      return false;
    }
  };

  const createSection = (at: { x: number; y: number }, values: SectionValues) =>
    run(
      async (token) => [
        ...sections,
        await createFloorSection(token, { locationId, floorPlanImageId: image.id, pinX: at.x, pinY: at.y, ...values }),
      ],
      'Could not save the section.',
    );

  const updateSection = (sectionId: string, updates: Partial<SectionValues> & { pinX?: number; pinY?: number }) =>
    run(async (token) => {
      const updated = await updateFloorSection(token, sectionId, updates);
      return sections.map((s) => (s.id === sectionId ? updated : s));
    }, 'Could not update the section.');

  const deleteSection = (sectionId: string) =>
    run(async (token) => {
      await deleteFloorSection(token, sectionId);
      return sections.filter((s) => s.id !== sectionId);
    }, 'Could not delete the section.');

  // Tap on the plan (not on a pin) drops a new pin there. The click that
  // ends a pan never arrives: planZoom swallows it.
  const onPlanClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('[data-section-pin]')) return;
    setDialog({ mode: 'new', ...planFraction(e.currentTarget, e.clientX, e.clientY) });
  };

  // Pin drag, via pointer capture on the pin. planZoom never one-finger pans
  // from a `data-plan-drag-handle`, so dragging a pin doesn't move the plan;
  // a second finger turns it into a pinch, which takes the pointer capture
  // away from the pin and so cancels the drag (onLostPointerCapture).
  const onPinPointerDown = (s: FloorSectionDto) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: s.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
  };
  const onPinPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < TAP_SLOP) return;
    d.moved = true;
    setDragPos({ id: d.id, ...planFraction(e.currentTarget.parentElement!, e.clientX, e.clientY) });
  };
  const onPinPointerUp = (s: FloorSectionDto) => (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) {
      setDialog({ mode: 'edit', section: s });
      return;
    }
    const to = planFraction(e.currentTarget.parentElement!, e.clientX, e.clientY);
    setDragPos({ id: s.id, ...to });
    void updateSection(s.id, { pinX: to.x, pinY: to.y }).finally(() => setDragPos(null));
  };
  // Only a drag still in progress is cancelled: a normal release also fires
  // lostpointercapture, after pointerup has already cleared `drag`.
  const onPinPointerCancel = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragPos(null);
  };

  // Keyboard: Enter/Space edits; arrow keys move the pin (Shift = bigger steps).
  const onPinKeyDown = (s: FloorSectionDto) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setDialog({ mode: 'edit', section: s });
      return;
    }
    const step = e.shiftKey ? NUDGE_STEP * 5 : NUDGE_STEP;
    const move = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[e.key];
    if (!move) return;
    e.preventDefault();
    void updateSection(s.id, { pinX: clamp01(s.pinX + move[0]), pinY: clamp01(s.pinY + move[1]) });
  };

  return (
    <div className="fp-editor">
      {sections.length === 0 ? (
        // First section: "Add first section" drops its pin mid-plan (then drag
        // it into place); tapping the plan directly works as it always has.
        <AddFirstSection
          planUploaded
          action={
            <button className="btn btn-primary" onClick={() => setDialog({ mode: 'new', x: 0.5, y: 0.5 })}>
              Add first section
            </button>
          }
        >
          <p className="mt-2 text-xs text-muted-foreground">Or tap the plan below where it sits. You can drag a pin to move it.</p>
        </AddFirstSection>
      ) : (
        <>
          <div className="fp-toolbar">
            <button className="btn btn-ghost" onClick={onDone}>
              Done — go to daily assignment
            </button>
          </div>

          <p className="hint">Tap the plan to drop a section pin. Drag a pin to move it; tap it to rename or delete.</p>
        </>
      )}

      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}

      <PlanZoomViewport className="fp-canvas-wrap fp-canvas-wrap-editor">
        <div className="relative" onClick={onPlanClick}>
          {imageBlobUrl && <img src={imageBlobUrl} alt="Venue floor plan" className="fp-image" draggable={false} />}
          {sections.map((s) => {
            const pos = dragPos?.id === s.id ? dragPos : { x: s.pinX, y: s.pinY };
            return (
              <SectionPin
                key={s.id}
                label={s.label}
                x={pos.x}
                y={pos.y}
                secondary={s.label}
                tertiary={`${s.paxCapacity} pax`}
                tone={dragPos?.id === s.id ? 'active' : 'default'}
                note={s.notes}
                role="button"
                tabIndex={0}
                aria-label={`${s.label}, ${s.paxCapacity} pax. Drag or use the arrow keys to move; Enter to edit.`}
                data-plan-drag-handle
                className="cursor-grab touch-none select-none"
                onPointerDown={onPinPointerDown(s)}
                onPointerMove={onPinPointerMove}
                onPointerUp={onPinPointerUp(s)}
                onPointerCancel={onPinPointerCancel}
                onLostPointerCapture={onPinPointerCancel}
                onKeyDown={onPinKeyDown(s)}
              />
            );
          })}
        </div>
      </PlanZoomViewport>

      {dialog && (
        <SectionDialog
          key={dialog.mode === 'edit' ? dialog.section.id : `new-${dialog.x}-${dialog.y}`}
          editing={dialog.mode === 'edit' ? dialog.section : null}
          fallbackLabel={fallbackSectionLabel(sections.map((s) => s.label))}
          onClose={() => setDialog(null)}
          onSubmit={async (values) => {
            const ok =
              dialog.mode === 'new' ? await createSection({ x: dialog.x, y: dialog.y }, values) : await updateSection(dialog.section.id, values);
            if (ok) setDialog(null);
          }}
          onDelete={async () => {
            if (dialog.mode === 'edit' && (await deleteSection(dialog.section.id))) setDialog(null);
          }}
        />
      )}

      {sections.length > 0 && (
        <div className="fp-section-list">
          <h3 className="section-title">Sections ({sections.length})</h3>
          {sections.map((s) => (
            <button key={s.id} className="fp-picker-item" onClick={() => setDialog({ mode: 'edit', section: s })}>
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="cell-num shrink-0">{s.paxCapacity} pax</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * New / edit form for one section pin: name, pax, note — and, when editing, a
 * two-step Delete (the first tap asks, the second deletes; deleting a section
 * also removes its assignments server-side). A new section's name starts
 * empty with real examples; left blank, it is saved as `fallbackLabel`.
 */
function SectionDialog({
  editing,
  fallbackLabel,
  onClose,
  onSubmit,
  onDelete,
}: {
  editing: FloorSectionDto | null;
  fallbackLabel: string;
  onClose: () => void;
  onSubmit: (values: SectionValues) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [label, setLabel] = useState(editing?.label ?? '');
  const [pax, setPax] = useState(editing ? String(editing.paxCapacity) : '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useCloseOnBack(true, onClose);
  const labelRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    labelRef.current?.select();
  }, []);

  const submit = async () => {
    const trimmed = label.trim() || (editing ? '' : fallbackLabel);
    const paxNumber = Number(pax);
    if (!trimmed) return setError('Give the section a name.');
    if (!Number.isFinite(paxNumber) || paxNumber < 0) return setError('Pax capacity must be a non-negative number.');
    setBusy(true);
    setError(null);
    await onSubmit({ label: trimmed, paxCapacity: Math.round(paxNumber), notes: notes.trim() || null });
    setBusy(false);
  };

  return (
    <div className="fp-picker-backdrop" onClick={onClose}>
      <div className="fp-picker" role="dialog" aria-label={editing ? `Edit ${editing.label}` : 'New section'} onClick={(e) => e.stopPropagation()}>
        <header className="fp-picker-head">
          <h3>{editing ? 'Edit section' : 'New section'}</h3>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <input
          ref={labelRef}
          className="staff-directory-input"
          aria-label="Section name"
          placeholder="Name, e.g. Terrace, Bar, Main floor"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          autoFocus
        />
        {!editing && !label.trim() && <p className="text-xs text-muted-foreground">Left blank, it's saved as “{fallbackLabel}”.</p>}
        <input
          className="staff-directory-input"
          aria-label="Pax capacity"
          placeholder="Pax capacity"
          type="number"
          inputMode="numeric"
          min={0}
          value={pax}
          onChange={(e) => setPax(e.target.value)}
        />
        <textarea
          className="staff-directory-input fp-notes-input"
          aria-label="Note"
          placeholder="Note (optional, e.g. Shade after 17:00)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        {confirmingDelete ? (
          <div className="preview-actions" role="group" aria-label="Confirm delete">
            <span className="mr-auto self-center text-xs text-muted-foreground">Delete {editing?.label} and its assignments?</span>
            <button className="btn btn-ghost" onClick={() => setConfirmingDelete(false)} disabled={busy}>
              Keep
            </button>
            <button
              className="btn btn-ghost border-destructive/50 text-destructive"
              onClick={async () => {
                setBusy(true);
                await onDelete();
                setBusy(false);
              }}
              disabled={busy}
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        ) : (
          <div className="preview-actions">
            {editing && (
              <button className="btn btn-ghost mr-auto" onClick={() => setConfirmingDelete(true)} disabled={busy}>
                Delete…
              </button>
            )}
            <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save' : 'Add section'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
