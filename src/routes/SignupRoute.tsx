import SignupFlow from '../components/SignupFlow';

/**
 * No search params to read here (unlike `JoinRoute`, which resolves an
 * invite's `?location=` and `?mode=login`) — signup always starts a brand-new
 * venue from scratch, so there's nothing to thread through. Kept as its own
 * route-level component anyway to match this codebase's route/component
 * split.
 */
export default function SignupContent() {
  return <SignupFlow />;
}
