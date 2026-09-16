import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOnboardingStep, furthestUnlockedStep, resolveEffectiveStep, stepRequiresSession, stepPath, type OnboardingStep } from './OnboardingStateContext';

test('isOnboardingStep accepts only the six known step names', () => {
  assert.equal(isOnboardingStep('welcome'), true);
  assert.equal(isOnboardingStep('account'), true);
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

// Account creation is the wizard's own first step (2026-09-16) and the only
// one that must work with no session at all; everything from Venue onward
// touches a real Location and needs one.
test('stepRequiresSession is false only for the pre-session steps (welcome, account)', () => {
  assert.equal(stepRequiresSession('welcome'), false);
  assert.equal(stepRequiresSession('account'), false);
  for (const step of ['venue', 'roster', 'review', 'invite'] as const) {
    assert.equal(stepRequiresSession(step), true, `${step} must require a session`);
  }
});

test('resolveEffectiveStep places account between welcome and venue in wizard order', () => {
  const preSession = new Set<OnboardingStep>(['welcome', 'account']);
  assert.equal(furthestUnlockedStep(preSession), 'account');
  assert.equal(resolveEffectiveStep('venue', preSession), 'account', 'a typed /onboarding/venue with no account yet lands on Account, not past it');
  assert.equal(resolveEffectiveStep('welcome', preSession), 'welcome', 'the intro stays revisitable');
});

test('stepPath maps welcome to the bare /onboarding and every other step to /onboarding/:step', () => {
  assert.equal(stepPath('welcome'), '/onboarding');
  assert.equal(stepPath('account'), '/onboarding/account');
  assert.equal(stepPath('invite'), '/onboarding/invite');
});
