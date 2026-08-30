import { useSearchParams } from 'react-router-dom';
import JoinFlow from '../components/JoinFlow';

/**
 * Invite links minted by the onboarding wizard carry the venue as
 * `/join?location=<locationId>` (see server/src/routes/onboarding.ts, which
 * encodes exactly that into both the QR code and the WhatsApp text). Reading
 * it here is what makes an invite actually join the venue that issued it;
 * direct navigation to a bare `/join` keeps the seed-location default.
 *
 * `?mode=login` lands directly in JoinFlow's login mode rather than its
 * default join mode — used by the manager-dashboard sign-in gate (see
 * `RequireSession` in `router.tsx`) so a redirected, already-registered
 * manager isn't shown the "new here?" self-registration copy first.
 */
export default function JoinContent() {
  const [searchParams] = useSearchParams();
  const locationId = searchParams.get('location')?.trim() || 'seed-location';
  const initialMode = searchParams.get('mode') === 'login' ? 'login' : undefined;
  return <JoinFlow locationId={locationId} initialMode={initialMode} />;
}
