import { useEffect, useState } from 'react';
import { fetchLocation, updateLocation, VENUE_TYPES } from '../../api/locations';
import { useIdentity } from '../../state/IdentityContext';
import { useAppState } from '../../state/AppStateContext';
import { VENUE_NAME_MAX_LENGTH } from '../../../shared/venueName';
import OnboardingScreenShell from './OnboardingScreenShell';
import { computeCanContinue } from './venueValidation';

/**
 * Onboarding · 02 · Venue — ported from `ShiftSync Venue.dc.html`.
 *
 * The prototype's own venue-type chip list (`Fine dining, Hotel F&B, Lounge,
 * Café, Beach club`) doesn't match this app's real `VENUE_TYPES` — the
 * server (`locations.ts` PATCH) rejects any value outside that canonical
 * 6-item list, so the chips here use the real values instead of the
 * prototype's mismatched ones. Everything else (copy, layout, chip visuals,
 * motion) is ported as-is, except the prototype's "Floor sections" stepper:
 * it saved nothing (Location has no section count, and a section needs an
 * uploaded plan), so it was removed for a one-line pointer to the Floor
 * Plan page, where sections are actually set up — see docs/floor-sections.md.
 */
const CITY_OPTIONS = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Other'] as const;

function chipStyle(on: boolean) {
  return {
    padding: '10px 14px',
    borderRadius: 999,
    border: `1px solid ${on ? 'rgba(201,166,107,.75)' : 'rgba(239,234,224,.10)'}`,
    background: on ? 'rgba(201,166,107,.10)' : 'rgba(239,234,224,.02)',
    color: on ? 'var(--ob-champagne)' : 'var(--ob-stone)',
    font: "500 12.5px/1 'Manrope'",
    letterSpacing: '.005em',
    transition: 'background-color var(--ob-t), border-color var(--ob-t), color var(--ob-t)',
  } as const;
}


export default function VenueScreen({
  locationId,
  onBack,
  onContinue,
}: {
  locationId: string;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { session } = useIdentity();
  const { setVenueName } = useAppState();

  const [name, setName] = useState('');
  // Account already collected this exact value (it's how the Location got
  // created in the first place) — showing a fresh full-input prompt here
  // reads as "answer this again" rather than "confirm/edit what you told
  // us". Starts collapsed to a summary line; picking "Rename" reveals the
  // same input as before. Purely presentational — `name`'s own state, the
  // `updateLocation` PATCH on Continue, and the backend are all unchanged.
  const [editingName, setEditingName] = useState(false);
  const [city, setCity] = useState<string>('Dubai');
  const [cityTouched, setCityTouched] = useState(false);
  const [venueType, setVenueType] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) {
      setLoading(false);
      setError('You need to be signed in to set up your venue.');
      return;
    }
    let cancelled = false;
    fetchLocation(session.token, locationId)
      .then((loc) => {
        if (cancelled) return;
        setName(loc.name);
        setVenueType(loc.venueType);
        if (loc.emirate) {
          setCity(loc.emirate);
          setCityTouched(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load venue details.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locationId, session]);

  const canContinue = computeCanContinue({ name, venueType, cityTouched });

  const handleContinue = async () => {
    if (!canContinue || saving) return;
    if (!session) {
      setError('You need to be signed in to set up your venue.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const saved = await updateLocation(session.token, locationId, { name: name.trim(), venueType, emirate: city });
      // The app header (and every other venue-name reader) shows the saved name now, not after a reload.
      setVenueName(saved.name);
      onContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save venue details.');
    } finally {
      setSaving(false);
    }
  };

  const disabled = loading || saving;

  return (
    <OnboardingScreenShell
      stepIndex={1}
      eyebrow="Step 2 of 5 · Venue"
      title="Tell us about the room."
      onBack={onBack}
      footer={
        <>
          <button
            onClick={() => void handleContinue()}
            disabled={!canContinue || disabled}
            style={{
              width: '100%',
              padding: '16px 20px',
              borderRadius: 14,
              background: canContinue && !disabled ? 'var(--ob-bone)' : 'rgba(239,234,224,.10)',
              color: canContinue && !disabled ? '#100D0A' : 'var(--ob-dim-2)',
              font: "600 14px/1 'Manrope'",
              letterSpacing: '.005em',
              transition: 'background-color var(--ob-t), color var(--ob-t)',
              cursor: canContinue && !disabled ? 'pointer' : 'default',
            }}
          >
            {saving ? 'Saving…' : 'Continue'}
          </button>
          <div style={{ textAlign: 'center', marginTop: 14, font: "500 10px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-dim-2)' }}>
            Next · Roster
          </div>
        </>
      }
    >
      {error && (
        <div style={{ color: '#e5484d', font: "400 13px/1.5 'Manrope'" }}>{error}</div>
      )}

      {/* Venue name — Account already asked this; show what it collected as
          a confirmed summary rather than re-prompting for it, with an
          explicit "Rename" to edit if it's wrong. Falls back to the open
          input if name somehow arrived empty, so there's always a way in. */}
      <div>
        <div style={{ font: "500 10px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>Venue name</div>
        {!editingName && name.trim() ? (
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, paddingBottom: 12, borderBottom: '1px solid rgba(201,166,107,.55)' }}>
            <span style={{ font: "400 20px/1.2 'Instrument Serif'", color: 'var(--ob-bone)' }}>{name}</span>
            <button
              type="button"
              className="hit-44"
              onClick={() => setEditingName(true)}
              disabled={disabled}
              style={{
                flexShrink: 0,
                background: 'transparent',
                border: 0,
                padding: 0,
                color: 'var(--ob-champagne)',
                borderBottom: '1px solid rgba(201,166,107,.35)',
                font: "500 11px/1 'Manrope'",
                letterSpacing: '.04em',
                cursor: 'pointer',
              }}
            >
              Rename
            </button>
          </div>
        ) : (
          <div
            style={{
              marginTop: 6,
              borderBottom: `1px solid ${name ? 'rgba(201,166,107,.55)' : 'rgba(239,234,224,.12)'}`,
              transition: 'border-color var(--ob-t)',
            }}
          >
            <input
              value={name}
              maxLength={VENUE_NAME_MAX_LENGTH}
              onChange={(e) => setName(e.target.value)}
              // The fallback input (name empty, editingName false) must become
              // a real edit session on focus — otherwise the first keystroke
              // makes the name non-empty and swaps the input for the summary
              // mid-typing, leaving the manager with a one-letter venue name.
              onFocus={() => setEditingName(true)}
              onBlur={() => setEditingName(false)}
              placeholder="e.g. Sefarina, DIFC"
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              autoFocus={editingName}
              style={{
                font: "400 20px/1.2 'Instrument Serif'",
                color: 'var(--ob-bone)',
                padding: '12px 0 12px',
                width: '100%',
                background: 'transparent',
                border: 0,
                outline: 'none',
              }}
            />
          </div>
        )}
      </div>

      {/* Location */}
      <div>
        <div style={{ font: "500 10px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>Location</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {CITY_OPTIONS.map((label) => (
            <button
              key={label}
              className="hit-44"
              disabled={disabled}
              onClick={() => {
                setCityTouched(true);
                setCity(label);
              }}
              style={chipStyle(cityTouched && city === label)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Venue type */}
      <div>
        <div style={{ font: "500 10px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>Venue type</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {VENUE_TYPES.map((label) => (
            <button key={label} disabled={disabled} onClick={() => setVenueType(label)} style={chipStyle(venueType === label)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Floor sections — not set up here (see the header comment). */}
      <div>
        <div style={{ font: "500 10px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>Floor sections</div>
        <p style={{ margin: '10px 0 0', font: "400 13px/1.55 'Manrope'", color: 'var(--ob-stone)' }}>
          Later, on the Floor Plan page — upload your plan and name each section there.
        </p>
      </div>
    </OnboardingScreenShell>
  );
}
