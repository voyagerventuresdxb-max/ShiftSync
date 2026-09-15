import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOnboardingStep, furthestUnlockedStep, resolveEffectiveStep, type OnboardingStep } from './OnboardingStateContext';

test('isOnboardingStep accepts only the five known step names', () => {
  assert.equal(isOnboardingStep('welcome'), true);
  assert.equal(isOnboardingStep('invite'), true);
  assert.equal(isOnboardingStep('bogus'), false);
  assert.equal(isOnboardingStep(undefined), false);
});

test('furthestUnlockedStep returns "welcome" when nothing else has been unlocked', () => {
  assert.equal(furthestUnlockedStep(new Set<OnboardingStep>(['welcome'])), 'welcome');
});

test('furthestUnlockedStep returns the step furthest along the wizard order, not insertion order', () => {
  // Inserted out of wizard order — the function must still return 'roster' (STEPS order), not 'venue' (insertion order).
  const unlocked = new Set<OnboardingStep>(['roster', 'welcome', 'venue']);
  assert.equal(furthestUnlockedStep(unlocked), 'roster');
});

// Issue #14 (PR #11 follow-up review): a manager reaching Invite via a stale
// bookmark or typed URL, without Venue/Roster ever having run, must be
// gated back — not allowed straight through.
test('resolveEffectiveStep gates a URL request for an unreached step back to the furthest step actually completed', () => {
  const freshSession = new Set<OnboardingStep>(['welcome']);
  assert.equal(
    resolveEffectiveStep('invite', freshSession),
    'welcome',
    'a stale bookmark/typed URL to Invite must not be honored before Venue/Roster ever ran',
  );
});

test('resolveEffectiveStep honors a URL request for a step the manager has already legitimately reached', () => {
  const unlocked = new Set<OnboardingStep>(['welcome', 'venue', 'roster']);
  assert.equal(resolveEffectiveStep('venue', unlocked), 'venue', 'revisiting an already-unlocked step (e.g. browser back) must work');
  assert.equal(resolveEffectiveStep('roster', unlocked), 'roster');
});

// RosterScreen's "Skip" goes straight Roster -> Invite, deliberately
// bypassing Review (see OnboardingRoute.tsx) — gating must not break that
// legitimate shortcut by requiring Review specifically.
test('resolveEffectiveStep honors Invite when reached via the Roster "Skip" shortcut, even though Review was never unlocked', () => {
  const unlockedViaSkip = new Set<OnboardingStep>(['welcome', 'venue', 'roster', 'invite']);
  assert.equal(resolveEffectiveStep('invite', unlockedViaSkip), 'invite');
});

test('resolveEffectiveStep gates a URL request for Review back to Invite when Review was skipped', () => {
  const unlockedViaSkip = new Set<OnboardingStep>(['welcome', 'venue', 'roster', 'invite']);
  assert.equal(resolveEffectiveStep('review', unlockedViaSkip), 'invite');
});
