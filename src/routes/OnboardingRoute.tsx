import { useNavigate } from 'react-router-dom';
import WelcomeScreen from '../features/onboarding/WelcomeScreen';
import VenueScreen from '../features/onboarding/VenueScreen';
import RosterScreen from '../features/onboarding/RosterScreen';
import ReviewScreen from '../features/onboarding/ReviewScreen';
import InviteScreen from '../features/onboarding/InviteScreen';
import { OnboardingStateProvider, useOnboardingState } from '../state/OnboardingStateContext';
import { useIdentity } from '../state/IdentityContext';

/**
 * `RequireSession` (see router.tsx) already guarantees a session exists by
 * the time this renders — the `if (!session)` below is purely a TypeScript
 * narrowing guard, not a reachable code path in practice.
 */
export default function OnboardingContent() {
  const { session } = useIdentity();
  if (!session) return null;
  return (
    <OnboardingStateProvider locationId={session.user.locationId}>
      <OnboardingFlow locationId={session.user.locationId} />
    </OnboardingStateProvider>
  );
}

/** All 5 screens ported (see src/features/onboarding) — Roster's Skip goes straight to Invite (per product spec — nothing to review when nothing was uploaded), bypassing Review entirely. */
function OnboardingFlow({ locationId }: { locationId: string }) {
  const { step, setStep } = useOnboardingState();
  const navigate = useNavigate();

  if (step === 'welcome') {
    return <WelcomeScreen onContinue={() => setStep('venue')} />;
  }
  if (step === 'venue') {
    return <VenueScreen locationId={locationId} onBack={() => setStep('welcome')} onContinue={() => setStep('roster')} />;
  }
  if (step === 'roster') {
    return (
      <RosterScreen
        onBack={() => setStep('venue')}
        onContinue={() => setStep('review')}
        onSkip={() => setStep('invite')}
      />
    );
  }
  if (step === 'review') {
    return <ReviewScreen onBack={() => setStep('roster')} onContinue={() => setStep('invite')} />;
  }
  return <InviteScreen locationId={locationId} onBack={() => setStep('review')} onFinish={() => navigate('/')} />;
}
