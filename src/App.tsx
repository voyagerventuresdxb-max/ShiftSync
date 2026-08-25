import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_MAINLAND_RULES, type Employee, type Roster, type Shift, type SwapRequest, type VenueConfig } from './engine/types';
import { shiftHours } from './engine/time';
import { periodOf, weekdayOf } from './engine/rosterView';
import ShiftUpload from './components/ShiftUpload';
import Dashboard from './components/Dashboard';
import StaffDirectory from './components/StaffDirectory';
import FloorPlanTab from './components/FloorPlan/FloorPlanTab';
import type { PreviewRow } from './api/schedules';
import { fetchStaffDirectory, type StaffDirectoryEntry } from './api/staffDirectory';

/**
 * Ordered role sections for the categorized roster grid, matching the
 * 7shifts-style mobile reference layout. Staff are grouped under these
 * headers in this order; any role not listed falls into "Other".
 *
 * The "manager" (Management) tier is deliberately populated two ways: the
 * usual match against a parsed role string below, PLUS a direct
 * cross-reference against the Staff Directory (see sectionForEmployee) —
 * a venue's own job title is authoritative over whatever (if anything) an
 * uploaded roster happened to resolve for that person, and catches staff
 * the parser correctly left unlabeled (no section header for them in the
 * source file) rather than guessed.
 */
const ROLE_SECTIONS: { key: string; label: string; match: string[] }[] = [
  { key: 'manager', label: 'Management', match: ['management', 'manager', 'gm', 'floor manager', 'general manager', 'restaurant manager', 'duty manager', 'operations manager', 'assistant manager'] },
  { key: 'supervisor', label: 'Supervisor', match: ['supervisor', 'supervisors', 'team leader', 'team lead', 'shift supervisor', 'floor supervisor'] },
  { key: 'head-waiter', label: 'Head Waiter', match: ['head waiter', 'head waiters', 'head server', 'senior waiter'] },
  { key: 'waiter', label: 'Waiter', match: ['waiter', 'waiters', 'server', 'servers', 'wait staff', 'waiting staff', 'floor', 'floor staff', 'floor team', 'floor service'] },
  { key: 'runner', label: 'Runner', match: ['runner', 'runners', 'food runner', 'bar runner'] },
];

/** Normalize a role string for section matching (lowercase, alnum+space). */
function roleKey(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Normalize a person's name for Staff Directory lookup (lowercase, trimmed). */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** True when a Staff Directory job title indicates Management — pattern-based, not a fixed word list, so any venue's own manager-ish title works. */
function isManagementTitle(jobTitle: string): boolean {
  return /manager|management/i.test(jobTitle);
}

/** Resolve an employee's role to a section key, defaulting to 'other'. */
function sectionForRole(role: string): string {
  const key = roleKey(role);
  for (const section of ROLE_SECTIONS) {
    if (section.match.some((m) => roleKey(m) === key)) return section.key;
  }
  return 'other';
}

/**
 * Resolve an employee to a grid section, cross-referencing the Staff
 * Directory FIRST — a venue-confirmed job title always wins over whatever
 * the parser resolved (or didn't) for this person, per the explicit
 * "not inferred from the uploaded roster" requirement.
 */
function sectionForEmployee(emp: Employee, staffDirectoryByName: Map<string, StaffDirectoryEntry>): string {
  const entry = staffDirectoryByName.get(nameKey(emp.name));
  if (entry?.jobTitle && isManagementTitle(entry.jobTitle)) return 'manager';
  return sectionForRole(emp.role);
}

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
    const needsReview = mergedRoster.employees.filter((e) => e.needsRoleReview);
    const grouped = new Map<string, Employee[]>();
    for (const emp of mergedRoster.employees) {
      if (emp.needsRoleReview) continue;
      const key = sectionForEmployee(emp, staffDirectoryByName);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(emp);
    }
    const ordered: { key: string; label: string; employees: Employee[]; flagged?: boolean }[] = [];
    if (needsReview.length > 0) {
      ordered.push({ key: 'needs-review', label: 'Needs Review — Role Unresolved', employees: needsReview, flagged: true });
    }
    for (const section of ROLE_SECTIONS) {
      const emps = grouped.get(section.key);
      if (emps && emps.length > 0) {
        ordered.push({ key: section.key, label: section.label, employees: emps });
      }
    }
    const other = grouped.get('other');
    if (other && other.length > 0) {
      ordered.push({ key: 'other', label: 'Other', employees: other });
    }
    return ordered;
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

