import { useEffect, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { fetchPendingJoinRequests, decideJoinRequest, ApiError, type JoinLinkCandidate, type JoinRequestDto } from '../api/join';
import { useIdentity } from '../state/IdentityContext';
import { useConnectivity } from '../state/ConnectivityContext';
import { StaleDataNotice, OfflineEmptyState, OfflineActionNotice } from './shiftsync/OfflineNotice';
import { useSingleFlight } from '../hooks/useLiveRefresh';

function PendingApprovalRowSkeleton() {
  return (
    <li className="flex items-center justify-between gap-3 p-4" aria-hidden>
      <div className="min-w-0 flex-1">
        <div className="h-4 w-28 animate-pulse rounded bg-muted" />
        <div className="mt-1.5 h-3 w-20 animate-pulse rounded bg-muted" />
      </div>
      <div className="flex shrink-0 gap-2">
        <div className="h-7 w-20 animate-pulse rounded-lg bg-muted" />
        <div className="h-7 w-20 animate-pulse rounded-lg bg-muted" />
      </div>
    </li>
  );
}

const formatDeclinedOn = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** The roster-imported staff records this request could be, when approving involves them. */
function linkCandidates(r: JoinRequestDto): JoinLinkCandidate[] {
  if (r.link?.kind === 'link') return [r.link.candidate];
  if (r.link?.kind === 'choose') return r.link.candidates;
  return [];
}

/** One answer to "who is this?": a 44px-tall row, the whole row being the radio's target. */
function LinkOption({ name, value, checked, onChange, title, detail }: { name: string; value: string; checked: boolean; onChange: (value: string) => void; title: string; detail: string }) {
  return (
    <label
      className={cn(
        'relative flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2 transition-colors',
        checked ? 'border-accent/70 bg-accent/10' : 'border-border hover:border-border-strong',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      <span
        aria-hidden
        className={cn('pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', checked ? 'border-accent' : 'border-foreground/30')}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      <span className="pointer-events-none min-w-0">
        <span className="block text-sm text-foreground/90">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
}

/**
 * Pending Approvals — the review queue for JoinRequest rows raised by the
 * phone/OTP join flow (src/api/join.ts) when no existing User auto-matches.
 * Styled after ApprovalsPanel.tsx's collapsible pending/decided pattern,
 * but simpler: a JoinRequestDto has no decided state of its own — once
 * approved/declined it disappears from the pending list entirely, so
 * there's nothing to render in a "decided" section.
 *
 * Reloads whenever `refreshKey` changes (People bumps it on window focus);
 * a decision calls `onDecided` so People refreshes this list and the Staff
 * Directory together.
 */
export default function PendingApprovals({ locationId, refreshKey, onDecided }: { locationId: string; refreshKey: number; onDecided: () => void }) {
  const { session } = useIdentity();
  const { online } = useConnectivity();
  const [requests, setRequests] = useState<JoinRequestDto[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True when the most recent load attempt failed — distinguishes an
  // offline cold-load empty state from a genuine "nothing pending" one.
  // Reset on every successful load, unlike `error` below wasn't previously.
  const [loadFailed, setLoadFailed] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  // "Who is this?" per request: an imported staff record's id, or 'new'.
  const [linkChoice, setLinkChoice] = useState<Record<string, string>>({});
  // True until the first load (success or failure) settles, then false
  // forever after — `load()` is also called to silently refresh the list
  // (focus, or after a decide), and that in-flight refresh must not
  // re-trigger the skeleton (setLoading(false) when already false is a no-op).
  const [loading, setLoading] = useState(true);

  const load = useSingleFlight(async () => {
    // No session (or a staff session) means this can only ever 401/403 — the
    // route is manager-only now. Skip the request rather than firing one that
    // can't succeed; the list simply stays empty, same as the "nothing
    // pending" state below.
    if (!session) {
      setLoading(false);
      return;
    }
    try {
      const list = await fetchPendingJoinRequests(session.token, locationId);
      setRequests(list);
      setError(null);
      setLoadFailed(false);
    } catch (err) {
      // The list itself is left untouched (Phase 2 of the offline-support
      // pass: a failed refresh must not blank out data already on screen).
      setError(err instanceof ApiError ? err.message : 'Could not load pending approvals.');
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  });

  useEffect(() => {
    load();
  }, [load, locationId, session, refreshKey]);

  // The one imported record an exact full-name match will claim is shown chosen; a request that
  // could be more than one person (or only partly matches) has nothing chosen until the manager picks.
  const chosenFor = (r: JoinRequestDto): string | undefined => linkChoice[r.id] ?? (r.link?.kind === 'link' ? r.link.candidate.userId : undefined);

  const handleDecide = async (r: JoinRequestDto, decision: 'approve' | 'decline') => {
    const id = r.id;
    if (!session) return;
    // Blocked outright while offline — no auto-retry; the manager clicks
    // again once back online (buttons re-enable automatically).
    if (!online) return;
    const linkTo = decision === 'approve' && linkCandidates(r).length ? chosenFor(r) : undefined;
    setDecidingId(id);
    try {
      await decideJoinRequest(session.token, id, decision, linkTo ? { linkTo } : undefined);
      onDecided();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not process that request.');
      // The staff list changed since this loaded (someone else was imported or linked): show the current choices.
      if (err instanceof ApiError && (err.errorCode === 'link_choice_required' || err.errorCode === 'link_target_invalid')) {
        setLinkChoice((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        load();
      }
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <section className="panel animate-rise overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-surface-raised/40"
      >
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Needs review</p>
          <h2 className="text-base font-semibold tracking-tight">Pending Approvals</h2>
        </div>
        {requests.length > 0 && (
          <span className="rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] font-medium text-warning">
            {requests.length}
          </span>
        )}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          {error && (
            <div className="error-block mx-4 mb-2" role="alert">
              <p>{error}</p>
            </div>
          )}
          {!online && requests.length > 0 && <StaleDataNotice />}

          {loading ? (
            <ul className="divide-y divide-border" aria-busy="true" aria-label="Loading pending approvals">
              <PendingApprovalRowSkeleton />
              <PendingApprovalRowSkeleton />
            </ul>
          ) : requests.length === 0 ? (
            !online && loadFailed ? (
              <OfflineEmptyState message="You're offline — pending approvals couldn't be loaded yet." />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">No join requests waiting for review.</p>
            )
          ) : (
            <ul className="divide-y divide-border">
              {requests.map((r) => {
                const candidates = linkCandidates(r);
                const chosen = chosenFor(r);
                const needsChoice = candidates.length > 0 && !chosen;
                const actions = (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => void handleDecide(r, 'approve')}
                      disabled={decidingId === r.id || !online || needsChoice}
                      aria-describedby={needsChoice ? `link-hint-${r.id}` : undefined}
                      className="hit-44 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Check className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button
                      onClick={() => void handleDecide(r, 'decline')}
                      disabled={decidingId === r.id || !online}
                      className="hit-44 inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <X className="h-3.5 w-3.5" /> Decline
                    </button>
                  </div>
                );
                return (
                  <li key={r.id} className="p-4" data-testid="join-request">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{r.fullName}</p>
                        <p className="text-xs text-muted-foreground">{r.phone}</p>
                        {r.previousDeclines > 0 && (
                          <p className="mt-0.5 text-xs text-warning">
                            Previously declined {r.previousDeclines}×{r.lastDeclinedAt && ` (last on ${formatDeclinedOn(r.lastDeclinedAt)})`}
                          </p>
                        )}
                      </div>
                      {candidates.length === 0 && actions}
                    </div>
                    {candidates.length > 0 && (
                      <>
                        <fieldset className="mt-3 flex flex-col gap-2" data-testid="join-link-choice">
                          <legend className="mb-2 text-xs text-muted-foreground">
                            {r.link?.kind === 'link'
                              ? 'Same full name as someone imported from your roster. Approving links them to that record and its shifts.'
                              : 'This could be someone imported from your roster. Who is it?'}
                          </legend>
                          {candidates.map((c) => (
                            <LinkOption
                              key={c.userId}
                              name={`link-${r.id}`}
                              value={c.userId}
                              checked={chosen === c.userId}
                              onChange={(v) => setLinkChoice((prev) => ({ ...prev, [r.id]: v }))}
                              title={`Link to ${c.fullName} (imported from the roster)`}
                              detail={[c.match === 'exact' ? 'Same full name' : 'Similar name', c.roleName].filter(Boolean).join(' · ')}
                            />
                          ))}
                          <LinkOption
                            name={`link-${r.id}`}
                            value="new"
                            checked={chosen === 'new'}
                            onChange={(v) => setLinkChoice((prev) => ({ ...prev, [r.id]: v }))}
                            title="New person"
                            detail="Add them as a new staff member"
                          />
                        </fieldset>
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <p id={`link-hint-${r.id}`} className="min-w-0 text-xs text-muted-foreground">
                            {needsChoice ? 'Choose who this is to approve.' : ''}
                          </p>
                          {actions}
                        </div>
                      </>
                    )}
                    {!online && <OfflineActionNotice />}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
