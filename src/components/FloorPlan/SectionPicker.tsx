import { useMemo, useState } from 'react';
import type { StaffDirectoryEntry } from '../../api/staffDirectory';
import { initials } from './staffFormat';

interface Props {
  sectionLabel: string;
  staff: StaffDirectoryEntry[];
  onPick: (staffId: string, dutyLabel: string | null) => void;
  onClose: () => void;
}

/** Tap-to-pick search-select — the faster default for one-thumb floor-side use. */
export default function SectionPicker({ sectionLabel, staff, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [dutyLabel, setDutyLabel] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter((s) => s.fullName.toLowerCase().includes(q));
  }, [staff, query]);

  return (
    <div className="fp-picker-backdrop" onClick={onClose}>
      <div className="fp-picker" onClick={(e) => e.stopPropagation()}>
        <header className="fp-picker-head">
          <h3>Assign to {sectionLabel}</h3>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <input
          className="staff-directory-input"
          placeholder="Duty (optional) — e.g. Expo, Bar-back"
          value={dutyLabel}
          onChange={(e) => setDutyLabel(e.target.value)}
        />
        <input
          className="staff-directory-input"
          autoFocus
          placeholder="Search staff…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="fp-picker-list">
          {filtered.map((s) => (
            <button key={s.id} className="fp-picker-item" onClick={() => onPick(s.id, dutyLabel.trim() || null)}>
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border-strong bg-muted text-[10px] font-semibold">
                {initials(s.fullName)}
              </span>
              <span className="min-w-0 flex-1 truncate">{s.fullName}</span>
              {s.jobTitle && <span className="cell-num shrink-0">{s.jobTitle}</span>}
            </button>
          ))}
          {filtered.length === 0 && <p className="hint">No staff match "{query}".</p>}
        </div>
      </div>
    </div>
  );
}
