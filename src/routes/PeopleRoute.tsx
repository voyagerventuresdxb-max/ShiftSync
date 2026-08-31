import StaffDirectory from '../components/StaffDirectory';
import PendingApprovals from '../components/PendingApprovals';
import PolicyDocuments from '../components/PolicyDocuments';
import { useAppState } from '../state/AppStateContext';
import { useIdentity } from '../state/IdentityContext';

/**
 * `RequireSession` (see router.tsx) already guarantees a session exists by
 * the time this renders — the `if (!session)` below is purely a TypeScript
 * narrowing guard, not a reachable code path in practice. Same pattern as
 * OnboardingRoute.tsx/FloorPlanRoute.tsx.
 */
export default function PeopleContent() {
  const { setStaffDirectory } = useAppState();
  const { session } = useIdentity();
  if (!session) return null;
  const locationId = session.user.locationId;
  return (
    <div className="space-y-5">
      <PendingApprovals locationId={locationId} />
      <StaffDirectory locationId={locationId} onChanged={setStaffDirectory} />
      <PolicyDocuments locationId={locationId} />
    </div>
  );
}
