import { useMemo, useState } from 'react';
import { parseRosterText } from './engine/parser';
import { DEFAULT_MAINLAND_RULES, type VenueConfig } from './engine/types';
import { shiftHours } from './engine/time';

const SAMPLE = [
  'Roster week of Aug 17',
  'Maria bartender 6pm-2am Fri',
  'Jose server 9am-5pm Mon',
  'Ahmed chef 10pm-4am Sat',
  'Priya host 12pm-8pm Wed',
].join('\n');

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
  const [text, setText] = useState(SAMPLE);

  const result = useMemo(
    () => parseRosterText(text, config, WEEK_START),
    [text],
  );

  const { roster, warnings, unparsedLines, durationMs } = result;

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1 className="brand">ShiftSync</h1>
        <p className="tagline">
          WhatsApp-to-App hospitality shift scheduling for Dubai &amp; the GCC.
        </p>
      </header>

      <section className="parser">
        <h2 className="section-title">Parser</h2>
        <p className="hint">
          Paste a roster (WhatsApp text, Excel export) — get a clean digital
          roster in under 10 seconds.
        </p>
        <textarea
          className="paste-area"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          spellCheck={false}
        />
        <div className="meta">
          <span className="badge">
            {roster.employees.length} staff · {roster.shifts.length} shifts
          </span>
          <span className="badge">parsed in {durationMs}ms</span>
        </div>
      </section>

      {warnings.length > 0 && (
        <section className="warnings">
          <h3 className="section-title">Warnings</h3>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      {unparsedLines.length > 0 && (
        <section className="warnings">
          <h3 className="section-title">Unparsed lines</h3>
          <ul>
            {unparsedLines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="roster">
        <h2 className="section-title">Roster</h2>
        <div className="grid">
          <div className="grid-head">
            <span className="cell head">Staff</span>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <span className="cell head" key={d}>
                {d}
              </span>
            ))}
            <span className="cell head">Hours</span>
          </div>
          {roster.employees.map((emp) => {
            const empShifts = roster.shifts.filter(
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
                  <span className="role">{emp.role}</span>
                </span>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => {
                  const shift = empShifts.find((s) =>
                    s.date.endsWith(daySuffix(d)),
                  );
                  return (
                    <span className={`cell shift ${shift?.type ?? ''}`} key={d}>
                      {shift ? `${shift.start}-${shift.end}` : ''}
                    </span>
                  );
                })}
                <span className="cell hours">{total.toFixed(1)}h</span>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function daySuffix(day: string): string {
  const map: Record<string, string> = {
    Mon: '08-17',
    Tue: '08-18',
    Wed: '08-19',
    Thu: '08-20',
    Fri: '08-21',
    Sat: '08-22',
    Sun: '08-23',
  };
  return map[day] ?? '';
}
