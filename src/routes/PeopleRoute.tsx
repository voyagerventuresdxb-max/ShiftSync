import StaffDirectory from '../components/StaffDirectory';
import PendingApprovals from '../components/PendingApprovals';
import { useAppState } from '../state/AppStateContext';

// Note: PolicyDocuments (Task 10) mounts here too — leaving this as a
// simple vertical stack so it can be added below StaffDirectory without
// restructuring this component.
export default function PeopleContent() {
  const { setStaffDirectory } = useAppState();
  return (
    <div className="space-y-5">
      <PendingApprovals locationId="seed-location" />
      <StaffDirectory locationId="seed-location" onChanged={setStaffDirectory} />
    </div>
  );
}
