import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import WelcomeScreen from '../features/onboarding/WelcomeScreen';
import AccountScreen from '../features/onboarding/AccountScreen';
import VenueScreen from '../features/onboarding/VenueScreen';
import RosterScreen from '../features/onboarding/RosterScreen';
import ReviewScreen from '../features/onboarding/ReviewScreen';
import InviteScreen from '../features/onboarding/InviteScreen';
import { OnboardingStateProvider, stepRequiresSession, useOnboardingState } from '../state/OnboardingStateContext';
import { useIdentity } from '../state/IdentityContext';

/**
 * Onboarding is deliberately NOT behind `RequireSession` in router.tsx any
 * more (2026-09-16): account creation is now the wizard's own first step
 * (see `AccountScreen`), so the Welcome intro and that step must render for
 * a visitor with no session at all — gating the route would make the only
 * way to GET a first session unreachable. The equivalent protection lives
 * here instead, per step: anything from Venue onward still requires a
 * session (`stepRequiresSession`), and a real STAFF session is still sent
 * to `/my-shifts` exactly as `RequireSession managerOnly` did — onboarding
 * has no legitimate STAFF use.
 */
export default function OnboardingContent() {
  const { session } = useIdentity();
  if (session && session.user.systemRole !== 'MANAGER' && session.user.systemRole !== 'OWNER') {
    return <Navigate to="/my-shifts" replace />;
  }
  const locationId = session?.user.locationId ?? null;
  return (
    <OnboardingStateProvider locationId={locationId}>
      <OnboardingFlow locationId={locationId} />
    </OnboardingStateProvider>
  );
}

/** All screens (see src/features/onboarding) — Roster's Skip goes straight to Invite (per product spec — nothing to review when nothing was uploaded), bypassing Review entirely. */
function OnboardingFlow({ locationId }: { locationId: string | null }) {
  const { step, setStep } = useOnboardingState();
  const navigate = useNavigate();
  const location = useLocation();

  // Already signed in (a returning manager opening Onboarding from /people,
  // or a reload right after the account step succeeded) — there's no
  // account to create, so Account hands straight over to Venue.
  const skipAccount = step === 'account' && locationId !== null;
  useEffect(() => {
    if (skipAccount) setStep('venue');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setStep is recreated per render; only the condition matters
  }, [skipAccount]);

  if (stepRequiresSession(step) && !locationId) {
    // Same shape as router.tsx's RequireSession redirect, so login lands
    // back on the step that was requested.
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}${location.hash}`);
    return <Navigate to={`/join?mode=login&returnTo=${returnTo}`} replace />;
  }

  if (step === 'welcome') {
    return <WelcomeScreen onContinue={() => setStep(locationId ? 'venue' : 'account')} />;
  }
  if (step === 'account' || !locationId) {
    if (skipAccount) return null;
    return <AccountScreen onBack={() => setStep('welcome')} onContinue={() => setStep('venue')} />;
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
