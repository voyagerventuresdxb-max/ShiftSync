import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_MAINLAND_RULES, type Employee, type Roster, type Shift, type SwapRequest, type VenueConfig } from '../engine/types';
import { groupIntoSections, nameKey, type GroupedSection } from '../engine/roleGrouping';
import type { PreviewRow } from '../api/schedules';
import { fetchStaffDirectory, type StaffDirectoryEntry } from '../api/staffDirectory';

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
  handleRequestCover: (shiftId: string, coveringEmployeeId: string) => void;
  handleDecideRequest: (requestId: string, decision: 'approved' | 'denied') => void;
  handleCommitted: (rows: PreviewRow[], batchId: string) => void;
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
  const [reassignments, setReassignments] = useState<Record<string, string>>({});
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [staffDirectory, setStaffDirectory] = useState<StaffDirectoryEntry[]>([]);

  const mergedRoster: Roster = useMemo(() => {
    let employees = roster.employees;
    let shifts = roster.shifts;
    if (committed.employees.length > 0 || committed.shifts.length > 0) {
      employees = [...roster.employees];
      shifts = [...roster.shifts];
      for (const emp of committed.employees) {
        if (!employees.some((e) => e.id === emp.id)) employees.push(emp);
      }
      for (const s of committed.shifts) {
        if (!shifts.some((x) => x.id === s.id)) shifts.push(s);
      }
    }
    if (Object.keys(reassignments).length > 0) {
      shifts = shifts.map((s) => (reassignments[s.id] ? { ...s, employeeId: reassignments[s.id] } : s));
    }
    return { ...roster, employees, shifts };
  }, [roster, committed, reassignments]);

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

  const sections = useMemo(() => {
    const jobTitleByName = new Map<string, string | null | undefined>();
    for (const [key, entry] of staffDirectoryByName) jobTitleByName.set(key, entry.jobTitle);
    return groupIntoSections(mergedRoster.employees, jobTitleByName);
  }, [mergedRoster.employees, staffDirectoryByName]);

  const handleRequestCover = useCallback(
    (shiftId: string, coveringEmployeeId: string) => {
      const shift = mergedRoster.shifts.find((s) => s.id === shiftId);
      if (!shift) return;
      const request: SwapRequest = {
        id: `swap-${shiftId}-${Date.now()}`,
        shiftId,
        requestedBy: shift.employeeId,
        coveringEmployeeId,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      setSwapRequests((prev) => [...prev, request]);
    },
    [mergedRoster.shifts],
  );

  const handleDecideRequest = useCallback(
    (requestId: string, decision: 'approved' | 'denied') => {
      const request = swapRequests.find((r) => r.id === requestId);
      if (!request || request.status !== 'pending') return;
      setSwapRequests((prev) =>
        prev.map((r) => (r.id === requestId ? { ...r, status: decision, decidedAt: new Date().toISOString() } : r)),
      );
      if (decision === 'approved') {
        setReassignments((prev) => ({ ...prev, [request.shiftId]: request.coveringEmployeeId }));
      }
    },
    [swapRequests],
  );

  const handleCommitted = useCallback((rows: PreviewRow[], batchId: string) => {
    const employees: Employee[] = [];
    const shifts: Shift[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const empId = `upload-emp-${row.employeeName}`;
      if (!seen.has(empId)) {
        seen.add(empId);
        employees.push({
          id: empId,
          name: row.employeeName,
          role: row.role || 'staff',
          status: 'active',
          needsRoleReview: row.status === 'unmatched_role',
        });
      }
      shifts.push({
        id: `upload-shift-${batchId}-${row.rowNumber}`,
        employeeId: empId,
        date: row.date,
        start: row.startTime,
        end: row.endTime,
        type: 'service',
        overnight: row.overnight,
        requiredRole: row.role || undefined,
        source: `Uploaded roster (${row.role || 'role unknown'})`,
      });
    }
    setCommitted((prev) => ({
      employees: [...prev.employees, ...employees],
      shifts: [...prev.shifts, ...shifts],
    }));
  }, []);

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
