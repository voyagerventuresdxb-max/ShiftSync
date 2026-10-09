import { useState } from 'react';
import { confirmRoster, ApiError, type ConfirmResponse, type ConfirmRosterRequest } from '../../api/schedules';
import { useIdentity } from '../../state/IdentityContext';
import { useOnboardingState } from '../../state/OnboardingStateContext';
import { RosterReview } from '../rosterReview/RosterReview';
import { ImportResult } from '../rosterReview/ImportResult';
import OnboardingScreenShell from './OnboardingScreenShell';

/**
 * Onboarding · 04 · Review — the shared roster review (src/features/rosterReview, also used
 * by the Scheduling page import) inside the wizard's frame and palette.
 *
 * One card per PERSON on the roster (the server groups rows into people), each with the
 * readers' flags in plain words and the manager's decision: same person / new person, listed
 * twice, which time, role (one person or in bulk), don't import. Confirm creates or links a
 * real staff member for everyone imported — so the Invite step lists them — and writes their
 * shifts. In-progress decisions survive a reload (sessionStorage, keyed by venue + batch).
 *
 * After a successful confirm the parsed upload is cleared from onboarding state: the batch is
 * spent on the server, and going Back must not offer to confirm it again.
 */

const continueButtonStyle = {
  width: '100%',
  padding: '16px 20px',
  borderRadius: 14,
  background: 'var(--ob-bone)',
  color: 'var(--ink-cta)',
  font: "600 14px/1 'Manrope'",
  letterSpacing: '.005em',
  transition: 'background-color var(--ob-t), color var(--ob-t)',
  cursor: 'pointer',
} as const;

export default function ReviewScreen({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const { session } = useIdentity();
  const { uploadResult, setUploadResult } = useOnboardingState();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmResponse | null>(null);

  const handleConfirm = async (request: ConfirmRosterRequest) => {
    if (confirming || !uploadResult) return;
    if (!session) {
      setError('You need to be signed in to confirm this roster.');
      return;
    }
    setError(null);
    setConfirming(true);
    try {
      const res = await confirmRoster(session.token, uploadResult.batchId, { ...request, createdById: session.user.id });
      setResult(res);
      setUploadResult(null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'This preview expired. Go back to Roster and upload the file again — nothing was saved.'
          : err instanceof Error
            ? err.message
            : 'Could not confirm this roster.',
      );
    } finally {
      setConfirming(false);
    }
  };

  if (result) {
    return (
      <OnboardingScreenShell
        stepIndex={3}
        eyebrow="Step 4 of 5 · Review"
        title="Your team is in."
        onBack={onBack}
        footer={
          <button onClick={onContinue} style={continueButtonStyle}>
            Continue to Invite
          </button>
        }
      >
        <div className="rr-onboarding">
          <ImportResult result={result} title={null} actions={null} />
        </div>
      </OnboardingScreenShell>
    );
  }

  if (!uploadResult) {
    return (
      <OnboardingScreenShell stepIndex={3} eyebrow="Step 4 of 5 · Review" title="Nothing to review yet." onBack={onBack} footer={null}>
        <div style={{ font: "400 14px/1.55 'Manrope'", color: 'var(--ob-stone)' }}>Go back to Roster and upload a file or photo first.</div>
      </OnboardingScreenShell>
    );
  }

  return (
    <OnboardingScreenShell stepIndex={3} eyebrow="Step 4 of 5 · Review" title="Here's what we found." onBack={onBack} footer={null}>
      <div className="rr-onboarding">
        <RosterReview
          key={uploadResult.batchId}
          upload={uploadResult}
          variant="onboarding"
          confirming={confirming}
          error={error}
          createdById={session?.user.id ?? null}
          persistKey={session ? `shiftsync.onboarding.review.${session.user.locationId}.${uploadResult.batchId}` : undefined}
          onConfirm={(request) => void handleConfirm(request)}
        />
      </div>
    </OnboardingScreenShell>
  );
}
