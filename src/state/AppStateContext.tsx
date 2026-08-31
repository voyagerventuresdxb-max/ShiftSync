import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_MAINLAND_RULES, type Employee, type Roster, type Shift, type SwapRequest, type VenueConfig } from '../engine/types';
import { groupIntoSections, nameKey, type GroupedSection } from '../engine/roleGrouping';
import { buildCommitted, mergeCommitted, type PersistedRow } from '../engine/commitBinding';
import { currentWeekStart } from '../engine/weekStart';
import type { PreviewRow } from '../api/schedules';
import { fetchStaffDirectory, type StaffDirectoryEntry } from '../api/staffDirectory';
import { fetchSwapRequests, createSwapRequest, decideSwapRequest } from '../api/swapRequests';
import { fetchWeekShifts, createShift, updateShift, deleteShift, bulkCreateShifts, publishWeek, fetchPublishStatus } from '../api/shifts';
import { useIdentity } from './IdentityContext';

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
  /** The real logged-in session's venue — null with no session. The single source every consumer should read instead of a hardcoded id. */
  locationId: string | null;
  mergedRoster: Roster;
  swapRequests: SwapRequest[];
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
  createRotaShift: (input: Omit<Parameters<typeof createShift>[0], 'locationId'>) => Promise<void>;
  updateRotaShift: (id: string, patch: Parameters<typeof updateShift>[1]) => Promise<void>;
  deleteRotaShift: (id: string, actorId?: string) => Promise<void>;
  bulkCreateRotaShifts: (shifts: Parameters<typeof bulkCreateShifts>[0]['shifts'], createdById?: string) => Promise<void>;
  publishCurrentWeek: (publishedById?: string) => Promise<{ publishedAt: string; notifiedCount: number }>;
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
  const locationId = session?.user.locationId ?? null;
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
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([]);
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

  const refetchWeekShifts = useCallback(async () => {
    // No session, no real venue to scope this fetch to — clear rather than
    // fetch against a hardcoded/wrong location. Same shared-device reasoning
    // as the staff-directory/swap-requests effects below.
    if (!locationId) {
      setWeekShifts([]);
      return;
    }
    const seq = ++reqSeqRef.current;
    try {
      const dtos = await fetchWeekShifts(locationId, weekStart);
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
    } catch {
      // A failed fetch for the new week must not leave the previous week's
      // shifts rendered (that would look like correct data for the wrong
      // week) — clear to empty so RotaBuilder/Team Matrix show their own
      // empty state instead of stale data. A stale failure is discarded for
      // the same reason a stale success is: it must not clear a newer week's
      // freshly-loaded shifts.
      if (seq !== reqSeqRef.current) return;
      setWeekShifts([]);
    }
  }, [weekStart, locationId]);

  useEffect(() => {
    void refetchWeekShifts();
  }, [refetchWeekShifts]);

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
    if (currentEmployeeId === undefined && mergedRoster.employees.length > 0) {
      setCurrentEmployeeId(mergedRoster.employees[0]!.id);
    }
  }, [currentEmployeeId, mergedRoster.employees]);

  useEffect(() => {
    // Swap requests are session-gated server-side now. Same shared-device
    // reasoning as the staff-directory effect above: clear on sign-out, not
    // just skip the refetch, so a departed user's swap-request history
    // doesn't keep rendering for whoever uses the device next.
    if (!session) {
      setSwapRequests([]);
      return;
    }
    let cancelled = false;
    fetchSwapRequests(session.token, session.user.locationId)
      .then((list) => {
        if (!cancelled) setSwapRequests(list);
      })
      .catch(() => {
        // ApprovalsPanel surfaces its own load error when rendered; nothing to show here.
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
      // 401 anyway; PersonalRota has no error slot for this today (same as
      // the catch below), so this simply no-ops.
      if (!session) return;
      const shift = mergedRoster.shifts.find((s) => s.id === shiftId);
      if (!shift) return;
      try {
        const request = await createSwapRequest(session.token, {
          shiftId,
          // Only honored server-side for a MANAGER/OWNER session (filing on
          // behalf of the employee selected in SchedulingRoute's "Viewing"
          // dropdown); ignored outright for a STAFF session, which can only
          // ever file for itself.
          requestedById: shift.employeeId,
          targetUserId: coveringEmployeeId,
        });
        setSwapRequests((prev) => [...prev, request]);
      } catch {
        // PersonalRota's cover-request UI has no error slot today — a follow-up
        // phase can surface this; for now the request simply doesn't appear.
      }
    },
    [mergedRoster.shifts, session],
  );

  const handleDecideRequest = useCallback(
    async (requestId: string, decision: 'approved' | 'denied') => {
      // Deciding is manager/owner-only server-side; with no session there is
      // no reviewer to attribute the decision to.
      if (!session) return;
      // Whatever happens to THIS request, a decide attempt can change the
      // `locked` status of every sibling request on the same shift (the
      // server auto-locks the losing requests once one approval reassigns the
      // shift). Patching only the one row we just decided leaves those
      // siblings showing stale `locked: false` in local state until a full
      // reload — so a manager could click Approve on an already-locked
      // request and get a silent 409 with no visible feedback. Re-fetching
      // the full list after every attempt (success or failure) keeps the
      // client's view self-correcting instead.
      try {
        await decideSwapRequest(session.token, requestId, decision);
      } catch {
        // Surfacing a dedicated error message (e.g. for a locked-request 409)
        // is ApprovalsPanel's job in a follow-up — the refetch below already
        // makes the failure visible by flipping the row back to its true
        // (now-locked) state instead of silently doing nothing.
      } finally {
        try {
          const fresh = await fetchSwapRequests(session.token, session.user.locationId);
          setSwapRequests(fresh);
        } catch {
          // Load-error UI for this list is ApprovalsPanel's concern; leave the
          // previous (possibly stale) list in place rather than clearing it.
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
    async (input: Omit<Parameters<typeof createShift>[0], 'locationId'>) => {
      // RotaBuilder/ScheduleEditor only ever render inside a RequireSession-
      // gated route, so this should never actually fire without a session —
      // but if it somehow did, sending `locationId: null` to the API would
      // either 400 or (worse) silently resolve to the wrong venue. Throwing
      // here surfaces a clear error through the caller's existing try/catch
      // rather than either of those.
      if (!locationId) throw new Error('You must be signed in to do this.');
      await createShift({ ...input, locationId });
      await refetchWeekShifts();
    },
    [refetchWeekShifts, locationId],
  );

  const updateRotaShift = useCallback(
    async (id: string, patch: Parameters<typeof updateShift>[1]) => {
      await updateShift(id, patch);
      await refetchWeekShifts();
    },
    [refetchWeekShifts],
  );

  const deleteRotaShift = useCallback(
    async (id: string, actorId?: string) => {
      await deleteShift(id, actorId);
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
    [refetchWeekShifts],
  );

  const bulkCreateRotaShifts = useCallback(
    // `createdById` is threaded through so bulk-created shifts get a real
    // actor in the AuditLog — the underlying client has always accepted it,
    // this wrapper just never passed it on.
    async (shifts: Parameters<typeof bulkCreateShifts>[0]['shifts'], createdById?: string) => {
      if (!locationId) throw new Error('You must be signed in to do this.');
      await bulkCreateShifts({ locationId, createdById, shifts });
      await refetchWeekShifts();
    },
    [refetchWeekShifts, locationId],
  );

  const publishCurrentWeek = useCallback(
    async (publishedById?: string) => {
      if (!locationId) throw new Error('You must be signed in to do this.');
      const result = await publishWeek(locationId, weekStart, publishedById);
      await refetchWeekShifts();
      return result;
    },
    [weekStart, refetchWeekShifts, locationId],
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

  const weekLocked = Boolean(publishInfo?.publishedAt) && !publishInfo?.hasUnpublishedChanges;

  // setCollapsed/setStaffDirectory are useState setters — stable by definition,
  // and `config` is a module constant, so neither needs to be a dependency.
  const value: AppStateValue = useMemo(
    () => ({
      config,
      locationId,
      mergedRoster,
      swapRequests,
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
      publishInfo,
      weekLocked,
      refreshPublishInfo,
    }),
    [
      locationId,
      mergedRoster,
      swapRequests,
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
