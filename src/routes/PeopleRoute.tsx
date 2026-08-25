import StaffDirectory from '../components/StaffDirectory';
import { useAppState } from '../state/AppStateContext';

export default function PeopleContent() {
  const { setStaffDirectory } = useAppState();
  return <StaffDirectory locationId="seed-location" onChanged={setStaffDirectory} />;
}
