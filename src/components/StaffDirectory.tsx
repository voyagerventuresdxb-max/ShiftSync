import { useEffect, useState } from 'react';
import {
  fetchStaffDirectory,
  addStaffMember,
  updateStaffMember,
  type StaffDirectoryEntry,
} from '../api/staffDirectory';
import { ApiError } from '../api/schedules';

interface StaffDirectoryProps {
  locationId: string;
  /** Fires whenever the directory changes (add/edit), so the roster grid can re-derive the Management tier. */
  onChanged?: (staff: StaffDirectoryEntry[]) => void;
}

/**
 * Staff Directory — a simple add/edit UI for the venue-configured
 * staff-name -> job-title mapping. Deliberately NOT tied to roster
 * parsing: this is set once by the venue and read by the roster grid to
 * populate the Management tier, independent of whatever an upload
 * resolved for that person's role.
 */
export default function StaffDirectory({ locationId, onChanged }: StaffDirectoryProps) {
  const [staff, setStaff] = useState<StaffDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchStaffDirectory(locationId)
      .then((list) => {
        if (cancelled) return;
        setStaff(list);
        onChanged?.(list);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load the staff directory.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locationId, onChanged]);

  const handleTitleBlur = async (entry: StaffDirectoryEntry, jobTitle: string) => {
    if (jobTitle === (entry.jobTitle ?? '')) return; // unchanged, no request needed
    setSavingId(entry.id);
    try {
      const updated = await updateStaffMember(entry.id, { jobTitle: jobTitle || null });
      setStaff((prev) => {
        const next = prev.map((s) => (s.id === entry.id ? updated : s));
        onChanged?.(next);
        return next;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that job title.');
    } finally {
      setSavingId(null);
    }
  };

  const handleAdd = async () => {
    const fullName = newName.trim();
    if (!fullName) return;
    setAdding(true);
    try {
      const created = await addStaffMember(locationId, fullName, newTitle.trim());
      setStaff((prev) => {
        const next = [...prev, created].sort((a, b) => a.fullName.localeCompare(b.fullName));
        onChanged?.(next);
        return next;
      });
      setNewName('');
      setNewTitle('');
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that staff member.');
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="staff-directory">
      <button
        className="staff-directory-toggle"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className={`section-caret${collapsed ? ' collapsed' : ''}`}>▾</span>
        <span className="section-label">Staff Directory</span>
        <span className="section-count">{staff.length}</span>
      </button>

      {!collapsed && (
        <div className="staff-directory-body">
          <p className="hint">
            Job titles here are set by the venue and never inferred from an
            uploaded roster — they're what populates the Management tier in
            the roster grid above.
          </p>

          {error && (
            <div className="error-block" role="alert">
              <p>{error}</p>
            </div>
          )}

          {loading ? (
            <div className="status-block">
              <span className="spinner" aria-hidden />
              <p>Loading staff directory…</p>
            </div>
          ) : (
            <div className="preview-table-wrap">
              <table className="preview-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Job title</th>
                    <th>Parsed role</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((entry) => (
                    <StaffRow
                      key={entry.id}
                      entry={entry}
                      saving={savingId === entry.id}
                      onBlurTitle={(title) => handleTitleBlur(entry, title)}
                    />
                  ))}
                  {staff.length === 0 && (
                    <tr>
                      <td colSpan={3} className="cell-num">
                        No staff yet — add one below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="staff-directory-add">
            <input
              className="staff-directory-input"
              placeholder="Full name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleAdd()}
            />
            <input
              className="staff-directory-input"
              placeholder="Job title (e.g. Restaurant Manager)"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleAdd()}
            />
            <button className="btn btn-primary" onClick={() => void handleAdd()} disabled={adding || !newName.trim()}>
              {adding ? 'Adding…' : 'Add staff member'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function StaffRow({
  entry,
  saving,
  onBlurTitle,
}: {
  entry: StaffDirectoryEntry;
  saving: boolean;
  onBlurTitle: (title: string) => void;
}) {
  const [title, setTitle] = useState(entry.jobTitle ?? '');

  useEffect(() => {
    setTitle(entry.jobTitle ?? '');
  }, [entry.jobTitle]);

  return (
    <tr>
      <td>{entry.fullName}</td>
      <td>
        <input
          className="staff-directory-input staff-directory-input-inline"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => onBlurTitle(title)}
          placeholder="Not set"
          disabled={saving}
        />
      </td>
      <td className="cell-num">{entry.roleName ?? '—'}</td>
    </tr>
  );
}
