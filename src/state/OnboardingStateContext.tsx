import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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
 * before finishing all the screens, and a hard reload previously bounced
 * them straight back to Welcome with no way back to where they were. Venue
 * and Invite already resume correctly on their own (they fetch their data
 * fresh from the server on mount); the one piece of real cross-screen state
 * that doesn't survive a reload on its own is Roster's already-parsed-but-
 * unconfirmed upload batch, so that's mirrored into `sessionStorage`
 * (scoped by locationId) here too. Review's own existing "Nothing to review
 * yet" fallback already covers the case where even that's gone (private
 * browsing, a cleared session, or the 15-minute server-side batch cache
 * having expired) — not treated as a crash, just a "go back and re-upload"
 * prompt. In-progress Review edits (a rename, a cleared flag) made before a
 * reload are NOT preserved — only the parsed data survives, not edits atop
 * it; redoing an edit is a much smaller ask than re-uploading the file.
 *
 * `account` (2026-09-16, onboarding QA round 1): account creation — phone →
 * OTP + owner name + venue name, the former standalone `/signup` screen —
 * is now the wizard's first real step, sitting between the Welcome intro
 * and Venue. It's the only step that runs WITHOUT a session (it's how the
 * session gets minted); everything from Venue onward still requires one.
 * `welcome` and `account` are therefore always unlocked pre-session (there's
 * nothing to gate before an account exists), and `locationId` is `null`
 * until the account step succeeds.
 */
export type OnboardingStep = 'welcome' | 'account' | 'venue' | 'roster' | 'review' | 'invite';

const STEPS: readonly OnboardingStep[] = ['welcome', 'account', 'venue', 'roster', 'review', 'invite'];

/** Steps reachable with no session at all — the intro and account creation itself. */
const PRE_SESSION_STEPS: ReadonlySet<OnboardingStep> = new Set<OnboardingStep>(['welcome', 'account']);

export function isOnboardingStep(value: string | undefined): value is OnboardingStep {
  return !!value && (STEPS as readonly string[]).includes(value);
}

/** True for every step from Venue onward — the ones that read/write a real Location and so need a session. */
export function stepRequiresSession(step: OnboardingStep): boolean {
  return !PRE_SESSION_STEPS.has(step);
}

/**
 * Issue #14 (PR #11 follow-up review): `step` used to come from the URL with
 * no gating at all — a manager could reach Invite via a stale bookmark or a
 * typed URL without Venue/Roster ever having run. `unlockedSteps` is the set
 * of steps a REAL `setStep` call (i.e. an onContinue/onBack/onSkip a screen
 * actually fired) has ever reached this session; a step reachable only by
 * editing the URL isn't in it. `resolveEffectiveStep` is what enforces that:
 * the requested (URL) step is honored only when unlocked, otherwise the
 * furthest step the manager has legitimately reached is used instead. This
 * is additive to (not a replacement for) the 2026-09-08 step-in-URL
 * reload/resume decision above — a reload still resumes exactly where the
 * manager left off, since the step they were on is always itself unlocked.
 */
export function furthestUnlockedStep(unlocked: ReadonlySet<OnboardingStep>): OnboardingStep {
  let furthest: OnboardingStep = 'welcome';
  for (const candidate of STEPS) {
    if (unlocked.has(candidate)) furthest = candidate;
  }
  return furthest;
}

export function resolveEffectiveStep(requestedStep: OnboardingStep, unlocked: ReadonlySet<OnboardingStep>): OnboardingStep {
  return unlocked.has(requestedStep) ? requestedStep : furthestUnlockedStep(unlocked);
}

export function stepPath(step: OnboardingStep): string {
  return step === 'welcome' ? '/onboarding' : `/onboarding/${step}`;
}

/** What the manager picked on Roster — enough for that screen to re-render its "file attached" state after a Back or a reload. */
export interface UploadedFileMeta {
  name: string;
  size: number;
  viaPhoto: boolean;
}

interface OnboardingStateValue {
  step: OnboardingStep;
  setStep: (step: OnboardingStep) => void;
  /** Roster's parsed-but-unconfirmed upload batch (batchId + preview rows), read by Review. Null when Roster was skipped, hasn't run yet, or didn't survive a reload. */
  uploadResult: UploadResponse | null;
  /** The file behind `uploadResult`; null whenever `uploadResult` is null. */
  uploadFile: UploadedFileMeta | null;
  setUploadResult: (result: UploadResponse | null, file?: UploadedFileMeta) => void;
}

const OnboardingStateCtx = createContext<OnboardingStateValue | null>(null);

function uploadResultStorageKey(locationId: string): string {
  return `shiftsync.onboarding.uploadResult.${locationId}`;
}

function uploadFileStorageKey(locationId: string): string {
  return `shiftsync.onboarding.uploadFile.${locationId}`;
}

function unlockedStepsStorageKey(locationId: string): string {
  return `shiftsync.onboarding.unlockedSteps.${locationId}`;
}

function persistUnlockedSteps(locationId: string | null, unlocked: ReadonlySet<OnboardingStep>): void {
  // Pre-session there's nothing worth persisting: the only reachable steps
  // are always unlocked anyway (see `loadUnlockedSteps`), and writing to a
  // shared anonymous key would let a post-login step leak into the next
  // signed-out visitor's set in the same tab.
  if (!locationId) return;
  try {
    sessionStorage.setItem(unlockedStepsStorageKey(locationId), JSON.stringify([...unlocked]));
  } catch {
    // sessionStorage unavailable — the step still unlocks for the rest of this tab's in-memory session, it just won't survive a reload.
  }
}

function loadUnlockedSteps(locationId: string | null): Set<OnboardingStep> {
  if (!locationId) return new Set(PRE_SESSION_STEPS);
  try {
    const raw = sessionStorage.getItem(unlockedStepsStorageKey(locationId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      const valid = parsed.filter((value): value is OnboardingStep => isOnboardingStep(value));
      if (valid.length > 0) return new Set([...PRE_SESSION_STEPS, ...valid]);
    }
  } catch {
    // fall through to the fresh-session default below
  }
  return new Set(PRE_SESSION_STEPS);
}

export function OnboardingStateProvider({ locationId, children }: { locationId: string | null; children: ReactNode }) {
  const navigate = useNavigate();
  const { step: stepParam } = useParams<{ step?: string }>();
  const requestedStep: OnboardingStep = isOnboardingStep(stepParam) ? stepParam : 'welcome';

  const [unlockedSteps, setUnlockedSteps] = useState<Set<OnboardingStep>>(() => loadUnlockedSteps(locationId));
  const step = resolveEffectiveStep(requestedStep, unlockedSteps);

  // The requested (URL) step was gated back to `step` — replace the URL so
  // the address bar reflects what's actually rendered, instead of leaving it
  // pointed at a step the manager never reached.
  useEffect(() => {
    if (requestedStep === step) return;
    navigate(stepPath(step), { replace: true });
  }, [requestedStep, step, navigate]);

  // Persist on every change, keyed by the CURRENT locationId. The account
  // step minting a session flips `locationId` from null to the new venue's
  // id in the same render batch as its `setStep('venue')`, so the first
  // persisted set for a brand-new venue already contains Venue — a reload
  // right after account creation resumes there instead of on the intro.
  useEffect(() => {
    persistUnlockedSteps(locationId, unlockedSteps);
  }, [locationId, unlockedSteps]);

  const [uploadResult, setUploadResultState] = useState<UploadResponse | null>(() => {
    if (!locationId) return null;
    try {
      const raw = sessionStorage.getItem(uploadResultStorageKey(locationId));
      return raw ? (JSON.parse(raw) as UploadResponse) : null;
    } catch {
      return null;
    }
  });

  const [uploadFile, setUploadFileState] = useState<UploadedFileMeta | null>(() => {
    if (!locationId) return null;
    try {
      const raw = sessionStorage.getItem(uploadFileStorageKey(locationId));
      return raw ? (JSON.parse(raw) as UploadedFileMeta) : null;
    } catch {
      return null;
    }
  });

  const setStep = (next: OnboardingStep) => {
    setUnlockedSteps((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    navigate(stepPath(next), { replace: true });
  };

  const setUploadResult = (result: UploadResponse | null, file?: UploadedFileMeta) => {
    const fileMeta = result ? (file ?? null) : null;
    setUploadResultState(result);
    setUploadFileState(fileMeta);
    if (!locationId) return;
    try {
      if (result) sessionStorage.setItem(uploadResultStorageKey(locationId), JSON.stringify(result));
      else sessionStorage.removeItem(uploadResultStorageKey(locationId));
      if (fileMeta) sessionStorage.setItem(uploadFileStorageKey(locationId), JSON.stringify(fileMeta));
      else sessionStorage.removeItem(uploadFileStorageKey(locationId));
    } catch {
      // sessionStorage unavailable (private browsing, quota) — in-memory
      // state still carries the app through the rest of THIS tab session,
      // it just won't survive a reload. Not worth surfacing as an error.
    }
  };

  const value: OnboardingStateValue = useMemo(
    () => ({ step, setStep, uploadResult, uploadFile, setUploadResult }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setStep/setUploadResult close over navigate (stable) and locationId (listed)
    [step, uploadResult, uploadFile, locationId],
  );

  return <OnboardingStateCtx.Provider value={value}>{children}</OnboardingStateCtx.Provider>;
}

export function useOnboardingState(): OnboardingStateValue {
  const ctx = useContext(OnboardingStateCtx);
  if (!ctx) throw new Error('useOnboardingState must be used within OnboardingStateProvider');
  return ctx;
}
