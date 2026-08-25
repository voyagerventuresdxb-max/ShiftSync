import { AppShell } from '../components/shiftsync/AppShell';
import ShiftUpload from '../components/ShiftUpload';
import { periodOf, weekdayOf } from '../engine/rosterView';
import { shiftHours } from '../engine/time';
import { useAppState } from '../state/AppStateContext';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export default function SchedulingRoute() {
  const { mergedRoster, sections, collapsed, setCollapsed, handleCommitted, staffDirectoryByName } = useAppState();

  return (
    <AppShell title="Scheduling">
      <ShiftUpload locationId="seed-location" onCommitted={handleCommitted} />

      <section className="roster">
        <h2 className="section-title">Roster</h2>
        <div className="roster-table-grid">
          <div className="grid-head">
            <span className="cell head">Staff</span>
            {DAYS.map((d) => (
              <span className="cell head" key={d}>{d}</span>
            ))}
            <span className="cell head">Hours</span>
          </div>
          {sections.map((section) => {
            const isCollapsed = !!collapsed[section.key];
            return (
              <div className="roster-section" key={section.key}>
                <button
                  className={`roster-section-head${section.flagged ? ' roster-section-head-warn' : ''}`}
                  onClick={() => setCollapsed((prev) => ({ ...prev, [section.key]: !prev[section.key] }))}
                  aria-expanded={!isCollapsed}
                >
                  <span className={`section-caret${isCollapsed ? ' collapsed' : ''}`}>▾</span>
                  <span className="section-label">{section.label}</span>
                  <span className="section-count">{section.employees.length}</span>
                </button>
                {!isCollapsed &&
                  section.employees.map((emp) => {
                    const empShifts = mergedRoster.shifts.filter((s) => s.employeeId === emp.id);
                    const total = empShifts.reduce((sum, s) => sum + shiftHours(s.start, s.end), 0);
                    return (
                      <div className="grid-row" key={emp.id}>
                        <span className="cell name">
                          {emp.name}
                          <span className="role">
                            {staffDirectoryByName.get(emp.name.trim().toLowerCase())?.jobTitle || emp.role}
                          </span>
                          {emp.needsRoleReview && (
                            <span className="badge badge-warn" title="This shift is not saved. Fix the role in the source file (or add it to the Staff Directory) and re-upload.">
                              ⚠ Not saved — role unresolved
                            </span>
                          )}
                        </span>
                        {DAYS.map((d) => {
                          const dayShifts = empShifts.filter((s) => weekdayOf(s.date) === d);
                          return (
                            <span className={`cell shift ${dayShifts[0]?.type ?? ''}`} key={d}>
                              {dayShifts.length > 1 ? (
                                <span className="split">
                                  {dayShifts.map((s) => (
                                    <span key={s.id}>
                                      <span className="period">{periodOf(s)}</span>
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
                        })}
                        <span className="cell hours">{total.toFixed(1)}h</span>
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </section>
    </AppShell>
  );
}
