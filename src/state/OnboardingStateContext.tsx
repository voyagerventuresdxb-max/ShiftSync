import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { UploadResponse } from '../api/schedules';

/**
 * Draft, pre-commit onboarding-wizard state — deliberately a SIBLING to
 * `AppStateContext`/`useAppState()` (same architectural pattern: Context +
 * Provider + typed hook), not folded into it. Nothing here is real app data
 * until a screen actually confirms it (Venue's PATCH, Review's "Confirm &
 * Continue", Invite's mint call) — the rest of the app (Scheduling,
 * RotaBuilder, StaffDirectory) has no business depending on a manager's
 * half-finished wizard state, so it stays out of the app-wide state tree
 * those surfaces consume.
 *
 * `step` is sourced from the URL (`/onboarding/:step`), not plain React
 * state — a restaurant manager mid-onboarding on a phone is realistically
 * going to get interrupted (a call, another app, an accidental reload)
 * before finishing all 5 screens, and a hard reload previously bounced them
 * straight back to Welcome with no way back to where they were. Venue and
 * Invite already resume correctly on their own (they fetch their data fresh
 * from the server on mount); the one piece of real cross-screen state that
 * doesn't survive a reload on its own is Roster's already-parsed-but-
 * unconfirmed upload batch, so that's mirrored into `sessionStorage`
 * (scoped by locationId) here too. Review's own existing "Nothing to review
 * yet" fallback already covers the case where even that's gone (private
 * browsing, a cleared session, or the 15-minute server-side batch cache
 * having expired) — not treated as a crash, just a "go back and re-upload"
 * prompt. In-progress Review edits (a rename, a cleared flag) made before a
 * reload are NOT preserved — only the parsed data survives, not edits atop
 * it; redoing an edit is a much smaller ask than re-uploading the file.
 */
export type OnboardingStep = 'welcome' | 'venue' | 'roster' | 'review' | 'invite';

const STEPS: readonly OnboardingStep[] = ['welcome', 'venue', 'roster', 'review', 'invite'];

function isOnboardingStep(value: string | undefined): value is OnboardingStep {
  return !!value && (STEPS as readonly string[]).includes(value);
}

interface OnboardingStateValue {
  step: OnboardingStep;
  setStep: (step: OnboardingStep) => void;
  /** Roster's parsed-but-unconfirmed upload batch (batchId + preview rows), read by Review. Null when Roster was skipped, hasn't run yet, or didn't survive a reload. */
  uploadResult: UploadResponse | null;
  setUploadResult: (result: UploadResponse | null) => void;
}

const OnboardingStateCtx = createContext<OnboardingStateValue | null>(null);

function uploadResultStorageKey(locationId: string): string {
  return `shiftsync.onboarding.uploadResult.${locationId}`;
}

export function OnboardingStateProvider({ locationId, children }: { locationId: string; children: ReactNode }) {
  const navigate = useNavigate();
  const { step: stepParam } = useParams<{ step?: string }>();
  const step: OnboardingStep = isOnboardingStep(stepParam) ? stepParam : 'welcome';

  const [uploadResult, setUploadResultState] = useState<UploadResponse | null>(() => {
    try {
      const raw = sessionStorage.getItem(uploadResultStorageKey(locationId));
      return raw ? (JSON.parse(raw) as UploadResponse) : null;
    } catch {
      return null;
    }
  });

  const setStep = (next: OnboardingStep) => {
    navigate(next === 'welcome' ? '/onboarding' : `/onboarding/${next}`, { replace: true });
  };

  const setUploadResult = (result: UploadResponse | null) => {
    setUploadResultState(result);
    try {
      if (result) sessionStorage.setItem(uploadResultStorageKey(locationId), JSON.stringify(result));
      else sessionStorage.removeItem(uploadResultStorageKey(locationId));
    } catch {
      // sessionStorage unavailable (private browsing, quota) — in-memory
      // state still carries the app through the rest of THIS tab session,
      // it just won't survive a reload. Not worth surfacing as an error.
    }
  };

  const value: OnboardingStateValue = useMemo(
    () => ({ step, setStep, uploadResult, setUploadResult }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setStep/setUploadResult close over navigate/locationId, which are stable for the life of this provider
    [step, uploadResult],
  );

  return <OnboardingStateCtx.Provider value={value}>{children}</OnboardingStateCtx.Provider>;
}

export function useOnboardingState(): OnboardingStateValue {
  const ctx = useContext(OnboardingStateCtx);
  if (!ctx) throw new Error('useOnboardingState must be used within OnboardingStateProvider');
  return ctx;
}
