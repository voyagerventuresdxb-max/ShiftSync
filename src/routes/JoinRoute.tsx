import { useSearchParams, Link, Navigate } from 'react-router-dom';
import JoinFlow from '../components/JoinFlow';
import { isSafeReturnTo } from '../lib/postLoginDestination';

/**
 * Invite links minted by the onboarding wizard carry the venue as
 * `/join?location=<locationId>` (see server/src/routes/onboarding.ts, which
 * encodes exactly that into both the QR code and the WhatsApp text). Reading
 * it here is what makes an invite actually join the venue that issued it.
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
  const locationId = searchParams.get('location')?.trim();

  if (searchParams.get('mode') === 'login') {
    const returnTo = searchParams.get('returnTo');
    return <Navigate to={`/login${isSafeReturnTo(returnTo) ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`} replace />;
  }

  if (!locationId) {
    return (
      <section className="panel mx-auto max-w-md p-6">
        <h2 className="text-lg font-semibold">This link is missing venue information</h2>
        <p className="hint mt-2">
          Ask your manager for a fresh invite link — it carries the venue you're joining.
        </p>
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

  return <JoinFlow locationId={locationId} />;
}
