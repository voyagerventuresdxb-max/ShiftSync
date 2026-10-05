import { useCallback, useState } from 'react';
import StaffDirectory from '../components/StaffDirectory';
import PendingApprovals from '../components/PendingApprovals';
import InviteLinkPanel from '../components/InviteLinkPanel';
import KioskLinkPanel from '../components/KioskLinkPanel';
import PolicyDocuments from '../components/PolicyDocuments';
import FloorFeedbackReview from '../components/shiftsync/FloorFeedbackReview';
import { NotificationSettings } from '../components/shiftsync/NotificationSettings';
import { useAppState } from '../state/AppStateContext';
import { useIdentity } from '../state/IdentityContext';
import { useRefreshOnFocus } from '../hooks/useLiveRefresh';

/**
 * `RequireSession` (see router.tsx) already guarantees a session exists by
 * the time this renders — the `if (!session)` below is purely a TypeScript
 * narrowing guard, not a reachable code path in practice. Same pattern as
 * OnboardingRoute.tsx/FloorPlanRoute.tsx.
 */
export default function PeopleContent() {
  const { setStaffDirectory } = useAppState();
  const { session } = useIdentity();
  // Bumped on window focus and after a join decision; each panel below reloads in place when it changes.
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  useRefreshOnFocus(refresh);
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
          <PendingApprovals locationId={locationId} refreshKey={refreshKey} onDecided={refresh} />
          <InviteLinkPanel locationId={locationId} refreshKey={refreshKey} />
          <KioskLinkPanel locationId={locationId} />
          <FloorFeedbackReview />
        </>
      )}
      <StaffDirectory locationId={locationId} onChanged={setStaffDirectory} refreshKey={refreshKey} />
      <PolicyDocuments locationId={locationId} isManager={isManager} />
      <NotificationSettings />
    </div>
  );
}
