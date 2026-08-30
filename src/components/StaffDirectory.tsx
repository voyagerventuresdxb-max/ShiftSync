import { useEffect, useMemo, useState } from 'react';
import {
  fetchStaffDirectory,
  addStaffMember,
  updateStaffMember,
  type StaffDirectoryEntry,
} from '../api/staffDirectory';
import { ApiError } from '../api/schedules';
import { useIdentity } from '../state/IdentityContext';

interface StaffDirectoryProps {
  locationId: string;
  /** Fires whenever the directory changes (add/edit), so the roster grid can re-derive the Management tier. */
  onChanged?: (staff: StaffDirectoryEntry[]) => void;
}

type EditableFieldUpdates = Partial<
  Pick<StaffDirectoryEntry, 'jobTitle' | 'phone' | 'preferredLanguage' | 'hiredAt' | 'isActive'>
>;

/**
 * Staff Directory — a simple add/edit UI for the venue-configured
 * staff-name -> job-title mapping. Deliberately NOT tied to roster
 * parsing: this is set once by the venue and read by the roster grid to
 * populate the Management tier, independent of whatever an upload
 * resolved for that person's role.
 *
 * Also carries phone, preferred language, start date (hiredAt), and
 * employment status (isActive) — all editable here — plus a read-only
 * venue column (joined server-side from Location.name).
 */
export default function StaffDirectory({ locationId, onChanged }: StaffDirectoryProps) {
  const { session } = useIdentity();
  const [staff, setStaff] = useState<StaffDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    // Reads are session-gated server-side now — with no session yet (e.g. a
    // fresh load before login resolves) there is no token to send, so skip
    // the call rather than firing a request that can only 401. Resolve the
    // loading state immediately instead of leaving the spinner stuck.
    if (!session) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchStaffDirectory(session.token, locationId)
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
  }, [locationId, onChanged, session]);

  // Previously-seen preferred languages, for the datalist autocomplete —
  // same idea as the 86 List's station autocomplete (EightySixBoard.tsx).
  const knownLanguages = useMemo(
    () => [...new Set(staff.map((s) => s.preferredLanguage).filter((v): v is string => !!v))].sort(),
    [staff],
  );

  const handleFieldSave = async (entry: StaffDirectoryEntry, updates: EditableFieldUpdates, errorMessage: string) => {
    // Editing is manager-only server-side; with no session there is no
    // token to send and the request could only ever 401.
    if (!session) return;
    setSavingId(entry.id);
    try {
      const updated = await updateStaffMember(session.token, entry.id, updates);
      setStaff((prev) => {
        const next = prev.map((s) => (s.id === entry.id ? updated : s));
        onChanged?.(next);
        return next;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorMessage);
    } finally {
      setSavingId(null);
    }
  };

  const handleAdd = async () => {
    const fullName = newName.trim();
    if (!fullName) return;
    // Adding is manager-only server-side; with no session there is no
    // token to send and the request could only ever 401.
    if (!session) return;
    setAdding(true);
    try {
      const created = await addStaffMember(session.token, { fullName, jobTitle: newTitle.trim() || null });
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

          <datalist id="staff-directory-languages">
            {knownLanguages.map((lang) => (
              <option key={lang} value={lang} />
            ))}
          </datalist>

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
                    <th>Phone</th>
                    <th>Preferred language</th>
                    <th>Start date</th>
                    <th>Status</th>
                    <th>Venue</th>
                    <th>Parsed role</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((entry) => (
                    <StaffRow
                      key={entry.id}
                      entry={entry}
                      saving={savingId === entry.id}
                      onSave={(updates, errorMessage) => handleFieldSave(entry, updates, errorMessage)}
                    />
                  ))}
                  {staff.length === 0 && (
                    <tr>
                      <td colSpan={8} className="cell-num">
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
  onSave,
}: {
  entry: StaffDirectoryEntry;
  saving: boolean;
  onSave: (updates: EditableFieldUpdates, errorMessage: string) => void;
}) {
  const [title, setTitle] = useState(entry.jobTitle ?? '');
  const [phone, setPhone] = useState(entry.phone ?? '');
  const [preferredLanguage, setPreferredLanguage] = useState(entry.preferredLanguage ?? '');
  const [hiredAt, setHiredAt] = useState(entry.hiredAt ?? '');

  useEffect(() => {
    setTitle(entry.jobTitle ?? '');
  }, [entry.jobTitle]);

  useEffect(() => {
    setPhone(entry.phone ?? '');
  }, [entry.phone]);

  useEffect(() => {
    setPreferredLanguage(entry.preferredLanguage ?? '');
  }, [entry.preferredLanguage]);

  useEffect(() => {
    setHiredAt(entry.hiredAt ?? '');
  }, [entry.hiredAt]);

  return (
    <tr>
      <td>{entry.fullName}</td>
      <td>
        <input
          className="staff-directory-input staff-directory-input-inline"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title === (entry.jobTitle ?? '')) return;
            onSave({ jobTitle: title || null }, 'Could not save that job title.');
          }}
          placeholder="Not set"
          disabled={saving}
        />
      </td>
      <td>
        <input
          className="staff-directory-input staff-directory-input-inline"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onBlur={() => {
            if (phone === (entry.phone ?? '')) return;
            onSave({ phone: phone || null }, 'Could not save that phone number.');
          }}
          placeholder="Not set"
          disabled={saving}
        />
      </td>
      <td>
        <input
          className="staff-directory-input staff-directory-input-inline"
          list="staff-directory-languages"
          value={preferredLanguage}
          onChange={(e) => setPreferredLanguage(e.target.value)}
          onBlur={() => {
            if (preferredLanguage === (entry.preferredLanguage ?? '')) return;
            onSave({ preferredLanguage: preferredLanguage || null }, 'Could not save that preferred language.');
          }}
          placeholder="Not set"
          disabled={saving}
        />
      </td>
      <td>
        <input
          type="date"
          className="staff-directory-input staff-directory-input-inline"
          value={hiredAt}
          onChange={(e) => setHiredAt(e.target.value)}
          onBlur={() => {
            if (hiredAt === (entry.hiredAt ?? '')) return;
            onSave({ hiredAt: hiredAt || null }, 'Could not save that start date.');
          }}
          disabled={saving}
        />
      </td>
      <td>
        <button
          type="button"
          className={`chip${entry.isActive ? ' chip-active' : ''}`}
          disabled={saving}
          onClick={() => onSave({ isActive: !entry.isActive }, 'Could not update employment status.')}
        >
          {entry.isActive ? 'Active' : 'Inactive'}
        </button>
      </td>
      <td className="cell-num">{entry.venueName}</td>
      <td className="cell-num">{entry.roleName ?? '—'}</td>
    </tr>
  );
}
