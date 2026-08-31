import OnboardingWizard from '../components/OnboardingWizard';
import { useIdentity } from '../state/IdentityContext';

/**
 * `RequireSession` (see router.tsx) already guarantees a session exists by
 * the time this renders — the `if (!session)` below is purely a TypeScript
 * narrowing guard, not a reachable code path in practice.
 */
export default function OnboardingContent() {
  const { session } = useIdentity();
  if (!session) return null;
  return <OnboardingWizard locationId={session.user.locationId} />;
}
