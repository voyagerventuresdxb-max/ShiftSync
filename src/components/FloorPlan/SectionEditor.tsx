import { useCallback, useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage, Line, Circle, Text as KonvaText, Group } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import useImage from 'use-image';
import {
  ApiError,
  createFloorSection,
  deleteFloorSection,
  updateFloorSection,
  uploadFloorPlanImage,
  type FloorPlanImageDto,
  type FloorSectionDto,
  type Point,
} from '../../api/floorPlan';
import { useIdentity } from '../../state/IdentityContext';
import { useAuthenticatedBlobUrl } from '../../hooks/useAuthenticatedBlobUrl';

interface Props {
  locationId: string;
  image: FloorPlanImageDto | null;
  sections: FloorSectionDto[];
  onChanged: (image: FloorPlanImageDto, sections: FloorSectionDto[]) => void;
  onDone: () => void;
}

/**
 * Phase 1 — one-time-per-venue setup. Manager draws freeform polygons over
 * the uploaded floor plan (Konva) and labels each one with a pax capacity.
 * Konva is only used here, for drawing — the daily assignment screen
 * (AssignmentBoard) re-renders the same saved polygons as plain DOM
 * overlays instead, since Konva shapes can't be dnd-kit drop targets.
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
    return (
      <div className="fp-upload-card">
        <p className="hint">
          Upload the venue's 2D floor plan (PDF, PNG, or JPG). It's stored on the server so every staff member sees
          the same plan.
        </p>
        {error && (
          <div className="error-block" role="alert">
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
        <button className="btn btn-primary" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Upload floor plan'}
        </button>
      </div>
    );
  }

  return <FloorPlanCanvas locationId={locationId} image={image} sections={sections} onChanged={onChanged} onDone={onDone} />;
}

const CLOSE_RADIUS = 12; // px in stage space — click near the first point to close the loop

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
  // Floor-plan images are now session-gated (see MEMORY.md) — `useImage`
  // just needs a URL string to load from, so a fetched `blob:` URL works
  // exactly like the old plain `image.fileUrl` did, once it's ready.
  const imageBlobUrl = useAuthenticatedBlobUrl(image.fileUrl, session?.token);
  const [img] = useImage(imageBlobUrl ?? '');
  const containerRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(800);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setStageWidth(Math.min(width, 900));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const aspect = img ? img.naturalHeight / img.naturalWidth : 0.6;
  const stageHeight = stageWidth * aspect;

  const [drawing, setDrawing] = useState<Point[]>([]); // pixel coords, stage space
  const [isDrawing, setIsDrawing] = useState(false);
  const [labeling, setLabeling] = useState(false);
  const [labelText, setLabelText] = useState('');
  const [paxText, setPaxText] = useState('');
  const [notesText, setNotesText] = useState('');
  const [saving, setSaving] = useState(false);

  const startDrawing = () => {
    setDrawing([]);
    setIsDrawing(true);
    setLabeling(false);
  };

  const cancelDrawing = () => {
    setDrawing([]);
    setIsDrawing(false);
    setLabeling(false);
    setNotesText('');
  };

  const closeShape = () => {
    if (drawing.length >= 3) setLabeling(true);
  };

  const handleStagePoint = (evt: KonvaEventObject<MouseEvent | TouchEvent | PointerEvent>) => {
    if (!isDrawing || labeling) return;
    const stage = evt.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;
    if (drawing.length >= 3) {
      const first = drawing[0];
      const dx = pos.x - first.x;
      const dy = pos.y - first.y;
      if (Math.sqrt(dx * dx + dy * dy) <= CLOSE_RADIUS) {
        setLabeling(true);
        return;
      }
    }
    setDrawing((prev) => [...prev, { x: pos.x, y: pos.y }]);
  };

  const saveSection = async () => {
    const label = labelText.trim();
    const pax = Number(paxText);
    if (!label) {
      setError('Give the section a label.');
      return;
    }
    if (!Number.isFinite(pax) || pax < 0) {
      setError('Pax capacity must be a non-negative number.');
      return;
    }
    // Section writes are manager-only server-side; with no session there is
    // no token to send and the request could only ever 401.
    if (!session) {
      setError('Your session has expired. Please sign in again.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const polygon: Point[] = drawing.map((p) => ({ x: p.x / stageWidth, y: p.y / stageHeight }));
      const section = await createFloorSection(session.token, {
        locationId,
        floorPlanImageId: image.id,
        label,
        polygon,
        paxCapacity: Math.round(pax),
        notes: notesText.trim() || null,
      });
      onChanged(image, [...sections, section]);
      setLabelText('');
      setPaxText('');
      setNotesText('');
      cancelDrawing();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the section.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSection = async (sectionId: string) => {
    // Section writes are manager-only server-side; with no session there is
    // no token to send and the request could only ever 401.
    if (!session) return;
    try {
      await deleteFloorSection(session.token, sectionId);
      onChanged(image, sections.filter((s) => s.id !== sectionId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the section.');
    }
  };

  const handleQuickEdit = async (sectionId: string, updates: { label?: string; paxCapacity?: number; notes?: string | null }) => {
    // Section writes are manager-only server-side; with no session there is
    // no token to send and the request could only ever 401.
    if (!session) return;
    try {
      const updated = await updateFloorSection(session.token, sectionId, updates);
      onChanged(image, sections.map((s) => (s.id === sectionId ? updated : s)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the section.');
    }
  };

  return (
    <div className="fp-editor">
      <div className="fp-toolbar">
        {!isDrawing ? (
          <button className="btn btn-primary" onClick={startDrawing}>
            + Draw section
          </button>
        ) : (
          <>
            <button className="btn btn-primary" onClick={closeShape} disabled={drawing.length < 3}>
              Close shape ({drawing.length} pts)
            </button>
            <button className="btn btn-ghost" onClick={cancelDrawing}>
              Cancel
            </button>
          </>
        )}
        <button className="btn btn-ghost" onClick={onDone} disabled={sections.length === 0}>
          Done — go to daily assignment
        </button>
      </div>

      <p className="hint">Click to place each corner of the section. Click the first point again (or "Close shape") to finish.</p>

      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}

      <div ref={containerRef} className="fp-canvas-wrap fp-canvas-wrap-editor">
        <Stage
          width={stageWidth}
          height={stageHeight}
          onClick={handleStagePoint}
          onTap={handleStagePoint}
          style={{ cursor: isDrawing ? 'crosshair' : 'default' }}
        >
          <Layer>
            {img && <KonvaImage image={img} width={stageWidth} height={stageHeight} />}

            {sections.map((s) => {
              const points = s.polygon.flatMap((p) => [p.x * stageWidth, p.y * stageHeight]);
              const centroidX = (s.polygon.reduce((sum, p) => sum + p.x, 0) / s.polygon.length) * stageWidth;
              const centroidY = (s.polygon.reduce((sum, p) => sum + p.y, 0) / s.polygon.length) * stageHeight;
              return (
                <Group key={s.id}>
                  <Line points={points} closed fill="rgba(229,169,60,0.22)" stroke="#e5a93c" strokeWidth={2} />
                  <KonvaText x={centroidX - 30} y={centroidY - 8} text={s.label} fontSize={13} fill="#f5eadb" align="center" width={60} />
                </Group>
              );
            })}

            {isDrawing && drawing.length > 0 && (
              <>
                <Line points={drawing.flatMap((p) => [p.x, p.y])} stroke="#e5a93c" strokeWidth={2} closed={false} dash={[6, 4]} />
                {drawing.map((p, idx) => (
                  <Circle
                    key={idx}
                    x={p.x}
                    y={p.y}
                    radius={idx === 0 ? CLOSE_RADIUS : 4}
                    fill={idx === 0 ? 'rgba(229,169,60,0.25)' : '#e5a93c'}
                    stroke="#e5a93c"
                  />
                ))}
              </>
            )}
          </Layer>
        </Stage>
      </div>

      {labeling && (
        <div className="fp-picker-backdrop" onClick={() => setLabeling(false)}>
          <div className="fp-picker" onClick={(e) => e.stopPropagation()}>
            <header className="fp-picker-head">
              <h3>New section</h3>
            </header>
            <input
              className="staff-directory-input"
              placeholder="Label (e.g. Section 1)"
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              autoFocus
            />
            <input
              className="staff-directory-input"
              placeholder="Pax capacity"
              type="number"
              min={0}
              value={paxText}
              onChange={(e) => setPaxText(e.target.value)}
            />
            <textarea
              className="staff-directory-input fp-notes-input"
              placeholder="Note (optional, e.g. Shade after 17:00)"
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              rows={2}
            />
            <div className="preview-actions">
              <button className="btn btn-ghost" onClick={() => setLabeling(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void saveSection()} disabled={saving}>
                {saving ? 'Saving…' : 'Save section'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="fp-section-list">
        <h3 className="section-title">Sections ({sections.length})</h3>
        {sections.length === 0 && <p className="hint">No sections drawn yet.</p>}
        {sections.map((s) => (
          <SectionListRow
            key={s.id}
            section={s}
            onDelete={() => void handleDeleteSection(s.id)}
            onEdit={(updates) => void handleQuickEdit(s.id, updates)}
          />
        ))}
      </div>
    </div>
  );
}

function SectionListRow({
  section,
  onDelete,
  onEdit,
}: {
  section: FloorSectionDto;
  onDelete: () => void;
  onEdit: (updates: { label?: string; paxCapacity?: number; notes?: string | null }) => void;
}) {
  const [label, setLabel] = useState(section.label);
  const [pax, setPax] = useState(String(section.paxCapacity));
  const [notes, setNotes] = useState(section.notes ?? '');

  useEffect(() => {
    setLabel(section.label);
    setPax(String(section.paxCapacity));
    setNotes(section.notes ?? '');
  }, [section.label, section.paxCapacity, section.notes]);

  return (
    <div className="fp-section-row">
      <input
        className="staff-directory-input staff-directory-input-inline"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label.trim() && label !== section.label && onEdit({ label: label.trim() })}
      />
      <input
        className="staff-directory-input staff-directory-input-inline fp-pax-input"
        type="number"
        min={0}
        value={pax}
        onChange={(e) => setPax(e.target.value)}
        onBlur={() => {
          const n = Number(pax);
          if (Number.isFinite(n) && n >= 0 && n !== section.paxCapacity) onEdit({ paxCapacity: Math.round(n) });
        }}
      />
      <input
        className="staff-directory-input staff-directory-input-inline fp-notes-input"
        placeholder="Note (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => notes.trim() !== (section.notes ?? '') && onEdit({ notes: notes.trim() || null })}
      />
      <button className="btn btn-ghost" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}
