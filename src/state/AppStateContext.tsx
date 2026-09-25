import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_MAINLAND_RULES, type Employee, type Roster, type Shift, type SwapRequest, type VenueConfig } from '../engine/types';
import { groupIntoSections, nameKey, type GroupedSection } from '../engine/roleGrouping';
import { buildCommitted, mergeCommitted, type PersistedRow } from '../engine/commitBinding';
import { currentWeekStart } from '../engine/weekStart';
import type { PreviewRow } from '../api/schedules';
import { fetchStaffDirectory, type StaffDirectoryEntry } from '../api/staffDirectory';
import { fetchSwapRequests, createSwapRequest, decideSwapRequest } from '../api/swapRequests';
import { fetchWeekShifts, createShift, updateShift, deleteShift, bulkCreateShifts, publishWeek, fetchPublishStatus } from '../api/shifts';
import { fetchWeekLeaves, setLeave, deleteLeave, type LeaveDto } from '../api/rotaLeaves';
import { useRefetchOnReturn } from '../lib/scheduleRefresh';
import { loadBoundVenue, saveBoundVenue } from '../api/venueBinding';
import { fetchLocation } from '../api/locations';
import { useIdentity } from './IdentityContext';

/**
 * Shared UI vocabulary (role/shift-type labels) plus a compliance ruleset —
 * genuinely global for this pilot (every venue is UAE-mainland Dubai/GCC
 * hospitality per this product's own scope; see AGENTS.md), not a
 * per-venue value that should come from session. `id`/`name`/`knownStaff`
 * are NOT real venue identity, despite the shape — inert legacy
 * placeholders that only satisfy `VenueConfig`'s type for `src/engine/
 * parser.ts`'s `parseRosterText`, which is dead code today (only its own
 * test file calls it; no live route or component does — confirmed via
 * `grep` during the 2026-08-31 hardcoded-reference sweep, see MEMORY.md).
 * No live UI reads `config.name`/`config.id` for anything real-venue
 * -identifying — every display surface reads `venueName` (below) instead,
 * fetched from the actual signed-in session's own `Location` row.
 */
const config: VenueConfig = {
  id: 'venue-1',
  name: 'Demo Venue',
  jurisdiction: 'mainland',
  compliance: DEFAULT_MAINLAND_RULES,
  shiftTypeLabels: { bar: 'bar', kitchen: 'kitchen', service: 'service' },
  roleLabels: ['bartender', 'server', 'chef', 'host'],
  knownStaff: ['Maria', 'Jose', 'Ahmed', 'Priya'],
};

interface AppStateValue {
  config: VenueConfig;
  /**
   * The real signed-in venue's actual display name, fetched from the
   * database — `null` until it loads, or for an anonymous kiosk visit
   * (`GET /api/locations/:id` requires a session; an anonymous binding has
   * no way to fetch this). Every UI surface that shows a venue name reads
   * this, never `config.name` (a hardcoded placeholder — see the comment on
   * `config`, below).
   */
  venueName: string | null;
  /**
   * The venue every read-effect should scope itself to — a real session's
   * venue when signed in, otherwise the anonymous kiosk venue bound via
   * `bindAnonymousVenue` (see below), otherwise null. Both sources resolve
   * to a real `Location.id`; the two are never mixed (a signed-in session
   * always wins over any bound kiosk venue). Every write path below reads
   * `session` directly instead, so an anonymous kiosk binding can only ever
   * unlock reads, never writes — see MEMORY.md's kiosk-access fork entry.
   */
  locationId: string | null;
  /**
   * Binds `/` (Home) to a venue for an anonymous, no-session visit — the
   * "shared kiosk device" case. Persisted to localStorage so the binding
   * survives future visits with no `?venue=` param present. No-ops while a
   * real session exists, so a bookmarked kiosk link can never override a
   * signed-in user's own venue.
   */
  bindAnonymousVenue: (locationId: string) => void;
  mergedRoster: Roster;
  /**
   * True until the FIRST `weekShifts` fetch (success or failure) settles,
   * then false forever after — not a per-request spinner for week-nav
   * reloads. Lets SchedulingRoute/PersonalRota/TeamMatrix distinguish "still
   * loading the initial page" from "genuinely no shifts this week" so they
   * don't flash a real empty state during the brief initial round trip.
   */
  initialScheduleLoading: boolean;
  /** True when the most recent weekShifts fetch failed — distinct from `initialScheduleLoading`, which only covers the first load. Lets SchedulingRoute tell "offline, nothing cached for this week" apart from a genuine "no staff parsed yet" empty state. */
  scheduleLoadFailed: boolean;
  swapRequests: SwapRequest[];
  /** True until the first swap-requests fetch (success or failure) settles — same "initial load only" shape as `initialScheduleLoading`, for ApprovalsPanel. */
  swapRequestsLoading: boolean;
  /** True when the most recent swap-requests fetch failed — lets ApprovalsPanel tell "offline, nothing cached" apart from a genuine "no requests" empty state. */
  swapRequestsLoadFailed: boolean;
  staffDirectory: StaffDirectoryEntry[];
  staffDirectoryByName: Map<string, StaffDirectoryEntry>;
  sections: GroupedSection<Employee>[];
  collapsed: Record<string, boolean>;
  setCollapsed: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setStaffDirectory: React.Dispatch<React.SetStateAction<StaffDirectoryEntry[]>>;
  currentEmployeeId: string | undefined;
  setCurrentEmployeeId: React.Dispatch<React.SetStateAction<string | undefined>>;
  handleRequestCover: (shiftId: string, coveringEmployeeId: string) => Promise<void>;
  handleDecideRequest: (requestId: string, decision: 'approved' | 'denied') => Promise<void>;
  handleCommitted: (rows: PreviewRow[], batchId: string, persisted: PersistedRow[]) => void;
  weekStart: string;
  setWeekStart: React.Dispatch<React.SetStateAction<string>>;
  refetchWeekShifts: () => Promise<void>;
  createRotaShift: (input: Omit<Parameters<typeof createShift>[1], 'locationId'>) => Promise<void>;
  updateRotaShift: (id: string, patch: Parameters<typeof updateShift>[2]) => Promise<void>;
  deleteRotaShift: (id: string) => Promise<void>;
  bulkCreateRotaShifts: (shifts: Parameters<typeof bulkCreateShifts>[1]['shifts']) => Promise<void>;
  publishCurrentWeek: () => Promise<{ publishedAt: string; notifiedCount: number }>;
  /** Leave marked on the grid for the viewed week (drafts only for a venue manager — server decides). */
  weekLeaves: LeaveDto[];
  refetchWeekLeaves: () => Promise<void>;
  setRotaLeave: (input: Parameters<typeof setLeave>[1]) => Promise<void>;
  removeRotaLeave: (id: string) => Promise<void>;
  publishInfo: PublishInfo | null;
  /** True when the viewed week is published and has no edits since — every editor must gate its writes on this. */
  weekLocked: boolean;
  refreshPublishInfo: () => void;
}

interface PublishInfo {
  publishedAt: string | null;
  notifiedCount: number;
  hasUnpublishedChanges: boolean;
}

const AppStateCtx = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { session } = useIdentity();
  const [anonymousVenueId, setAnonymousVenueId] = useState<string | null>(() => loadBoundVenue());
  const locationId = session?.user.locationId ?? anonymousVenueId;
  const bindAnonymousVenue = useCallback((id: string) => {
    saveBoundVenue(id);
    setAnonymousVenueId(id);
  }, []);

  // The real venue's display name — never `config.name` (see the comment on
  // `config`, above). `GET /api/locations/:id` requires a session, so an
  // anonymous kiosk visit (no session, only a bound venue id) has no way to
  // fetch this and stays `null` — every consumer already has to handle a
  // loading/unknown state, so this is the same shape, not a new one.
  const [venueName, setVenueName] = useState<string | null>(null);
  useEffect(() => {
    if (!session) {
      setVenueName(null);
      return;
    }
    let cancelled = false;
    fetchLocation(session.token, session.user.locationId)
      .then((location) => {
        if (!cancelled) setVenueName(location.name);
      })
      .catch(() => {
        if (!cancelled) setVenueName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const [weekStart, setWeekStart] = useState(currentWeekStart());

  const roster: Roster = useMemo(
    () => ({
      id: `roster-${weekStart}`,
      venueId: config.id,
      weekStart,
      employees: [],
      shifts: [],
      createdAt: new Date().toISOString(),
    }),
    [weekStart],
  );

  const [committed, setCommitted] = useState<{ employees: Employee[]; shifts: Shift[] }>({
    employees: [],
    shifts: [],
  });
  const [initialScheduleLoading, setInitialScheduleLoading] = useState(true);
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([]);
  const [swapRequestsLoading, setSwapRequestsLoading] = useState(true);
  const [swapRequestsLoadFailed, setSwapRequestsLoadFailed] = useState(false);
  const [scheduleLoadFailed, setScheduleLoadFailed] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [staffDirectory, setStaffDirectory] = useState<StaffDirectoryEntry[]>([]);
  const [currentEmployeeId, setCurrentEmployeeId] = useState<string | undefined>(undefined);
  const [weekShifts, setWeekShifts] = useState<Shift[]>([]);
  const [publishInfo, setPublishInfo] = useState<PublishInfo | null>(null);

  // Week navigation (RotaBuilder's prev/next buttons) can fire `setWeekStart`
  // faster than the network answers. Without a guard, an older week's
  // response can land after a newer one and paint stale shifts underneath the
  // current week's header — data that looks correct but belongs to a
  // different week. Every request takes a sequence number and discards itself
  // if a newer request has started since.
  const reqSeqRef = useRef(0);
  // The week the CURRENTLY-HELD `weekShifts` state actually corresponds to
  // (distinct from `weekStart`, which flips the instant Prev/Next is
  // clicked, before the new week's fetch has even started). Lets the catch
  // block below tell "this failure is for a week we have no cached data for
  // at all" (must clear — the old bug this ref exists to prevent) apart from
  // "this failure is a same-week connectivity blip" (must NOT clear — Phase
  // 2 of the offline-support pass: don't wipe data the user can already see
  // just because a request failed).
  const loadedWeekShiftsWeekRef = useRef<string | null>(null);

  const refetchWeekShifts = useCallback(async () => {
    // No session, no real venue to scope this fetch to — clear rather than
    // fetch against a hardcoded/wrong location. Same shared-device reasoning
    // as the staff-directory/swap-requests effects below.
    if (!locationId) {
      setWeekShifts([]);
      loadedWeekShiftsWeekRef.current = null;
      setInitialScheduleLoading(false);
      return;
    }
    const seq = ++reqSeqRef.current;
    const targetWeek = weekStart;
    try {
      const dtos = await fetchWeekShifts(locationId, weekStart, session?.token);
      if (seq !== reqSeqRef.current) return;
      setWeekShifts(
        dtos.map((s) => ({
          id: s.id,
          employeeId: s.employeeId ?? `open-${s.id}`,
          date: s.date,
          start: s.start,
          end: s.end,
          type: 'service',
          overnight: s.end <= s.start,
          requiredRole: s.roleName,
          status: s.status,
          briefingNote: s.briefingNote ?? undefined,
          sidework: s.sidework,
        })),
      );
      loadedWeekShiftsWeekRef.current = targetWeek;
      setScheduleLoadFailed(false);
    } catch {
      // A stale failure is discarded for the same reason a stale success is:
      // it must not clear a newer week's freshly-loaded shifts.
      if (seq !== reqSeqRef.current) return;
      setScheduleLoadFailed(true);
      if (loadedWeekShiftsWeekRef.current !== targetWeek) {
        // We hold no valid cached data for THIS week at all (first load of
        // it, or whatever's in `weekShifts` is leftover from a different
        // week) — leaving it in place would show the wrong week's shifts
        // under this week's header, so clearing is the only safe option.
        setWeekShifts([]);
      }
      // Else: the failure is for the SAME week already on screen (e.g. a
      // transient offline blip) — the currently-displayed data is still
      // valid for the week the user is looking at, so it stays put rather
      // than being wiped just because this one request failed.
    } finally {
      // Only ever flips the FIRST time this settles (see the field's doc
      // comment) — subsequent week-nav reloads leave it `false`, since
      // `setState(false)` when already `false` is a no-op re-render.
      if (seq === reqSeqRef.current) setInitialScheduleLoading(false);
    }
  }, [weekStart, locationId, session?.token]);

  useEffect(() => {
    void refetchWeekShifts();
  }, [refetchWeekShifts]);

  // Leave for the viewed week — same week/venue/token keying and the same
  // stale-response guard as `refetchWeekShifts`, above.
  const [weekLeaves, setWeekLeaves] = useState<LeaveDto[]>([]);
  const leaveSeqRef = useRef(0);
  const refetchWeekLeaves = useCallback(async () => {
    if (!locationId) {
      setWeekLeaves([]);
      return;
    }
    const seq = ++leaveSeqRef.current;
    try {
      const leaves = await fetchWeekLeaves(locationId, weekStart, session?.token);
      if (seq === leaveSeqRef.current) setWeekLeaves(leaves);
    } catch {
      // Keep what's on screen on a connectivity blip (same rule as shifts);
      // the next refetch replaces it.
    }
  }, [weekStart, locationId, session?.token]);

  useEffect(() => {
    void refetchWeekLeaves();
  }, [refetchWeekLeaves]);

  const mergedRoster: Roster = useMemo(() => {
    const withCommitted = mergeCommitted(roster, committed);
    // weekShifts are real, already-persisted rota-builder/shift-editor shifts
    // for the currently-viewed week — merged in alongside upload-committed
    // shifts so Personal Rota/Team Matrix/the roster grid see both sources
    // without caring which one a given shift came from.
    //
    // `committed` is a snapshot taken at upload-confirm time and never
    // refreshed, while `weekShifts` is re-fetched from the server after every
    // mutation. Because `buildCommitted` stamps the REAL persisted `Shift.id`
    // onto a confirmed upload row, the same shift can appear in both buckets
    // under the same id — so keying by id and letting `weekShifts` overwrite
    // is what makes server truth win. Skipping a duplicate instead (the old
    // behaviour) pinned the stale upload copy in place forever: an edited
    // briefing note never appeared and a deleted shift's chip never left the
    // grid.
    //
    // Overwriting by id fixes edits, but a DELETE has no `weekShifts` entry
    // left to overwrite with — a shift that only exists in `committed` is
    // (correctly) still kept here, because that is also how a genuinely
    // unsaved `unmatched_role` row and any committed row outside the
    // currently-viewed week survive. `deleteRotaShift` therefore prunes the
    // deleted id out of `committed` itself, which is precise (it targets the
    // one row the user actually deleted) and race-free (no dependency on a
    // fetch landing).
    const byId = new Map(withCommitted.shifts.map((s) => [s.id, s]));
    const employees = [...withCommitted.employees];
    const seenEmployeeIds = new Set(employees.map((e) => e.id));
    for (const shift of weekShifts) {
      if (!shift.employeeId.startsWith('open-') && !seenEmployeeIds.has(shift.employeeId)) {
        // A real assigned user with no upload-derived Employee record yet —
        // synthesize a minimal one so the roster grid/matrix can render them.
        // requiredRole doubles as a display role here since RotaBuilder's own
        // shift-role assignment is the only role signal for a person who has
        // never appeared in an uploaded roster.
        employees.push({
          id: shift.employeeId,
          name: staffDirectory.find((s) => s.id === shift.employeeId)?.fullName ?? shift.employeeId,
          role: shift.requiredRole ?? 'staff',
          status: 'active',
        });
        seenEmployeeIds.add(shift.employeeId);
      }
      byId.set(shift.id, shift);
    }
    return { ...withCommitted, employees, shifts: [...byId.values()] };
  }, [roster, committed, weekShifts, staffDirectory]);

  const staffDirectoryByName = useMemo(() => {
    const map = new Map<string, StaffDirectoryEntry>();
    for (const entry of staffDirectory) map.set(nameKey(entry.fullName), entry);
    return map;
  }, [staffDirectory]);

  useEffect(() => {
    // Reads are session-gated server-side now. With no session — either a
    // fresh load before login resolves, OR a sign-out on the shared venue
    // device this app runs on — there is no token to send, so skip the call
    // AND clear whatever the previous session's data left behind: this
    // provider never unmounts across a logout (no route requires a session
    // to render), so without this a departed manager's staff directory
    // (names/phone numbers/preferred language) would keep rendering for
    // whoever uses the device next.
    if (!session) {
      setStaffDirectory([]);
      return;
    }
    let cancelled = false;
    fetchStaffDirectory(session.token, session.user.locationId)
      .then((list) => {
        if (!cancelled) setStaffDirectory(list);
      })
      .catch(() => {
        // StaffDirectory route itself surfaces a load error when visited; nothing to show here.
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    // Managers only: seeding a STAFF session with `employees[0]` counted as an
    // explicit "Viewing" pick in `pickViewedEmployee`, so a staff member who
    // wasn't first on the roster opened Scheduling on a colleague's rota.
    if (session?.user.systemRole !== 'OWNER' && session?.user.systemRole !== 'MANAGER') return;
    if (currentEmployeeId === undefined && mergedRoster.employees.length > 0) {
      setCurrentEmployeeId(mergedRoster.employees[0]!.id);
    }
  }, [currentEmployeeId, mergedRoster.employees, session?.user.systemRole]);

  useEffect(() => {
    // Swap requests are session-gated server-side now. Same shared-device
    // reasoning as the staff-directory effect above: clear on sign-out, not
    // just skip the refetch, so a departed user's swap-request history
    // doesn't keep rendering for whoever uses the device next.
    if (!session) {
      setSwapRequests([]);
      setSwapRequestsLoading(false);
      setSwapRequestsLoadFailed(false);
      return;
    }
    let cancelled = false;
    fetchSwapRequests(session.token, session.user.locationId)
      .then((list) => {
        if (cancelled) return;
        setSwapRequests(list);
        setSwapRequestsLoadFailed(false);
      })
      .catch(() => {
        // The list itself is left untouched on failure (Phase 2 of the
        // offline-support pass: a request that fails while data is already
        // loaded must not blank it out) — this flag only distinguishes a
        // genuinely empty list from a cold load that couldn't reach the
        // server at all, for ApprovalsPanel's offline empty state.
        if (!cancelled) setSwapRequestsLoadFailed(true);
      })
      .finally(() => {
        // Only meaningfully flips once — see the field's doc comment.
        if (!cancelled) setSwapRequestsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const sections = useMemo(() => {
    const jobTitleByName = new Map<string, string | null | undefined>();
    for (const [key, entry] of staffDirectoryByName) jobTitleByName.set(key, entry.jobTitle);
    return groupIntoSections(mergedRoster.employees, jobTitleByName);
  }, [mergedRoster.employees, staffDirectoryByName]);

  const handleRequestCover = useCallback(
    async (shiftId: string, coveringEmployeeId: string) => {
      // No session, no actor to attribute the request to — the server would
      // 401 anyway. Thrown (not a silent no-op) so the caller (PersonalRota)
      // doesn't flip to a false "sent" state when nothing was actually sent.
      if (!session) throw new Error('You need to be signed in to request cover.');
      const shift = mergedRoster.shifts.find((s) => s.id === shiftId);
      if (!shift) throw new Error('That shift could not be found — try refreshing.');
      const request = await createSwapRequest(session.token, {
        shiftId,
        // Only honored server-side for a MANAGER/OWNER session (filing on
        // behalf of the employee selected in SchedulingRoute's "Viewing"
        // dropdown); ignored outright for a STAFF session, which can only
        // ever file for itself.
        requestedById: shift.employeeId,
        targetUserId: coveringEmployeeId,
      });
      // Only mutate local state once the server has actually accepted the
      // request — a thrown error above leaves this untouched, so the caller
      // never mistakes a failed request for a successful one.
      setSwapRequests((prev) => [...prev, request]);
    },
    [mergedRoster.shifts, session],
  );

  const handleDecideRequest = useCallback(
    async (requestId: string, decision: 'approved' | 'denied') => {
      // Deciding is manager/owner-only server-side; with no session there is
      // no reviewer to attribute the decision to.
      if (!session) throw new Error('You need to be signed in to decide swap requests.');
      // Whatever happens to THIS request, a decide attempt can change the
      // `locked` status of every sibling request on the same shift (the
      // server auto-locks the losing requests once one approval reassigns the
      // shift). Patching only the one row we just decided leaves those
      // siblings showing stale `locked: false` in local state until a full
      // reload — so re-fetch the full list after every attempt (success or
      // failure) to keep the client's view self-correcting. If the decide
      // call itself fails, that error still propagates to the caller once
      // the refetch below finishes, so ApprovalsPanel can show it against
      // the row instead of leaving it in limbo.
      try {
        await decideSwapRequest(session.token, requestId, decision);
      } finally {
        try {
          const fresh = await fetchSwapRequests(session.token, session.user.locationId);
          setSwapRequests(fresh);
        } catch {
          // Best-effort reconciliation only — leave the previous (possibly
          // stale) list in place rather than clearing it. Not the error the
          // caller needs to see; the decide call's own outcome above is.
        }
      }
    },
    [session],
  );

  const handleCommitted = useCallback(
    (rows: PreviewRow[], batchId: string, persisted: PersistedRow[]) => {
      // Conversion lives in engine/commitBinding so it is directly unit-testable
      // (see commitBinding.test.ts) instead of being mirrored by the tests.
      const { employees, shifts } = buildCommitted(rows, batchId, persisted);
      setCommitted((prev) => ({
        employees: [...prev.employees, ...employees],
        shifts: [...prev.shifts, ...shifts],
      }));
    },
    [],
  );

  const createRotaShift = useCallback(
    async (input: Omit<Parameters<typeof createShift>[1], 'locationId'>) => {
      // ScheduleEditor only ever renders inside a RequireSession-gated route
      // (`/schedule`, since the 2026-08-31 kiosk-access fork resolution —
      // see MEMORY.md), so this should never actually fire without a
      // session — but if it somehow did, throwing here surfaces a clear
      // error through the caller's existing try/catch instead of crashing
      // on `session!.token` below or (worse) silently resolving to whatever
      // anonymous kiosk venue happens to be bound.
      if (!session) throw new Error('You must be signed in to do this.');
      await createShift(session.token, { ...input, locationId: session.user.locationId });
      await refetchWeekShifts();
    },
    [refetchWeekShifts, session],
  );

  const updateRotaShift = useCallback(
    async (id: string, patch: Parameters<typeof updateShift>[2]) => {
      if (!session) throw new Error('You must be signed in to do this.');
      await updateShift(session.token, id, patch);
      await refetchWeekShifts();
    },
    [refetchWeekShifts, session],
  );

  const deleteRotaShift = useCallback(
    async (id: string) => {
      if (!session) throw new Error('You must be signed in to do this.');
      await deleteShift(session.token, id);
      // `buildCommitted` stamps the real persisted `Shift.id` onto a confirmed
      // upload row, so the row just deleted from the DB may also be sitting in
      // the never-refreshed `committed` snapshot. Refetching `weekShifts`
      // cannot clear that copy (a deleted row simply stops arriving), so drop
      // it here — otherwise a deleted upload-committed shift's chip stays on
      // the grid forever. Returns `prev` untouched when there is nothing to
      // prune, so the common rota-builder-only delete re-renders nothing extra.
      setCommitted((prev) =>
        prev.shifts.some((s) => s.id === id) ? { ...prev, shifts: prev.shifts.filter((s) => s.id !== id) } : prev,
      );
      await refetchWeekShifts();
    },
    [refetchWeekShifts, session],
  );

  const bulkCreateRotaShifts = useCallback(
    // The AuditLog actor is the session user, resolved server-side.
    async (shifts: Parameters<typeof bulkCreateShifts>[1]['shifts']) => {
      if (!session) throw new Error('You must be signed in to do this.');
      await bulkCreateShifts(session.token, { locationId: session.user.locationId, shifts });
      await refetchWeekShifts();
    },
    [refetchWeekShifts, session],
  );

  const publishCurrentWeek = useCallback(
    async () => {
      if (!session) throw new Error('You must be signed in to do this.');
      const result = await publishWeek(session.token, session.user.locationId, weekStart);
      await Promise.all([refetchWeekShifts(), refetchWeekLeaves()]);
      return result;
    },
    [weekStart, refetchWeekShifts, refetchWeekLeaves, session],
  );

  const setRotaLeave = useCallback(
    async (input: Parameters<typeof setLeave>[1]) => {
      if (!session) throw new Error('You must be signed in to do this.');
      await setLeave(session.token, input);
      await refetchWeekLeaves();
    },
    [refetchWeekLeaves, session],
  );

  const removeRotaLeave = useCallback(
    async (id: string) => {
      if (!session) throw new Error('You must be signed in to do this.');
      await deleteLeave(session.token, id);
      await refetchWeekLeaves();
    },
    [refetchWeekLeaves, session],
  );

  // Publish/lock state is shared, not RotaBuilder-local: the Shift Editor
  // route edits exactly the same shifts and has to honour exactly the same
  // lock, so both read this one value. Fetched on the same `weekStart`-keyed
  // pattern as `refetchWeekShifts` above, and re-fetched by every editor
  // after a mutation (a create/update/delete flips `hasUnpublishedChanges`).
  const refreshPublishInfo = useCallback(() => {
    if (!locationId) {
      setPublishInfo(null);
      return;
    }
    fetchPublishStatus(locationId, weekStart)
      .then(setPublishInfo)
      .catch(() => setPublishInfo(null));
  }, [weekStart, locationId]);

  useEffect(() => {
    refreshPublishInfo();
  }, [refreshPublishInfo]);

  // Staff (and managers on a second device) pick up changes made elsewhere
  // when they come back to the app or open a notification — no websockets in v0.
  useRefetchOnReturn(
    useCallback(() => {
      void refetchWeekShifts();
      void refetchWeekLeaves();
      refreshPublishInfo();
    }, [refetchWeekShifts, refetchWeekLeaves, refreshPublishInfo]),
  );

  const weekLocked = Boolean(publishInfo?.publishedAt) && !publishInfo?.hasUnpublishedChanges;

  // setCollapsed/setStaffDirectory are useState setters — stable by definition,
  // and `config` is a module constant, so neither needs to be a dependency.
  const value: AppStateValue = useMemo(
    () => ({
      config,
      locationId,
      venueName,
      bindAnonymousVenue,
      mergedRoster,
      initialScheduleLoading,
      scheduleLoadFailed,
      swapRequests,
      swapRequestsLoading,
      swapRequestsLoadFailed,
      staffDirectory,
      staffDirectoryByName,
      sections,
      collapsed,
      setCollapsed,
      setStaffDirectory,
      currentEmployeeId,
      setCurrentEmployeeId,
      handleRequestCover,
      handleDecideRequest,
      handleCommitted,
      weekStart,
      setWeekStart,
      refetchWeekShifts,
      createRotaShift,
      updateRotaShift,
      deleteRotaShift,
      bulkCreateRotaShifts,
      publishCurrentWeek,
      weekLeaves,
      refetchWeekLeaves,
      setRotaLeave,
      removeRotaLeave,
      publishInfo,
      weekLocked,
      refreshPublishInfo,
    }),
    [
      locationId,
      venueName,
      bindAnonymousVenue,
      mergedRoster,
      initialScheduleLoading,
      scheduleLoadFailed,
      swapRequests,
      swapRequestsLoading,
      swapRequestsLoadFailed,
      staffDirectory,
      staffDirectoryByName,
      sections,
      collapsed,
      currentEmployeeId,
      handleRequestCover,
      handleDecideRequest,
      handleCommitted,
      weekStart,
      refetchWeekShifts,
      createRotaShift,
      updateRotaShift,
      deleteRotaShift,
      bulkCreateRotaShifts,
      publishCurrentWeek,
      weekLeaves,
      refetchWeekLeaves,
      setRotaLeave,
      removeRotaLeave,
      publishInfo,
      weekLocked,
      refreshPublishInfo,
    ],
  );

  return <AppStateCtx.Provider value={value}>{children}</AppStateCtx.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateCtx);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}
