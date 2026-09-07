import StaffDirectory from '../components/StaffDirectory';
import PendingApprovals from '../components/PendingApprovals';
import PolicyDocuments from '../components/PolicyDocuments';
import FloorFeedbackReview from '../components/shiftsync/FloorFeedbackReview';
import { NotificationSettings } from '../components/shiftsync/NotificationSettings';
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
  // Positive check (same rationale as StaffDirectory.tsx/router.tsx) — People
  // is now reachable by every session, not just managers, so the
  // manager-only review panels below (join requests, anonymous feedback
  // moderation) must be hidden outright for STAFF, not merely left to 403
  // on their own API calls.
  const isManager = session.user.systemRole === 'MANAGER' || session.user.systemRole === 'OWNER';
  return (
    <div className="space-y-5">
      {isManager && (
        <>
          <PendingApprovals locationId={locationId} />
          <FloorFeedbackReview />
        </>
      )}
      <StaffDirectory locationId={locationId} onChanged={setStaffDirectory} />
      <PolicyDocuments locationId={locationId} isManager={isManager} />
      <NotificationSettings />
    </div>
  );
}
