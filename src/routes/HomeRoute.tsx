import { PredictiveBanner } from '../components/shiftsync/PredictiveBanner';
import { Announcements } from '../components/shiftsync/Announcements';
import { Shoutouts } from '../components/shiftsync/Shoutouts';
import { ApprovalsPanel, type ApprovalRequestView } from '../components/shiftsync/ApprovalsPanel';
import { SafetyValve } from '../components/shiftsync/SafetyValve';
import { weekdayOf } from '../engine/rosterView';
import { useAppState } from '../state/AppStateContext';

function formatDayMonth(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function HomeContent() {
  const { mergedRoster, swapRequests, handleDecideRequest } = useAppState();

  const employeeName = (id: string) => mergedRoster.employees.find((e) => e.id === id)?.name ?? 'Unknown';

  const approvalRequests: ApprovalRequestView[] = swapRequests
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => {
      const shift = mergedRoster.shifts.find((s) => s.id === r.shiftId);
      const shiftLabel = shift
        ? `${weekdayOf(shift.date)} ${formatDayMonth(shift.date)} · ${shift.start}–${shift.end}`
        : 'Shift no longer in roster';
      return {
        id: r.id,
        status: r.status,
        requesterName: employeeName(r.requestedBy),
        coveringName: employeeName(r.coveringEmployeeId),
        shiftLabel,
        requestedAt: r.createdAt,
        expiresAt: r.expiresAt,
        locked: r.locked,
        auditNote: r.auditNote,
      };
    });

  return (
    <div className="space-y-5">
      <PredictiveBanner />
      <Announcements />
      <Shoutouts />
      <ApprovalsPanel
        requests={approvalRequests}
        onApprove={(id) => void handleDecideRequest(id, 'approved')}
        onDeny={(id) => void handleDecideRequest(id, 'denied')}
      />
      <SafetyValve />
    </div>
  );
}
