import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWeekDoc, patchWeek, previewPublish, publishWeek, emitRosterChanged, onRosterChanged } from '../api/weeks';
import { venueReadHeaders } from '../api/venueBinding';
import { isNetworkFailure, loadOffline, saveOffline } from '../lib/offlineCache';
import { useConnectivity } from './ConnectivityContext';
import type { PublishPreviewDto, PublishResult, WeekDocDto, WeekPatchInput, WeekPatchResult } from '../../shared/rotaWeek';

/** How often an open week checks for other devices' changes while the tab is visible. */
const POLL_MS = 30_000;

export interface UseWeekDocOptions {
  locationId: string | null;
  weekStart: string;
  sessionToken: string | null;
  kioskToken?: string | null;
  /** Key for the read-only offline snapshot (the signed-in user id); null disables it. */
  offlineUserId?: string | null;
}

export interface WeekDocState {
  week: WeekDocDto | null;
  loading: boolean;
  error: string | null;
  /** Set when the doc on screen came from the offline snapshot. ISO time it was saved. */
  offlineSince: string | null;
  /** Set when a save hit a version conflict: the newer week the server holds (B8 stale-week dialog). */
  conflict: WeekDocDto | null;
  refetch: () => Promise<void>;
  /** Applies a batch patch at the version on screen. Never throws for 409/422; offline throws. */
  patch: (input: Omit<WeekPatchInput, 'expectedVersion'>) => Promise<WeekPatchResult>;
  preview: () => Promise<PublishPreviewDto>;
  publish: (preview: PublishPreviewDto) => Promise<PublishResult>;
  /** Accept the server's newer week after a conflict (clears `conflict`). */
  acceptServerWeek: () => void;
}

/**
 * The week document for one venue-week, kept in step with the server.
 *
 * - Every successful write replaces the doc with the server's and emits the
 *   roster-changed signal, so every other rota surface in this tab refetches.
 * - Other devices' writes arrive through a 30 s poll while the tab is visible,
 *   on window focus, and on reconnect; a newer `version` replaces the doc.
 * - Offline: the last published view is shown from the snapshot, labelled, and
 *   writes are refused (Design Q21, Option B — the builder blocks rather than
 *   queues roster writes, as it does today).
 */
export function useWeekDoc(opts: UseWeekDocOptions): WeekDocState {
  const { locationId, weekStart, sessionToken, kioskToken = null, offlineUserId = null } = opts;
  const { online } = useConnectivity();
  const [week, setWeek] = useState<WeekDocDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const [conflict, setConflict] = useState<WeekDocDto | null>(null);
  // Drops a response for a week the user has already navigated away from.
  const requestKey = useRef(0);
  const weekRef = useRef<WeekDocDto | null>(null);
  weekRef.current = week;

  const snapshotKey = `weekDoc.${weekStart}`;

  const load = useCallback(
    async (quiet: boolean) => {
      if (!locationId) return;
      const key = ++requestKey.current;
      if (!quiet) setLoading(true);
      try {
        const doc = await fetchWeekDoc(locationId, weekStart, venueReadHeaders(sessionToken, kioskToken));
        if (key !== requestKey.current) return;
        // Never step backwards: a slow poll must not overwrite a newer doc a save just returned.
        if (!weekRef.current || weekRef.current.weekStart !== doc.weekStart || doc.version >= weekRef.current.version) setWeek(doc);
        setError(null);
        setOfflineSince(null);
        if (offlineUserId) {
          // The snapshot only ever holds what staff may see: published rows.
          const published: WeekDocDto = {
            ...doc,
            shifts: doc.shifts.filter((s) => s.status === 'published'),
            leaves: doc.leaves.filter((l) => l.status === 'published'),
          };
          saveOffline(offlineUserId, snapshotKey, published);
        }
      } catch (err) {
        if (key !== requestKey.current) return;
        const cached = offlineUserId && isNetworkFailure(err) ? loadOffline<WeekDocDto>(offlineUserId, snapshotKey) : null;
        if (cached && cached.data.locationId === locationId) {
          setWeek(cached.data);
          setOfflineSince(cached.savedAt);
          setError(null);
        } else {
          setError(err instanceof Error ? err.message : 'Could not load the week.');
        }
      } finally {
        if (key === requestKey.current) setLoading(false);
      }
    },
    [locationId, weekStart, sessionToken, kioskToken, offlineUserId, snapshotKey],
  );

  // Load on mount and whenever the week, venue or session changes.
  useEffect(() => {
    setWeek(null);
    setConflict(null);
    void load(false);
  }, [load]);

  // Other devices: poll while visible, refetch on focus and on reconnect.
  useEffect(() => {
    if (!locationId) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    const id = window.setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
    };
  }, [locationId, load]);
  useEffect(() => {
    if (online) void load(true);
  }, [online, load]);

  // Same tab: another surface (an approval, an import, voice) changed this week.
  useEffect(
    () =>
      onRosterChanged((d) => {
        if (d.locationId === locationId && d.weekStart === weekStart && (!weekRef.current || d.version > weekRef.current.version)) void load(true);
      }),
    [locationId, weekStart, load],
  );

  const patch = useCallback(
    async (input: Omit<WeekPatchInput, 'expectedVersion'>): Promise<WeekPatchResult> => {
      if (!sessionToken || !locationId || !weekRef.current) throw new Error('The week is not loaded yet.');
      if (!online) throw new Error('You are offline. Changes to the rota are paused until you are back.');
      const result = await patchWeek(sessionToken, locationId, weekStart, { ...input, expectedVersion: weekRef.current.version });
      if (result.result === 'ok') {
        setWeek(result.week);
        setConflict(null);
        emitRosterChanged({ locationId, weekStart, version: result.version });
      } else if (result.result === 'version_conflict') {
        setConflict(result.week);
      }
      return result;
    },
    [sessionToken, locationId, weekStart, online],
  );

  const preview = useCallback(async () => {
    if (!sessionToken || !locationId) throw new Error('Sign in to publish.');
    return previewPublish(sessionToken, locationId, weekStart);
  }, [sessionToken, locationId, weekStart]);

  const publish = useCallback(
    async (p: PublishPreviewDto): Promise<PublishResult> => {
      if (!sessionToken || !locationId) throw new Error('Sign in to publish.');
      if (!online) throw new Error('You are offline. Publishing needs a connection.');
      const result = await publishWeek(sessionToken, locationId, weekStart, { expectedVersion: p.version, fingerprint: p.fingerprint });
      if (result.result === 'ok') {
        emitRosterChanged({ locationId, weekStart, version: result.version });
        await load(true);
      } else if (result.result === 'version_conflict') {
        await load(true);
      }
      return result;
    },
    [sessionToken, locationId, weekStart, online, load],
  );

  const acceptServerWeek = useCallback(() => {
    setConflict((c) => {
      if (c) setWeek(c);
      return null;
    });
  }, []);

  return { week, loading, error, offlineSince, conflict, refetch: () => load(true), patch, preview, publish, acceptServerWeek };
}
