import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_MAINLAND_RULES, type Employee, type Roster, type Shift, type SwapRequest, type VenueConfig } from '../engine/types';
import { groupIntoSections, nameKey, type GroupedSection } from '../engine/roleGrouping';
import { buildCommitted, mergeCommitted, type PersistedRow } from '../engine/commitBinding';
import type { PreviewRow } from '../api/schedules';
import { fetchStaffDirectory, type StaffDirectoryEntry } from '../api/staffDirectory';
import { fetchSwapRequests, createSwapRequest, decideSwapRequest } from '../api/swapRequests';

const config: VenueConfig = {
  id: 'venue-1',
  name: 'Demo Venue',
  jurisdiction: 'mainland',
  compliance: DEFAULT_MAINLAND_RULES,
  shiftTypeLabels: { bar: 'bar', kitchen: 'kitchen', service: 'service' },
  roleLabels: ['bartender', 'server', 'chef', 'host'],
  knownStaff: ['Maria', 'Jose', 'Ahmed', 'Priya'],
};

const WEEK_START = '2026-08-17';

interface AppStateValue {
  config: VenueConfig;
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
}

const AppStateCtx = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const roster: Roster = useMemo(
    () => ({
      id: `roster-${WEEK_START}`,
      venueId: config.id,
      weekStart: WEEK_START,
      employees: [],
      shifts: [],
      createdAt: new Date().toISOString(),
    }),
    [],
  );

  const [committed, setCommitted] = useState<{ employees: Employee[]; shifts: Shift[] }>({
    employees: [],
    shifts: [],
  });
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [staffDirectory, setStaffDirectory] = useState<StaffDirectoryEntry[]>([]);
  const [currentEmployeeId, setCurrentEmployeeId] = useState<string | undefined>(undefined);

  const mergedRoster: Roster = useMemo(() => mergeCommitted(roster, committed), [roster, committed]);

  const staffDirectoryByName = useMemo(() => {
    const map = new Map<string, StaffDirectoryEntry>();
    for (const entry of staffDirectory) map.set(nameKey(entry.fullName), entry);
    return map;
  }, [staffDirectory]);

  useEffect(() => {
    let cancelled = false;
    fetchStaffDirectory('seed-location')
      .then((list) => {
        if (!cancelled) setStaffDirectory(list);
      })
      .catch(() => {
        // StaffDirectory route itself surfaces a load error when visited; nothing to show here.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (currentEmployeeId === undefined && mergedRoster.employees.length > 0) {
      setCurrentEmployeeId(mergedRoster.employees[0]!.id);
    }
  }, [currentEmployeeId, mergedRoster.employees]);

  useEffect(() => {
    let cancelled = false;
    fetchSwapRequests('seed-location')
      .then((list) => {
        if (!cancelled) setSwapRequests(list);
      })
      .catch(() => {
        // ApprovalsPanel surfaces its own load error when rendered; nothing to show here.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = useMemo(() => {
    const jobTitleByName = new Map<string, string | null | undefined>();
    for (const [key, entry] of staffDirectoryByName) jobTitleByName.set(key, entry.jobTitle);
    return groupIntoSections(mergedRoster.employees, jobTitleByName);
  }, [mergedRoster.employees, staffDirectoryByName]);

  const handleRequestCover = useCallback(
    async (shiftId: string, coveringEmployeeId: string) => {
      const shift = mergedRoster.shifts.find((s) => s.id === shiftId);
      if (!shift) return;
      try {
        const request = await createSwapRequest({
          shiftId,
          requestedById: shift.employeeId,
          targetUserId: coveringEmployeeId,
        });
        setSwapRequests((prev) => [...prev, request]);
      } catch {
        // PersonalRota's cover-request UI has no error slot today — a follow-up
        // phase can surface this; for now the request simply doesn't appear.
      }
    },
    [mergedRoster.shifts],
  );

  const handleDecideRequest = useCallback(async (requestId: string, decision: 'approved' | 'denied') => {
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
      await decideSwapRequest(requestId, decision);
    } catch {
      // Surfacing a dedicated error message (e.g. for a locked-request 409)
      // is ApprovalsPanel's job in a follow-up — the refetch below already
      // makes the failure visible by flipping the row back to its true
      // (now-locked) state instead of silently doing nothing.
    } finally {
      try {
        const fresh = await fetchSwapRequests('seed-location');
        setSwapRequests(fresh);
      } catch {
        // Load-error UI for this list is ApprovalsPanel's concern; leave the
        // previous (possibly stale) list in place rather than clearing it.
      }
    }
  }, []);

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

  // setCollapsed/setStaffDirectory are useState setters — stable by definition,
  // and `config` is a module constant, so neither needs to be a dependency.
  const value: AppStateValue = useMemo(
    () => ({
      config,
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
    }),
    [
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
    ],
  );

  return <AppStateCtx.Provider value={value}>{children}</AppStateCtx.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateCtx);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}
