import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchFloorPlan, type FloorPlanImageDto, type FloorSectionDto } from '../../api/floorPlan';
import SectionEditor from './SectionEditor';
import AssignmentBoard from './AssignmentBoard';
import EightySixBoard from './EightySixBoard';

interface Props {
  locationId: string;
}

type Mode = 'assign' | 'setup' | '86';

/**
 * Floor Plan tab — Phase 1 (draw sections, admin setup) and Phase 2 (daily
 * staff assignment) share the same uploaded plan + saved sections. Defaults
 * to the daily assignment view once a plan with sections exists; a venue
 * with nothing uploaded yet is dropped straight into setup.
 */
export default function FloorPlanTab({ locationId }: Props) {
  const [image, setImage] = useState<FloorPlanImageDto | null>(null);
  const [sections, setSections] = useState<FloorSectionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('assign');
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchFloorPlan(locationId)
      .then((data) => {
        if (cancelled) return;
        setImage(data.image);
        setSections(data.sections);
        // First time in: jump straight to setup if there's nothing to assign against yet.
        if (!data.image || data.sections.length === 0) setMode('setup');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load the floor plan.');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setInitialized(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  const handleChanged = useCallback((nextImage: FloorPlanImageDto, nextSections: FloorSectionDto[]) => {
    setImage(nextImage);
    setSections(nextSections);
  }, []);

  if (loading && !initialized) {
    return (
      <section className="fp-tab">
        <div className="status-block">
          <span className="spinner" aria-hidden />
          <p>Loading floor plan…</p>
        </div>
      </section>
    );
  }

  return (
    <section className="fp-tab">
      <header className="fp-tab-header">
        <h2 className="section-title">Floor Plan</h2>
        {image && sections.length > 0 && (
          <div className="fp-mode-toggle">
            <button className={`chip${mode === 'assign' ? ' chip-active' : ''}`} onClick={() => setMode('assign')}>
              Daily Assignment
            </button>
            <button className={`chip${mode === 'setup' ? ' chip-active' : ''}`} onClick={() => setMode('setup')}>
              Sections
            </button>
            <button className={`chip${mode === '86' ? ' chip-active' : ''}`} onClick={() => setMode('86')}>
              86 List
            </button>
          </div>
        )}
      </header>

      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}

      {mode === 'setup' ? (
        <SectionEditor
          locationId={locationId}
          image={image}
          sections={sections}
          onChanged={handleChanged}
          onDone={() => setMode('assign')}
        />
      ) : mode === '86' ? (
        <EightySixBoard locationId={locationId} />
      ) : (
        <AssignmentBoard locationId={locationId} onEditSections={() => setMode('setup')} />
      )}
    </section>
  );
}
