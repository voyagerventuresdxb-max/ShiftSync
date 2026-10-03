import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams, Link, Navigate } from 'react-router-dom';
import JoinFlow from '../components/JoinFlow';
import { ApiError, peekInvite } from '../api/invites';
import { isSafeReturnTo } from '../lib/postLoginDestination';

/**
 * Invite links carry the venue as `/join?invite=<token>` (see
 * server/src/lib/inviteLinks.ts): the token is checked first, so an expired,
 * revoked or used-up link shows why instead of a form. Old
 * `/join?location=<locationId>` links still render the form; the server
 * accepts them only during the venue's legacy window.
 *
 * A bare `/join` with no `?location=` used to silently fall back to the
 * pilot venue's id — that made sense when there was only ever one real
 * venue, but now that real venues exist beyond the pilot, guessing would
 * actively mislead someone from a different venue into joining the wrong
 * one. A missing `location` param today only happens via direct navigation,
 * a stale/broken link, or someone guessing the URL — a real invite link
 * always carries it — so this is an honest dead-end message rather than a
 * default, with a way out to either ask their manager or start a new venue.
 *
 * `?mode=login` is the old sign-in URL; it now redirects to `/login`,
 * carrying `returnTo` only if it is safe.
 */
export default function JoinContent() {
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get('invite')?.trim();
  const locationId = searchParams.get('location')?.trim();

  if (searchParams.get('mode') === 'login') {
    const returnTo = searchParams.get('returnTo');
    return <Navigate to={`/login${isSafeReturnTo(returnTo) ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`} replace />;
  }

  if (inviteToken) return <InviteJoin key={inviteToken} inviteToken={inviteToken} />;

  if (!locationId) {
    return (
      <DeadEnd title="This link is missing venue information">
        <p className="hint mt-2">
          Ask your manager for a fresh invite link — it carries the venue you're joining.
        </p>
      </DeadEnd>
    );
  }

  return <JoinFlow locationId={locationId} />;
}

function InviteJoin({ inviteToken }: { inviteToken: string }) {
  const [state, setState] = useState<{ venueName: string } | { error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    peekInvite(inviteToken)
      .then(({ venueName }) => !cancelled && setState({ venueName }))
      .catch((err) => !cancelled && setState({ error: err instanceof ApiError ? err.message : 'Could not check this invite link — try again.' }));
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  if (!state) {
    return (
      <section className="panel mx-auto max-w-md p-6" aria-busy="true">
        <p className="hint">Checking your invite link…</p>
      </section>
    );
  }
  if ('error' in state) {
    return (
      <DeadEnd title="This invite link can't be used">
        <div className="error-block mt-3" role="alert">
          <p>{state.error}</p>
        </div>
      </DeadEnd>
    );
  }
  return <JoinFlow inviteToken={inviteToken} venueName={state.venueName} />;
}

function DeadEnd({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel mx-auto max-w-md p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
      <p className="mt-4 text-center text-xs text-muted-foreground">
        Already have an account?{' '}
        <Link to="/login" className="underline-offset-2 hover:text-foreground hover:underline">
          Log in
        </Link>
      </p>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        Setting up a brand-new venue?{' '}
        <Link to="/signup" className="underline-offset-2 hover:text-foreground hover:underline">
          Sign up your restaurant
        </Link>
      </p>
    </section>
  );
}
