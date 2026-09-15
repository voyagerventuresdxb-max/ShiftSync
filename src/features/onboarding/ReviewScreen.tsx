import { useEffect, useMemo, useRef, useState } from 'react';
import { confirmRoster, ApiError, type RosterRowEdit } from '../../api/schedules';
import { fetchRoles } from '../../api/roles';
import { useIdentity } from '../../state/IdentityContext';
import { useOnboardingState } from '../../state/OnboardingStateContext';
import OnboardingScreenShell from './OnboardingScreenShell';
import { groupByPerson, shouldAdvanceAfterConfirm } from './reviewGrouping';

/**
 * Onboarding · 04 · Review — ported from `ShiftSync Review.dc.html`.
 *
 * Structural deviation from the prototype, dictated by the real data model:
 * the prototype's mock is one row per PERSON with a pre-baked shift summary
 * ("Tue–Sat · PM"). The real parser (`api/schedules.ts`'s `PreviewRow`)
 * returns one row per (person, single shift/date) — a busy week produces
 * several preview rows for the same person. This screen groups those by
 * `employeeName` into one person-row each (matching the spec's "one row per
 * person"), computes a read-only shift summary from the grouped dates, and
 * threads any Name/Role edit across every underlying row number when
 * building the confirm payload.
 *
 * The prototype's role-chip row uses manual pointer-drag-scroll handling
 * with click-vs-drag suppression — a workaround for its own canvas-sandbox
 * renderer, not something a real browser needs. This uses native
 * `overflow-x: auto`, which already scrolls correctly by touch/trackpad/
 * click-drag in any real browser.
 */

const CANONICAL_ROLES = ['Head Waiter', 'Waiter', 'Commis Waiter', 'Host', 'Server', 'Bartender', 'Head Bartender', 'Supervisor', 'Manager'];

/**
 * In-progress edit state (renames, role picks, cleared flags, removed rows,
 * session-typed custom roles) — mirrored into `sessionStorage` the same way
 * `OnboardingStateContext` mirrors Roster's `uploadResult`, but kept local
 * to this screen rather than in that shared context: nothing outside
 * ReviewScreen ever reads or writes it, so it doesn't belong in state meant
 * for genuinely cross-screen data. Scoped by BOTH locationId and batchId
 * (not just locationId) — a manager who goes back to Roster and uploads a
 * DIFFERENT file gets a new batchId, and must not have the previous batch's
 * edits (which are keyed by rowNumber, a number that can coincidentally
 * repeat across unrelated batches) silently bleed into the new one.
 */
interface PersistedReviewEdits {
  nameEdits: [string, string][];
  roleEdits: [string, string][];
  clearedFlags: string[];
  removed: string[];
  sessionCustomRoles: string[];
}

function reviewEditsStorageKey(locationId: string, batchId: string): string {
  return `shiftsync.onboarding.reviewEdits.${locationId}.${batchId}`;
}

function loadPersistedReviewEdits(locationId: string, batchId: string): PersistedReviewEdits | null {
  try {
    const raw = sessionStorage.getItem(reviewEditsStorageKey(locationId, batchId));
    return raw ? (JSON.parse(raw) as PersistedReviewEdits) : null;
  } catch {
    return null;
  }
}

function chipStyle(on: boolean, dashed = false) {
  return {
    padding: '7px 10px',
    borderRadius: 999,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    border: `1px ${dashed && !on ? 'dashed' : 'solid'} ${on ? 'rgba(201,166,107,.75)' : 'rgba(239,234,224,.10)'}`,
    background: on ? 'rgba(201,166,107,.10)' : 'rgba(239,234,224,.02)',
    color: on ? 'var(--ob-champagne)' : 'var(--ob-stone)',
    font: "500 10.5px/1 'Manrope'",
    transition: 'all .22s var(--ob-ease-out)',
  } as const;
}

export default function ReviewScreen({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  const { session } = useIdentity();
  const { uploadResult } = useOnboardingState();

  const baseRows = useMemo(() => (uploadResult ? groupByPerson(uploadResult.preview) : []), [uploadResult]);

  // Only the first render's value of this ever actually matters — each
  // useState below passes a LAZY initializer, which React invokes exactly
  // once (on mount), so recomputing this plain const on later renders is
  // harmless (cheap synchronous sessionStorage read) and never re-applied.
  const persistedEdits =
    session && uploadResult ? loadPersistedReviewEdits(session.user.locationId, uploadResult.batchId) : null;

  const [nameEdits, setNameEdits] = useState<Map<string, string>>(() => new Map(persistedEdits?.nameEdits ?? []));
  const [roleEdits, setRoleEdits] = useState<Map<string, string>>(() => new Map(persistedEdits?.roleEdits ?? []));
  const [clearedFlags, setClearedFlags] = useState<Set<string>>(() => new Set(persistedEdits?.clearedFlags ?? []));
  const [removed, setRemoved] = useState<Set<string>>(() => new Set(persistedEdits?.removed ?? []));
  const [openId, setOpenId] = useState<string | null>(null);
  const [customOpenId, setCustomOpenId] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState('');
  const [sessionCustomRoles, setSessionCustomRoles] = useState<string[]>(() => persistedEdits?.sessionCustomRoles ?? []);
  const [venueRoles, setVenueRoles] = useState<string[]>([]);
  const [filterFlagged, setFilterFlagged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set only when confirmRoster reports skippedCount > 0 — an unresolved
  // role means that shift's `resolvedRoleId` never resolved server-side
  // (schedules.ts:484's `if (trimmed)` no-ops on an empty edited role, e.g.
  // clicking "Looks right" on a row flagged for a name mismatch whose role
  // was already blank), so persistShifts silently skipped creating it. When
  // this is set, `onContinue()` is deliberately NOT called from
  // handleConfirm — see the dedicated render block below, which blocks
  // auto-advancing to Invite until the manager has actually seen the count
  // and explicitly continues, instead of silently proceeding as if every
  // row imported (the exact bug this fixes).
  const [confirmResult, setConfirmResult] = useState<{ createdCount: number; skippedCount: number } | null>(null);

  // Mirror every edit into sessionStorage as it happens — a reload mid-Review
  // restores these via the lazy initializers above, same mechanism
  // OnboardingStateContext already uses for Roster's uploadResult.
  useEffect(() => {
    if (!session || !uploadResult) return;
    try {
      const payload: PersistedReviewEdits = {
        nameEdits: [...nameEdits],
        roleEdits: [...roleEdits],
        clearedFlags: [...clearedFlags],
        removed: [...removed],
        sessionCustomRoles,
      };
      sessionStorage.setItem(reviewEditsStorageKey(session.user.locationId, uploadResult.batchId), JSON.stringify(payload));
    } catch {
      // sessionStorage unavailable (private browsing, quota) — in-memory
      // state still carries the rest of THIS tab session; it just won't
      // survive a reload. Not worth surfacing as an error.
    }
  }, [session, uploadResult, nameEdits, roleEdits, clearedFlags, removed, sessionCustomRoles]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchRoles(session.token)
      .then((roles) => {
        if (cancelled) return;
        setVenueRoles(roles.map((r) => r.name).filter((n) => !CANONICAL_ROLES.includes(n)));
      })
      .catch(() => {
        // Best-effort only — the 9 canonical chips still work without this; a
        // venue's previously-added custom roles just won't pre-populate.
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const roleOptions = useMemo(() => {
    const extra = [...venueRoles, ...sessionCustomRoles].filter((r) => !CANONICAL_ROLES.includes(r));
    return [...CANONICAL_ROLES, ...new Set(extra)];
  }, [venueRoles, sessionCustomRoles]);

  const rows = baseRows
    .filter((r) => !removed.has(r.id))
    .map((r) => ({
      ...r,
      name: nameEdits.get(r.id) ?? r.originalName,
      role: roleEdits.get(r.id) ?? r.originalRole,
      flagged: r.parserFlagged && !clearedFlags.has(r.id),
    }));

  const flaggedCount = rows.filter((r) => r.flagged).length;
  const sorted = [...rows].sort((a, b) => (b.flagged ? 1 : 0) - (a.flagged ? 1 : 0));
  const visible = filterFlagged ? sorted.filter((r) => r.flagged) : sorted;
  const ready = flaggedCount === 0 && rows.length > 0;

  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const toggleRow = (id: string) => {
    setCustomOpenId(null);
    setOpenId((cur) => {
      const next = cur === id ? null : id;
      if (next) {
        // Scroll the currently-assigned role chip into view, matching the
        // prototype's `centerRole` — native scrollIntoView instead of its
        // manual scrollLeft math.
        requestAnimationFrame(() => {
          rowRefs.current.get(id)?.querySelector('[data-role-chip-active="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
        });
      }
      return next;
    });
  };

  const commitCustomRole = (id: string) => {
    const value = customDraft.trim();
    setCustomOpenId(null);
    setCustomDraft('');
    if (!value) return;
    setRoleEdits((prev) => new Map(prev).set(id, value));
    setSessionCustomRoles((prev) => (prev.includes(value) ? prev : [...prev, value]));
    requestAnimationFrame(() => {
      const el = rowRefs.current.get(id);
      if (el) el.scrollLeft = el.scrollWidth;
    });
  };

  const handleConfirm = async () => {
    if (!ready || confirming || !uploadResult) return;
    if (!session) {
      setError('You need to be signed in to confirm this roster.');
      return;
    }
    setError(null);
    setConfirming(true);
    try {
      const edits: RosterRowEdit[] = baseRows
        .filter((r) => !removed.has(r.id))
        .flatMap((r) => {
          const patch: { employeeName?: string; role?: string } = {};
          // Presence in the map (not a value-vs-original diff) is what
          // decides inclusion: a row whose parsed role string happens to
          // already match a canonical chip label (e.g. "Bartender") renders
          // as already-selected, so a manager confirming it via "Looks
          // right" has no reason to re-click an already-highlighted chip —
          // but that role never actually resolved server-side (that's WHY
          // the row was flagged `unmatched_role` to begin with). A value
          // diff against `originalRole`/`originalName` would silently skip
          // sending it, leaving `resolvedRoleId` null and the row dropped at
          // confirm with no signal to the manager that nothing imported.
          // "Looks right"/"Done" (below) commits the row's current name+role
          // into these maps whether or not the manager changed them, so
          // presence alone means "the manager explicitly signed off on this
          // row's current values — resolve/create them for real."
          if (nameEdits.has(r.id)) patch.employeeName = nameEdits.get(r.id);
          if (roleEdits.has(r.id)) patch.role = roleEdits.get(r.id);
          if (patch.employeeName === undefined && patch.role === undefined) return [];
          return r.rowNumbers.map((rowNumber) => ({ rowNumber, ...patch }));
        });
      const removedRowNumbers = baseRows.filter((r) => removed.has(r.id)).flatMap((r) => r.rowNumbers);

      const result = await confirmRoster(session.token, uploadResult.batchId, session.user.id, edits, removedRowNumbers);
      if (shouldAdvanceAfterConfirm(result)) {
        onContinue();
      } else {
        setConfirmResult(result);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not confirm this roster.');
    } finally {
      setConfirming(false);
    }
  };

  if (!uploadResult) {
    return (
      <OnboardingScreenShell stepIndex={3} eyebrow="Step 4 of 5 · Review" title="Nothing to review yet." onBack={onBack} footer={null}>
        <div style={{ font: "400 14px/1.55 'Manrope'", color: 'var(--ob-stone)' }}>
          Go back to Roster and upload a file or photo first.
        </div>
      </OnboardingScreenShell>
    );
  }

  if (confirmResult) {
    return (
      <OnboardingScreenShell
        stepIndex={3}
        eyebrow="Step 4 of 5 · Review"
        title="Some shifts couldn't be imported."
        onBack={onBack}
        footer={
          <button
            onClick={onContinue}
            style={{
              width: '100%',
              padding: '16px 20px',
              borderRadius: 14,
              background: 'var(--ob-bone)',
              color: '#100D0A',
              font: "600 14px/1 'Manrope'",
              letterSpacing: '.005em',
              transition: 'all .52s var(--ob-ease-out)',
              cursor: 'pointer',
            }}
          >
            Continue to Invite
          </button>
        }
      >
        <div style={{ font: "400 14px/1.55 'Manrope'", color: 'var(--ob-stone)' }}>
          <strong style={{ color: 'var(--ob-bone)' }}>{confirmResult.createdCount}</strong> shift{confirmResult.createdCount === 1 ? '' : 's'} imported.{' '}
          <strong style={{ color: 'var(--ob-champagne)' }}>{confirmResult.skippedCount}</strong> shift{confirmResult.skippedCount === 1 ? '' : 's'} could not be
          imported because a role couldn&apos;t be resolved for {confirmResult.skippedCount === 1 ? 'it' : 'them'}. You can add {confirmResult.skippedCount === 1 ? 'it' : 'these'}{' '}
          manually later from Scheduling.
        </div>
      </OnboardingScreenShell>
    );
  }

  return (
    <OnboardingScreenShell
      stepIndex={3}
      eyebrow="Step 4 of 5 · Review"
      title="Here's what we found."
      onBack={onBack}
      footer={
        <>
          {error && <div style={{ color: '#e5484d', font: "400 13px/1.5 'Manrope'", marginBottom: 14 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '0 4px 14px' }}>
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="#8B7550" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
              <rect x={3} y={6} width={8} height={6} rx={1.2} />
              <path d="M4.8 6V4.6a2.2 2.2 0 0 1 4.4 0V6" />
            </svg>
            <div style={{ font: "400 12px/1.5 'Manrope'", color: 'var(--ob-bronze)' }}>Nothing&apos;s live until you say so. Your team won&apos;t see any of this yet.</div>
          </div>
          <button
            onClick={() => void handleConfirm()}
            disabled={!ready || confirming}
            style={{
              width: '100%',
              padding: '16px 20px',
              borderRadius: 14,
              background: ready && !confirming ? 'var(--ob-bone)' : 'rgba(239,234,224,.10)',
              color: ready && !confirming ? '#100D0A' : 'var(--ob-dim-2)',
              font: "600 14px/1 'Manrope'",
              letterSpacing: '.005em',
              transition: 'all .52s var(--ob-ease-out)',
              cursor: ready && !confirming ? 'pointer' : 'default',
            }}
          >
            {confirming ? 'Confirming…' : ready ? 'Confirm & Continue' : `Review ${flaggedCount} flagged first`}
          </button>
          <div style={{ textAlign: 'center', marginTop: 14, font: "500 10px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-dim-2)' }}>
            Next · Invite
          </div>
        </>
      }
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: -8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, font: "500 12px/1 'Manrope'", color: 'var(--ob-stone)' }}>
          <span>
            <span style={{ color: 'var(--ob-bone)' }}>{rows.length}</span> staff found
          </span>
          <span style={{ width: 3, height: 3, borderRadius: 2, background: 'var(--ob-dim-2)' }} />
          <span style={{ color: flaggedCount === 0 ? 'var(--ob-stone)' : 'var(--ob-champagne)', transition: 'color .22s var(--ob-ease-out)' }}>
            {flaggedCount === 0 ? 'all confirmed' : `${flaggedCount} need${flaggedCount === 1 ? 's' : ''} your review`}
          </span>
        </div>
        <button
          onClick={() => {
            if (flaggedCount > 0 || filterFlagged) setFilterFlagged((v) => !v);
          }}
          style={{
            padding: 8,
            font: "500 10px/1 'Manrope'",
            letterSpacing: '.24em',
            textTransform: 'uppercase',
            color: filterFlagged ? 'var(--ob-champagne)' : 'var(--ob-bronze)',
            opacity: flaggedCount === 0 && !filterFlagged ? 0.35 : 1,
            background: 'transparent',
            border: 0,
            transition: 'all .22s var(--ob-ease-out)',
          }}
        >
          {filterFlagged ? 'Show all' : 'Flagged only'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', maxHeight: 420 }}>
        {visible.map((r) => {
          const open = openId === r.id;
          // A role not already covered by a real chip in roleOptions (not just
          // "not one of the 9 canonical ones") — otherwise, once a just-typed
          // custom term joins roleOptions (see setSessionCustomRoles above),
          // this trailing slot would keep masquerading as that same role
          // instead of collapsing back to "+ Custom", duplicating the chip.
          const isCustomActive = !roleOptions.includes(r.role);
          const customOpen = customOpenId === r.id;
          return (
            <div
              key={r.id}
              style={{
                borderRadius: 14,
                border: `1px solid ${r.flagged ? 'rgba(201,166,107,.32)' : open ? 'rgba(239,234,224,.14)' : 'rgba(239,234,224,.07)'}`,
                background: r.flagged ? 'rgba(201,166,107,.045)' : 'rgba(239,234,224,.02)',
                transition: 'all .22s var(--ob-ease-out)',
              }}
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggleRow(r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') toggleRow(r.id);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer' }}
              >
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    border: `1px solid ${r.flagged ? 'rgba(201,166,107,.6)' : 'rgba(239,234,224,.12)'}`,
                    color: r.flagged ? 'var(--ob-champagne)' : 'var(--ob-stone)',
                    background: r.flagged ? 'rgba(201,166,107,.12)' : 'transparent',
                  }}
                >
                  {r.flagged ? (
                    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 2.2v4.6" />
                      <circle cx={6} cy={9.4} r={0.5} fill="currentColor" />
                    </svg>
                  ) : (
                    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.5 6.2l2.3 2.3 4.7-5" />
                    </svg>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ob-serif" style={{ fontSize: 16, lineHeight: 1.15, color: 'var(--ob-bone)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.name}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, font: "500 10.5px/1 'Manrope'", letterSpacing: '.02em', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    <span style={{ color: 'var(--ob-stone)', flexShrink: 0 }}>{r.role || '—'}</span>
                    <span style={{ width: 3, height: 3, borderRadius: 2, background: 'var(--ob-dim-2)', flexShrink: 0 }} />
                    <span style={{ color: r.flagged ? 'var(--ob-champagne)' : 'var(--ob-bronze)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.shiftSummary}</span>
                  </div>
                </div>
                <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="#55514A" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform .32s var(--ob-ease-out)' }}>
                  <path d="M3 4.5l3 3 3-3" />
                </svg>
              </div>

              {open && (
                <div style={{ padding: '0 14px 12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {r.parserFlagged && r.note && (
                    <div style={{ font: "400 11px/1.5 'Manrope'", color: 'var(--ob-champagne)', padding: '8px 10px', borderRadius: 9, background: 'rgba(201,166,107,.07)', border: '1px solid rgba(201,166,107,.18)' }}>
                      {r.note}
                    </div>
                  )}

                  <div>
                    <div style={{ font: "500 9px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-dim-2)', marginTop: 2 }}>Name</div>
                    <input
                      value={r.name}
                      onChange={(e) => setNameEdits((prev) => new Map(prev).set(r.id, e.target.value))}
                      autoComplete="off"
                      spellCheck={false}
                      style={{
                        font: "400 17px/1.2 'Instrument Serif'",
                        color: 'var(--ob-bone)',
                        padding: '6px 0 6px',
                        borderBottom: '1px solid rgba(201,166,107,.35)',
                        width: '100%',
                        background: 'transparent',
                        border: 0,
                        borderBottomWidth: 1,
                        borderBottomStyle: 'solid',
                        borderBottomColor: 'rgba(201,166,107,.35)',
                        outline: 'none',
                      }}
                    />
                  </div>

                  <div>
                    <div style={{ font: "500 9px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-dim-2)', marginBottom: 7 }}>Role</div>
                    <div
                      ref={(el) => {
                        if (el) rowRefs.current.set(r.id, el);
                      }}
                      style={{ display: 'flex', gap: 6, flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden', padding: '0 0 2px', scrollbarWidth: 'none' }}
                    >
                      {roleOptions.map((label) => (
                        <button
                          key={label}
                          data-role-chip-active={r.role === label ? 'true' : undefined}
                          onClick={() => {
                            setCustomOpenId(null);
                            setRoleEdits((prev) => new Map(prev).set(r.id, label));
                          }}
                          style={chipStyle(r.role === label)}
                        >
                          {label}
                        </button>
                      ))}
                      <button
                        data-role-chip-active={isCustomActive && !customOpen ? 'true' : undefined}
                        onClick={() => {
                          setCustomOpenId(r.id);
                          setCustomDraft(isCustomActive ? r.role : '');
                        }}
                        style={chipStyle(isCustomActive || customOpen, !isCustomActive && !customOpen)}
                      >
                        {isCustomActive && !customOpen ? r.role : '+ Custom'}
                      </button>
                      <span style={{ flex: '0 0 8px' }} />
                    </div>
                    {customOpen && (
                      <div style={{ marginTop: 8 }}>
                        <input
                          value={customDraft}
                          onChange={(e) => setCustomDraft(e.target.value)}
                          onBlur={() => commitCustomRole(r.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            }
                            if (e.key === 'Escape') {
                              setCustomOpenId(null);
                              setCustomDraft('');
                            }
                          }}
                          placeholder="Your venue's term, e.g. Captain Waiter"
                          autoFocus
                          autoComplete="off"
                          spellCheck={false}
                          style={{
                            font: "500 12px/1.2 'Manrope'",
                            color: 'var(--ob-bone)',
                            padding: '7px 0 6px',
                            width: '100%',
                            background: 'transparent',
                            border: 0,
                            borderBottom: '1px solid rgba(201,166,107,.55)',
                            outline: 'none',
                          }}
                        />
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <button
                      onClick={() => {
                        setRemoved((prev) => new Set(prev).add(r.id));
                        setOpenId(null);
                      }}
                      style={{ font: "500 10.5px/1 'Manrope'", letterSpacing: '.04em', color: 'var(--ob-dim-2)', padding: '6px 0', background: 'transparent', border: 0 }}
                    >
                      Remove
                    </button>
                    <button
                      onClick={() => {
                        // Lock in the row's CURRENT name+role as explicit
                        // edits regardless of whether they differ from the
                        // original parse — see the long comment in
                        // handleConfirm for why presence-in-map (not a value
                        // diff) is what actually gets a flagged role
                        // re-resolved/created server-side.
                        setNameEdits((prev) => new Map(prev).set(r.id, r.name));
                        setRoleEdits((prev) => new Map(prev).set(r.id, r.role));
                        setClearedFlags((prev) => new Set(prev).add(r.id));
                        setOpenId(null);
                      }}
                      style={{
                        padding: '9px 14px',
                        borderRadius: 9,
                        border: '1px solid rgba(201,166,107,.6)',
                        color: 'var(--ob-champagne)',
                        font: "500 11px/1 'Manrope'",
                        letterSpacing: '.04em',
                        background: 'rgba(201,166,107,.08)',
                      }}
                    >
                      {r.flagged ? 'Looks right' : 'Done'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </OnboardingScreenShell>
  );
}
