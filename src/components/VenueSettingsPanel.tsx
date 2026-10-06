import { useEffect, useState, type FormEvent } from 'react';
import { updateLocation } from '../api/locations';
import { useAppState } from '../state/AppStateContext';
import { useConnectivity } from '../state/ConnectivityContext';
import { VENUE_NAME_MAX_LENGTH } from '../../shared/venueName';

/**
 * Owner/manager-only (Profile renders it only for those roles; the server's
 * `PATCH /api/locations/:id` refuses staff anyway). Renames the venue: the
 * saved name goes straight into app state, so the header and every other
 * venue-name reader change at once, with no reload. Opening it refetches the
 * name, so a rename made meanwhile on another device is what gets edited.
 */
export default function VenueSettingsPanel({ token, locationId }: { token: string; locationId: string }) {
  const { venueName, setVenueName, refreshVenue } = useAppState();
  const { online } = useConnectivity();
  useEffect(() => refreshVenue(), [refreshVenue]);
  // null = showing the name; a string = the rename form is open with this draft.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const trimmed = draft?.trim() ?? '';
  const canSave = trimmed.length > 0 && trimmed !== venueName && online && !saving;

  const startRename = () => {
    setDraft(venueName ?? '');
    setError(null);
    setSaved(false);
  };
  const cancel = () => {
    setDraft(null);
    setError(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const location = await updateLocation(token, locationId, { name: trimmed });
      setVenueName(location.name);
      setDraft(null);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename the venue. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel p-5" data-testid="venue-settings" aria-labelledby="venue-settings-heading">
      <p className="eyebrow">Venue</p>
      {draft === null ? (
        <>
          <h2 id="venue-settings-heading" className="text-lg font-semibold tracking-tight break-words">
            {venueName ?? 'Loading…'}
          </h2>
          <p className="text-sm text-muted-foreground">Shown at the top of every screen, on your team's rota and in invite links.</p>
          {saved && (
            <p className="mt-2 text-sm text-success motion-safe:animate-rise" role="status">
              Venue name saved.
            </p>
          )}
          <button className="btn btn-ghost mt-3 hit-44 disabled:opacity-50" onClick={startRename} disabled={venueName === null}>
            Rename venue
          </button>
        </>
      ) : (
        <form onSubmit={(e) => void save(e)} onKeyDown={(e) => e.key === 'Escape' && !saving && cancel()}>
          <label id="venue-settings-heading" htmlFor="venue-name" className="mt-1 block text-sm font-medium">
            Venue name
          </label>
          <input
            id="venue-name"
            className="staff-directory-input mt-2 w-full"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={VENUE_NAME_MAX_LENGTH}
            autoComplete="organization"
            spellCheck={false}
            autoFocus
            disabled={saving}
            aria-describedby="venue-name-hint"
          />
          <p id="venue-name-hint" className="mt-1.5 text-xs text-muted-foreground">
            {trimmed.length === 0
              ? 'Enter a name for your venue.'
              : `${trimmed.length}/${VENUE_NAME_MAX_LENGTH} characters`}
          </p>
          {!online && (
            <p className="mt-2 text-xs text-warning" role="status">
              You're offline — reconnect to save.
            </p>
          )}
          {error && (
            <p className="error-block mt-3" role="alert">
              {error}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary hit-44 disabled:cursor-not-allowed disabled:opacity-50" disabled={!canSave}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-ghost hit-44" onClick={cancel} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
