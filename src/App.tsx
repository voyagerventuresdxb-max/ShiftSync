import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_MAINLAND_RULES, type Employee, type Roster, type Shift, type SwapRequest, type VenueConfig } from './engine/types';
import { shiftHours } from './engine/time';
import { periodOf, weekdayOf } from './engine/rosterView';
import { groupIntoSections, nameKey } from './engine/roleGrouping';
import ShiftUpload from './components/ShiftUpload';
import Dashboard from './components/Dashboard';
import StaffDirectory from './components/StaffDirectory';
import FloorPlanTab from './components/FloorPlan/FloorPlanTab';
import type { PreviewRow } from './api/schedules';
import { fetchStaffDirectory, type StaffDirectoryEntry } from './api/staffDirectory';

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

export default function App() {
  // Roster now comes exclusively from the Upload Roster flow (Excel/CSV/
  // PDF/image) — no paste-text parser. This is the empty shell mergedRoster
  // starts from before any file is uploaded.
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

  // Shifts committed through the Upload Roster flow, merged into the main
  // roster view so the grid and weekly totals reflect them immediately.
  const [committed, setCommitted] = useState<{ employees: Employee[]; shifts: Shift[] }>({
    employees: [],
    shifts: [],
  });

  // Approved swap/cover requests reassign a shift to a different employee.
  // Keyed by shiftId -> the employeeId who now owns it.
  const [reassignments, setReassignments] = useState<Record<string, string>>({});
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([]);

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
      shifts = shifts.map((s) =>
        reassignments[s.id] ? { ...s, employeeId: reassignments[s.id] } : s,
      );
    }
    return { ...roster, employees, shifts };
  }, [roster, committed, reassignments]);

  const handleRequestCover = (shiftId: string, coveringEmployeeId: string) => {
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
  };

  const handleDecideRequest = (requestId: string, decision: 'approved' | 'denied') => {
    const request = swapRequests.find((r) => r.id === requestId);
    if (!request || request.status !== 'pending') return;
    setSwapRequests((prev) =>
      prev.map((r) =>
        r.id === requestId ? { ...r, status: decision, decidedAt: new Date().toISOString() } : r,
      ),
    );
    if (decision === 'approved') {
      setReassignments((prev) => ({ ...prev, [request.shiftId]: request.coveringEmployeeId }));
    }
  };

  // Collapsed role sections (default: all expanded).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [activeTab, setActiveTab] = useState<'home' | 'scheduling' | 'floor-plan' | 'people'>('home');

  // Staff Directory — venue-configured name -> job-title mapping, fetched
  // once by StaffDirectory and kept here so the grid can cross-reference it.
  const [staffDirectory, setStaffDirectory] = useState<StaffDirectoryEntry[]>([]);
  const staffDirectoryByName = useMemo(() => {
    const map = new Map<string, StaffDirectoryEntry>();
    for (const entry of staffDirectory) map.set(nameKey(entry.fullName), entry);
    return map;
  }, [staffDirectory]);

  // Fetched independently of the People tab's own mount — the Scheduling
  // tab's Management-tier cross-reference needs this even if nobody has
  // visited People yet this session.
  useEffect(() => {
    let cancelled = false;
    fetchStaffDirectory('seed-location')
      .then((list) => {
        if (!cancelled) setStaffDirectory(list);
      })
      .catch(() => {
        // StaffDirectory itself surfaces a load error when the tab is visited; nothing to show here.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Group employees into ordered role sections. Employees flagged
  // needsRoleReview never enter the normal role grouping — an upload row
  // whose role couldn't be resolved isn't actually assigned any role, so
  // sorting it into "Other" (or worse, a coincidentally-matching section)
  // would bury exactly the row that needs the manager's attention. They get
  // their own dedicated, visually-flagged section instead, shown first.
  const sections = useMemo(() => {
    const jobTitleByName = new Map<string, string | null | undefined>();
    for (const [key, entry] of staffDirectoryByName) jobTitleByName.set(key, entry.jobTitle);
    return groupIntoSections(mergedRoster.employees, jobTitleByName);
  }, [mergedRoster.employees, staffDirectoryByName]);

  const handleCommitted = (rows: PreviewRow[], batchId: string) => {
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
        // Namespaced by batchId (not just rowNumber, which resets per file)
        // so two uploads confirmed in the same session never collide and
        // silently drop a shift during the mergedRoster dedup-by-id merge.
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
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1 className="brand">ShiftSync</h1>
        <p className="tagline">
          WhatsApp-to-App hospitality shift scheduling for Dubai &amp; the GCC.
        </p>
      </header>

      {activeTab === 'home' && (
        <Dashboard
          roster={mergedRoster}
          config={config}
          swapRequests={swapRequests}
          onRequestCover={handleRequestCover}
          onDecideRequest={handleDecideRequest}
        />
      )}

      {activeTab === 'scheduling' && (
        <>
          <ShiftUpload locationId="seed-location" onCommitted={handleCommitted} />

          <section className="roster">
            <h2 className="section-title">Roster</h2>
            <div className="roster-table-grid">
              <div className="grid-head">
                <span className="cell head">Staff</span>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                  <span className="cell head" key={d}>
                    {d}
                  </span>
                ))}
                <span className="cell head">Hours</span>
              </div>
              {sections.map((section) => {
                const isCollapsed = !!collapsed[section.key];
                return (
                  <div className="roster-section" key={section.key}>
                    <button
                      className={`roster-section-head${section.flagged ? ' roster-section-head-warn' : ''}`}
                      onClick={() =>
                        setCollapsed((prev) => ({
                          ...prev,
                          [section.key]: !prev[section.key],
                        }))
                      }
                      aria-expanded={!isCollapsed}
                    >
                      <span className={`section-caret${isCollapsed ? ' collapsed' : ''}`}>
                        ▾
                      </span>
                      <span className="section-label">{section.label}</span>
                      <span className="section-count">{section.employees.length}</span>
                    </button>
                    {!isCollapsed &&
                      section.employees.map((emp) => {
                        const empShifts = mergedRoster.shifts.filter(
                          (s) => s.employeeId === emp.id,
                        );
                        const total = empShifts.reduce(
                          (sum, s) => sum + shiftHours(s.start, s.end),
                          0,
                        );
                        return (
                          <div className="grid-row" key={emp.id}>
                            <span className="cell name">
                              {emp.name}
                              <span className="role">
                                {staffDirectoryByName.get(nameKey(emp.name))?.jobTitle || emp.role}
                              </span>
                              {emp.needsRoleReview && (
                                <span className="badge badge-warn" title="This shift is not saved. Fix the role in the source file (or add it to the Staff Directory) and re-upload.">
                                  ⚠ Not saved — role unresolved
                                </span>
                              )}
                            </span>
                            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(
                              (d) => {
                                const dayShifts = empShifts.filter(
                                  (s) => weekdayOf(s.date) === d,
                                );
                                return (
                                  <span
                                    className={`cell shift ${dayShifts[0]?.type ?? ''}`}
                                    key={d}
                                  >
                                    {dayShifts.length > 1 ? (
                                      <span className="split">
                                        {dayShifts.map((s) => (
                                          <span key={s.id}>
                                            <span className="period">
                                              {periodOf(s)}
                                            </span>
                                            {s.start}-{s.end}
                                          </span>
                                        ))}
                                      </span>
                                    ) : dayShifts.length === 1 ? (
                                      `${dayShifts[0].start}-${dayShifts[0].end}`
                                    ) : (
                                      ''
                                    )}
                                  </span>
                                );
                              },
                            )}
                            <span className="cell hours">{total.toFixed(1)}h</span>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {activeTab === 'floor-plan' && <FloorPlanTab locationId="seed-location" />}

      {activeTab === 'people' && <StaffDirectory locationId="seed-location" onChanged={setStaffDirectory} />}

      <nav className="bottom-nav">
        {(
          [
            ['home', 'Home'],
            ['scheduling', 'Scheduling'],
            ['floor-plan', 'Floor Plan'],
            ['people', 'People'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={`bottom-nav-item${activeTab === key ? ' bottom-nav-item-active' : ''}`}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
    </main>
  );
}

