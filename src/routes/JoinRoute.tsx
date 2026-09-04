import { useSearchParams, Link } from 'react-router-dom';
import JoinFlow from '../components/JoinFlow';

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
 * `?mode=login` lands directly in JoinFlow's login mode rather than its
 * default join mode — used by the manager-dashboard sign-in gate (see
 * `RequireSession` in `router.tsx`) so a redirected, already-registered
 * manager isn't shown the "new here?" self-registration copy first. Login
 * needs no `location` at all — `identity.ts`'s login OTP flow matches phone
 * globally now, precisely because a signed-out redirect like this one has no
 * venue context to give it. Only JOIN mode (self-registering against one
 * specific venue's roster) still requires a real `location` param, so the
 * missing-param dead-end below only applies there.
 *
 * `?returnTo=` carries the path `RequireSession` (in `router.tsx`) redirected
 * from, so a successful login can send the visitor back there instead of
 * always landing on `/my-shifts`. Passed straight through to `JoinFlow`,
 * which is where it gets validated before ever being used as a navigation
 * target — this route does no validation of its own.
 */
export default function JoinContent() {
  const [searchParams] = useSearchParams();
  const locationId = searchParams.get('location')?.trim();
  const initialMode = searchParams.get('mode') === 'login' ? 'login' : undefined;
  const returnTo = searchParams.get('returnTo') ?? undefined;

  if (!locationId && initialMode !== 'login') {
    return (
      <section className="panel mx-auto max-w-md p-6">
        <h2 className="text-lg font-semibold">This link is missing venue information</h2>
        <p className="hint mt-2">
          Ask your manager for a fresh invite link — it carries the venue you're joining.
        </p>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Setting up a brand-new venue?{' '}
          <Link to="/signup" className="underline-offset-2 hover:text-foreground hover:underline">
            Sign up your restaurant
          </Link>
        </p>
      </section>
    );
  }

  return <JoinFlow locationId={locationId} initialMode={initialMode} returnTo={returnTo} />;
}
