import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, requestJoinOtp, verifyJoinOtp } from '../api/join';
import { requestLoginOtp, verifyLoginOtp } from '../api/identity';
import { getLoginConfig, type LoginMethods } from '../api/loginLinks';
import { extractLoginLinkToken, LOGIN_LINK_PATH } from '../../shared/loginLinks';
import { useIdentity } from '../state/IdentityContext';

type Phase = 'phone' | 'otp' | 'pending' | 'error';
/**
 * Two flows share this one screen because they're the same three steps with a
 * different endpoint behind them:
 *  - 'join'  — self-registration: auto-matches an existing roster row by phone,
 *              otherwise files a JoinRequest for manual approval ('pending').
 *  - 'login' — an existing staff member coming back after their session
 *              expired or was revoked. No full name (we already know it), and
 *              no 'pending' branch — login either issues a session or errors.
 * Without the login mode the identity route had no reachable UI at all, and an
 * expired session was a dead end.
 */
type Mode = 'join' | 'login';

/**
 * `returnTo` arrives via a URL query param (`RequireSession` in `router.tsx`
 * sets it, `JoinRoute.tsx` passes it through) — that means it's untrusted,
 * attacker-craftable input: anyone can send someone a link like
 * `/join?mode=login&returnTo=https://evil.example` hoping the post-login
 * redirect carries their target somewhere off this app.
 *
 * An earlier draft tried to reject unsafe values with a blocklist (no `//`,
 * no backslash, no `://`) — a real-world review caught that this class of
 * check is fundamentally fragile: the WHATWG URL parser strips ASCII
 * tab/CR/LF from a URL before resolving it, so `/\t/evil.example` (no `//`,
 * no backslash, no `://` — passes every blocklist check as a raw string)
 * still normalizes to `//evil.example` — a protocol-relative redirect to
 * another host — the instant it's assigned to `window.location.href`.
 * Verified: `new URL('/\t/evil.example', 'https://x').host` really is
 * `'evil.example'`. A blocklist can always miss the next normalization
 * quirk; asking "what will the browser's own URL parser actually resolve
 * this to" instead can't be bypassed by a parsing quirk, because it uses
 * the exact same parser that will process the string at navigation time.
 * `https://internal.invalid` is an arbitrary fixed base with no real
 * meaning — it exists only so `new URL(path, base)` can resolve a relative
 * path the same way the browser will, without depending on `window` (this
 * stays a plain, Node-testable function). If resolving `path` against that
 * base yields a DIFFERENT origin, `path` was never a same-origin relative
 * path to begin with — no matter what tricks were used to write it.
 */
export function isSafeReturnTo(path: string | undefined | null): path is string {
  if (!path) return false;
  // Case-INSENSITIVE on purpose: react-router-dom's route matching defaults
  // to caseSensitive: false (confirmed for this app's own `/join` route in
  // router.tsx, which sets no override), so `/JOIN` really does route back
  // into this same flow. A case-sensitive check here would let `/JOIN`
  // through as "safe," and the loop this guard exists to prevent would
  // still happen — landing on the "missing venue info" dead-end instead of
  // anywhere useful, just via a differently-cased link.
  if (path.toLowerCase().startsWith('/join')) return false;
  const base = 'https://internal.invalid';
  try {
    return new URL(path, base).origin === base;
  } catch {
    return false;
  }
}

export default function JoinFlow({ locationId, initialMode, returnTo }: { locationId?: string; initialMode?: Mode; returnTo?: string }) {
  const { login } = useIdentity();
  const [mode, setMode] = useState<Mode>(initialMode ?? 'join');
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  // Which front doors exist (see server lib/loginLinks.ts LOGIN_METHODS).
  // Until the server answers, only the paste box shows: it works in every
  // mode, whereas the phone-code form would 403 in links-only mode.
  const [loginMethods, setLoginMethods] = useState<LoginMethods | null>(null);
  const [pastedLink, setPastedLink] = useState('');
  useEffect(() => {
    let cancelled = false;
    void getLoginConfig().then((config) => {
      if (!cancelled) setLoginMethods(config.loginMethods);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const otpEnabled = loginMethods === 'otp';

  /**
   * "Paste your login link": the installed home-screen app has its own
   * storage, separate from Safari's, so a link tapped in WhatsApp (which
   * opens Safari) signs in Safari only. Pasting the same link inside the
   * installed app is how it gets its own session — hence this box exists
   * on the login screen in both browser and installed contexts. It only
   * navigates; the link is spent by the Sign in tap on /login/link.
   */
  const openPastedLink = () => {
    const token = extractLoginLinkToken(pastedLink);
    if (!token) {
      setError("That doesn't look like a ShiftSync login link. Paste the whole link your manager sent you.");
      return;
    }
    setError(null);
    navigate(`${LOGIN_LINK_PATH}#${token}`);
  };

  const isLogin = mode === 'login';

  /** Switching flows restarts from the phone step — a code minted for one purpose can't be replayed against the other. */
  const switchMode = (next: Mode) => {
    setMode(next);
    setPhase('phone');
    setCode('');
    setDevCode(null);
    setError(null);
  };

  const handleRequestOtp = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // Login is global by phone — no locationId needed (see identity.ts) —
      // which is exactly what lets this screen work when reached from
      // RequireSession's redirect, which has no venue context to give it.
      // Join still needs one; JoinRoute.tsx already refuses to render this
      // component in join mode without a real location, so this is a
      // type-narrowing guard, not a real code path in practice.
      if (!isLogin && !locationId) throw new ApiError('This link is missing venue information.', 400);
      const res = isLogin ? await requestLoginOtp(phone) : await requestJoinOtp(phone);
      setDevCode(res.devCode ?? null);
      setPhase('otp');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request a code.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (isLogin) {
        // returnTo only ever makes sense here: it exists specifically to
        // send a visitor back to the page RequireSession bounced them from
        // for lacking a session, and that redirect only ever produces
        // ?mode=login. A fresh self-registration (the branch below) was
        // never "returning" from anywhere, so it always goes to /my-shifts
        // regardless of returnTo — otherwise anyone editing a shared,
        // unsigned invite link (?location=<id>, no signature over the query
        // string) could append &returnTo=/floor-plan and redirect a brand
        // new hire somewhere surprising the moment they're auto-approved.
        const destination = isSafeReturnTo(returnTo) ? returnTo : '/my-shifts';
        const result = await verifyLoginOtp(phone, code);
        login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
        window.location.href = destination;
        return;
      }
      if (!locationId) throw new ApiError('This link is missing venue information.', 400);
      const result = await verifyJoinOtp({ locationId, phone, code, fullName: fullName.trim() || undefined });
      if (result.pending) {
        setPhase('pending');
      } else {
        login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
        window.location.href = '/my-shifts';
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel mx-auto max-w-md p-6">
      <h2 className="text-lg font-semibold">{isLogin ? 'Log in to ShiftSync' : 'Join ShiftSync'}</h2>
      <p className="hint mt-1">
        {!otpEnabled
          ? 'ShiftSync signs you in with a link from your manager. Paste it below.'
          : isLogin
            ? "We'll text a code to the number your venue has on file."
            : "New here? We'll match your number against your venue's roster."}
      </p>

      {error && (
        <div className="error-block mt-3" role="alert">
          <p>{error}</p>
        </div>
      )}

      {phase === 'phone' && (
        <div className="mt-4 space-y-2" data-testid="paste-login-link">
          <label className="text-xs text-muted-foreground" htmlFor="pasted-login-link">
            {otpEnabled ? 'Have a login link? Paste it here' : 'Paste your login link'}
          </label>
          <input
            id="pasted-login-link"
            className="staff-directory-input w-full"
            placeholder="https://…/login/link#…"
            value={pastedLink}
            onChange={(e) => setPastedLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openPastedLink();
            }}
            autoComplete="off"
            inputMode="url"
          />
          <button className={`btn ${otpEnabled ? 'btn-ghost' : 'btn-primary'} w-full`} onClick={openPastedLink} disabled={!pastedLink.trim()}>
            Open login link
          </button>
          {!otpEnabled && <p className="hint">Don&apos;t have one? Ask your manager to send you a login link.</p>}
        </div>
      )}

      {phase === 'phone' && otpEnabled && (
        <div className="mt-4 space-y-3">
          <input
            className="staff-directory-input w-full"
            placeholder="Phone number"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button className="btn btn-primary w-full" onClick={() => void handleRequestOtp()} disabled={submitting || !phone.trim()}>
            {submitting ? 'Sending…' : 'Send code'}
          </button>
        </div>
      )}

      {phase === 'otp' && (
        <div className="mt-4 space-y-3">
          {devCode && (
            <p className="hint">Dev mode — your code is <span className="font-mono font-semibold">{devCode}</span> (no SMS is sent in this environment).</p>
          )}
          <input
            className="staff-directory-input w-full"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          {!isLogin && (
            <input
              className="staff-directory-input w-full"
              placeholder="Full name (if this is your first time)"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          )}
          <button className="btn btn-primary w-full" onClick={() => void handleVerify()} disabled={submitting || !code.trim()}>
            {submitting ? 'Verifying…' : isLogin ? 'Verify & log in' : 'Verify & continue'}
          </button>
        </div>
      )}

      {phase === 'pending' && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          Thanks — your request has been submitted for review. A manager will approve your account shortly.
        </div>
      )}

      {/*
       * Switching TO join mode needs a real `locationId` to join into — this
       * screen only has one when a real invite link provided it. Reached
       * with none (e.g. RequireSession's redirect for a signed-out visit,
       * which has no venue context to give), offering "Join" here would
       * lead straight into the dead end `handleRequestOtp`/`handleVerify`
       * already guard against — so the toggle only offers switching TO join
       * mode when there's actually a venue to join, and the /signup link
       * below stands in as the real next step otherwise.
       */}
      {phase !== 'pending' && otpEnabled && (isLogin ? Boolean(locationId) : true) && (
        <button
          type="button"
          className="mt-5 w-full text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          onClick={() => switchMode(isLogin ? 'join' : 'login')}
        >
          {isLogin ? "Don't have an account yet? Join" : 'Already have an account? Log in'}
        </button>
      )}

      {/*
       * This screen is for joining a venue's EXISTING roster — someone
       * looking to stand up a brand-new venue for the first time (the exact
       * confusion behind the home-base user report this was added for)
       * belongs on /signup instead, not merged into this flow. Shown
       * whenever join mode isn't actually reachable here (no locationId) —
       * not just whenever the CURRENT mode happens to be join — since a
       * locationId-less login screen has no working path to join at all.
       */}
      {phase !== 'pending' && otpEnabled && (!isLogin || !locationId) && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Setting up a brand-new venue?{' '}
          <Link to="/signup" className="underline-offset-2 hover:text-foreground hover:underline">
            Sign up your restaurant
          </Link>
        </p>
      )}
    </section>
  );
}
