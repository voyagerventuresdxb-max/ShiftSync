import StaffDirectory from '../components/StaffDirectory';
import PendingApprovals from '../components/PendingApprovals';
import PolicyDocuments from '../components/PolicyDocuments';
import { useAppState } from '../state/AppStateContext';

export default function PeopleContent() {
  const { setStaffDirectory } = useAppState();
  return (
    <div className="space-y-5">
      <PendingApprovals locationId="seed-location" />
      <StaffDirectory locationId="seed-location" onChanged={setStaffDirectory} />
      <PolicyDocuments locationId="seed-location" />
    </div>
  );
}
