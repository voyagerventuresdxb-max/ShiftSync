import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { useIdentity } from '../state/IdentityContext';
import { peekLoginLink, redeemLoginLink, LoginLinkApiError, type LoginLinkPreview } from '../api/loginLinks';
import { extractLoginLinkToken } from '../../shared/loginLinks';

/**
 * /login/link#<token> — where a one-time login link lands.
 *
 * Two calls, deliberately separate: `peek` on load shows WHO this link signs
 * in ("Sign in as Ahmed — Il Gattopardo") and touches nothing; `redeem` runs
 * only from the Sign in tap. A link scanner, a chat app's preview fetch, or
 * a curious open therefore never spends the link. The token lives in the
 * URL fragment, so it never reaches the server in the page request itself.
 */
type State =
  | { phase: 'checking' }
  | { phase: 'ready'; token: string; preview: LoginLinkPreview }
  | { phase: 'signing-in'; token: string; preview: LoginLinkPreview }
  | { phase: 'invalid'; message: string };

const NO_TOKEN = "This page needs a login link. Open the link your manager sent you, or paste it on the login screen.";

export default function LoginLinkContent() {
  const { login } = useIdentity();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ phase: 'checking' });

  useEffect(() => {
    const token = extractLoginLinkToken(window.location.hash);
    // The token is in React state from here on; take it out of the address
    // bar and history straight away so a live link doesn't linger there if
    // the person navigates off without signing in.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setState({ phase: 'invalid', message: NO_TOKEN });
      return;
    }
    let cancelled = false;
    peekLoginLink(token)
      .then((preview) => {
        if (!cancelled) setState({ phase: 'ready', token, preview });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof LoginLinkApiError ? err.message : 'Could not check this login link. Please try again.';
        setState({ phase: 'invalid', message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignIn = async () => {
    if (state.phase !== 'ready') return;
    setState({ phase: 'signing-in', token: state.token, preview: state.preview });
    try {
      const result = await redeemLoginLink(state.token);
      login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
      navigate(result.landing, { replace: true });
    } catch (err) {
      const message = err instanceof LoginLinkApiError ? err.message : 'Could not sign you in. Please try again.';
      setState({ phase: 'invalid', message });
    }
  };

  return (
    <section className="panel mx-auto max-w-md p-6" data-testid="login-link-page">
      {state.phase === 'checking' && <p className="hint">Checking your login link…</p>}

      {(state.phase === 'ready' || state.phase === 'signing-in') && (
        <>
          <p className="eyebrow">Login link</p>
          <h2 className="mt-2 text-lg font-semibold">
            Sign in as {state.preview.fullName} — {state.preview.venueName}
          </h2>
          <p className="hint mt-1">This link works once. Nothing happens until you tap the button.</p>
          <button
            className="btn btn-primary mt-4 w-full"
            onClick={() => void handleSignIn()}
            disabled={state.phase === 'signing-in'}
            data-testid="login-link-sign-in"
          >
            <LogIn className="mr-1.5 inline h-4 w-4" /> {state.phase === 'signing-in' ? 'Signing in…' : 'Sign in'}
          </button>
        </>
      )}

      {state.phase === 'invalid' && (
        <>
          <div className="error-block" role="alert">
            <p>{state.message}</p>
          </div>
          <Link to="/join?mode=login" className="btn btn-ghost mt-4 w-full">
            Go to the login screen
          </Link>
        </>
      )}
    </section>
  );
}
