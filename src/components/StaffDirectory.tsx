import { useEffect, useMemo, useState } from 'react';
import {
  fetchStaffDirectory,
  addStaffMember,
  updateStaffMember,
  type StaffDirectoryEntry,
} from '../api/staffDirectory';
import { ApiError } from '../api/schedules';
import { createRole, fetchRoles, removeRole, renameRole, type RoleSummary } from '../api/roles';
import { useIdentity } from '../state/IdentityContext';
import { useConnectivity } from '../state/ConnectivityContext';
import { StaleDataNotice, OfflineActionNotice } from './shiftsync/OfflineNotice';

interface StaffDirectoryProps {
  locationId: string;
  /** Fires whenever the directory changes (add/edit), so the roster grid can re-derive the Management tier. */
  onChanged?: (staff: StaffDirectoryEntry[]) => void;
}

type EditableFieldUpdates = Partial<
  Pick<StaffDirectoryEntry, 'jobTitle' | 'phone' | 'preferredLanguage' | 'hiredAt' | 'isActive' | 'roleId'>
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
  const { online } = useConnectivity();
  // Positive check (render editable only for a confirmed MANAGER/OWNER), not
  // a negative one — same rationale as router.tsx's RequireSession/
  // ShiftEditorLink: a corrupted/unexpected systemRole string must fail
  // closed into the read-only view, not fall through to editable. The
  // server already enforces this (POST/PATCH are requireManager-gated,
  // GET is requireSession-only) — this only stops STAFF from seeing
  // controls that would 403 on click, now that /people (where this
  // renders) is reachable by every session, not just managers.
  const isManager = session?.user.systemRole === 'MANAGER' || session?.user.systemRole === 'OWNER';
  const [staff, setStaff] = useState<StaffDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True when the most recent load attempt failed — distinguishes an
  // offline cold-load empty state from a genuine "no staff yet" one.
  const [loadFailed, setLoadFailed] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  // The venue's roles — seeded at signup (shared/defaultRoles.ts) and managed
  // right here: rename, remove, add. Every shift-write endpoint keys off a
  // role id, so this is what makes a brand-new venue schedulable with no
  // roster upload at all.
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({});
  const [newRoleName, setNewRoleName] = useState('');
  const [roleBusyId, setRoleBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!session) {
      setRoles([]);
      return;
    }
    let cancelled = false;
    fetchRoles(session.token)
      .then((list) => {
        if (!cancelled) setRoles(list);
      })
      .catch(() => {
        // The staff table still works; the role picker just has nothing to offer.
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  /** Local list + parent notification, computed first so no parent state is set inside an updater. */
  const replaceStaff = (next: StaffDirectoryEntry[]) => {
    setStaff(next);
    onChanged?.(next);
  };

  const handleAddRole = async () => {
    const name = newRoleName.trim();
    if (!name || !session || !online) return;
    setRoleBusyId('new');
    try {
      const created = await createRole(session.token, name);
      setRoles((prev) => [...prev.filter((r) => r.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewRoleName('');
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that role.');
    } finally {
      setRoleBusyId(null);
    }
  };

  const handleRenameRole = async (role: RoleSummary) => {
    const name = (roleDrafts[role.id] ?? role.name).trim();
    if (!session || !online || !name || name === role.name) return;
    setRoleBusyId(role.id);
    try {
      const renamed = await renameRole(session.token, role.id, name);
      setRoles((prev) => prev.map((r) => (r.id === renamed.id ? renamed : r)).sort((a, b) => a.name.localeCompare(b.name)));
      // Staff on this role show the new name straight away — they hold the id.
      replaceStaff(staff.map((s) => (s.roleId === renamed.id ? { ...s, roleName: renamed.name } : s)));
      setError(null);
    } catch (err) {
      setRoleDrafts((prev) => ({ ...prev, [role.id]: role.name }));
      setError(err instanceof ApiError ? err.message : 'Could not rename that role.');
    } finally {
      setRoleBusyId(null);
    }
  };

  const handleRemoveRole = async (role: RoleSummary) => {
    if (!session || !online) return;
    setRoleBusyId(role.id);
    try {
      await removeRole(session.token, role.id);
      setRoles((prev) => prev.filter((r) => r.id !== role.id));
      // The server unassigns everyone on the role; mirror that locally.
      replaceStaff(staff.map((s) => (s.roleId === role.id ? { ...s, roleId: null, roleName: null } : s)));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that role.');
    } finally {
      setRoleBusyId(null);
    }
  };

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
        setLoadFailed(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // `staff` itself is left untouched (Phase 2 of the offline-support
        // pass: a failed reload must not blank out data already on screen).
        setError(err instanceof ApiError ? err.message : 'Could not load the staff directory.');
        setLoadFailed(true);
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
    // Blocked outright while offline — no auto-retry; the input is disabled
    // in that state too (see the `online` prop passed to StaffRow below), so
    // this is a defensive backstop, not the primary gate.
    if (!online) return;
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
    if (!online) return;
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
            the roster grid above. The Role column is what the rota builder
            schedules against.
          </p>

          {error && (
            <div className="error-block" role="alert">
              <p>{error}</p>
            </div>
          )}

          {!online && staff.length > 0 && <StaleDataNotice />}

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
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((entry) => (
                    <StaffRow
                      key={entry.id}
                      entry={entry}
                      saving={savingId === entry.id}
                      disabled={!online}
                      isManager={isManager}
                      roles={roles}
                      onSave={(updates, errorMessage) => handleFieldSave(entry, updates, errorMessage)}
                    />
                  ))}
                  {staff.length === 0 && (
                    <tr>
                      <td colSpan={8} className="cell-num">
                        {!online && loadFailed ? "You're offline — the staff directory couldn't be loaded yet." : 'No staff yet — add one below.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {isManager && (
            <>
              <div className="staff-directory-add">
                <input
                  className="staff-directory-input"
                  placeholder="Full name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void handleAdd()}
                  disabled={!online}
                />
                <input
                  className="staff-directory-input"
                  placeholder="Job title (e.g. Restaurant Manager)"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void handleAdd()}
                  disabled={!online}
                />
                <button className="btn btn-primary" onClick={() => void handleAdd()} disabled={adding || !newName.trim() || !online}>
                  {adding ? 'Adding…' : 'Add staff member'}
                </button>
              </div>
              {!online && <OfflineActionNotice />}

              <section className="staff-directory-roles" aria-label="Roles">
                <h3 className="section-label">Roles</h3>
                <p className="hint">
                  Every venue starts with a default set so you can build a rota straight away — rename, remove or add to fit your floor.
                  Removing a role unassigns it from staff; shifts already scheduled on it keep it.
                </p>
                <ul className="staff-directory-role-list">
                  {roles.map((role) => (
                    <li key={role.id} className="staff-directory-role-row">
                      <input
                        className="staff-directory-input staff-directory-input-inline"
                        aria-label={`Role name: ${role.name}`}
                        value={roleDrafts[role.id] ?? role.name}
                        onChange={(e) => setRoleDrafts((prev) => ({ ...prev, [role.id]: e.target.value }))}
                        onBlur={() => void handleRenameRole(role)}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        disabled={roleBusyId === role.id || !online}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost"
                        aria-label={`Remove role ${role.name}`}
                        onClick={() => void handleRemoveRole(role)}
                        disabled={roleBusyId === role.id || !online}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                  {roles.length === 0 && <li className="hint">No roles yet — add one below.</li>}
                </ul>
                <div className="staff-directory-add">
                  <input
                    className="staff-directory-input"
                    placeholder="New role (e.g. Sommelier)"
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void handleAddRole()}
                    disabled={!online}
                  />
                  <button className="btn btn-primary" onClick={() => void handleAddRole()} disabled={roleBusyId === 'new' || !newRoleName.trim() || !online}>
                    {roleBusyId === 'new' ? 'Adding…' : 'Add role'}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function StaffRow({
  entry,
  saving,
  disabled,
  isManager,
  roles,
  onSave,
}: {
  entry: StaffDirectoryEntry;
  saving: boolean;
  /** True while offline — every field/toggle in this row is disabled, matching the "block outright" treatment for this write path. */
  disabled: boolean;
  /** False for a STAFF session — every field renders as plain text, matching Floor Plan's AssignmentBoard read-only treatment rather than showing editable controls that would 403 on click. */
  isManager: boolean;
  /** The venue's active roles, for the Role picker. */
  roles: RoleSummary[];
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

  if (!isManager) {
    return (
      <tr>
        <td>{entry.fullName}</td>
        <td className="cell-num">{entry.jobTitle || '—'}</td>
        <td className="cell-num">{entry.phone || '—'}</td>
        <td className="cell-num">{entry.preferredLanguage || '—'}</td>
        <td className="cell-num">{entry.hiredAt || '—'}</td>
        <td>
          <span className={`chip${entry.isActive ? ' chip-active' : ''}`}>{entry.isActive ? 'Active' : 'Inactive'}</span>
        </td>
        <td className="cell-num">{entry.venueName}</td>
        <td className="cell-num">{entry.roleName ?? '—'}</td>
      </tr>
    );
  }

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
          disabled={saving || disabled}
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
          disabled={saving || disabled}
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
          disabled={saving || disabled}
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
          disabled={saving || disabled}
        />
      </td>
      <td>
        <button
          type="button"
          className={`chip${entry.isActive ? ' chip-active' : ''}`}
          disabled={saving || disabled}
          onClick={() => onSave({ isActive: !entry.isActive }, 'Could not update employment status.')}
        >
          {entry.isActive ? 'Active' : 'Inactive'}
        </button>
      </td>
      <td className="cell-num">{entry.venueName}</td>
      <td>
        <select
          className="staff-directory-input staff-directory-input-inline"
          aria-label={`Role for ${entry.fullName}`}
          value={entry.roleId ?? ''}
          onChange={(e) => onSave({ roleId: e.target.value || null }, 'Could not update that role.')}
          disabled={saving || disabled}
        >
          <option value="">— No role —</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
          {entry.roleId && !roles.some((r) => r.id === entry.roleId) && (
            <option value={entry.roleId}>{entry.roleName ?? 'Removed role'}</option>
          )}
        </select>
      </td>
    </tr>
  );
}
