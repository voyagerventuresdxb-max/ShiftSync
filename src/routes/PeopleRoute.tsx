import { AppShell } from '../components/shiftsync/AppShell';
import StaffDirectory from '../components/StaffDirectory';
import { useAppState } from '../state/AppStateContext';

export default function PeopleRoute() {
  const { setStaffDirectory } = useAppState();
  return (
    <AppShell title="People">
      <StaffDirectory locationId="seed-location" onChanged={setStaffDirectory} />
    </AppShell>
  );
}
