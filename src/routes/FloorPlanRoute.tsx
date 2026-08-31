import FloorPlanTab from '../components/FloorPlan/FloorPlanTab';
import { useIdentity } from '../state/IdentityContext';

/**
 * `RequireSession` (see router.tsx) already guarantees a session exists by
 * the time this renders — the `if (!session)` below is purely a TypeScript
 * narrowing guard, not a reachable code path in practice. Same pattern as
 * OnboardingRoute.tsx.
 */
export default function FloorPlanContent() {
  const { session } = useIdentity();
  if (!session) return null;
  return <FloorPlanTab locationId={session.user.locationId} />;
}
