import { useSearchParams } from 'react-router-dom';
import JoinFlow from '../components/JoinFlow';

/**
 * Invite links minted by the onboarding wizard carry the venue as
 * `/join?location=<locationId>` (see server/src/routes/onboarding.ts, which
 * encodes exactly that into both the QR code and the WhatsApp text). Reading
 * it here is what makes an invite actually join the venue that issued it;
 * direct navigation to a bare `/join` keeps the seed-location default.
 */
export default function JoinContent() {
  const [searchParams] = useSearchParams();
  const locationId = searchParams.get('location')?.trim() || 'seed-location';
  return <JoinFlow locationId={locationId} />;
}
