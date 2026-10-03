import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { onSessionRejected } from '@/api/http';
import { useIdentity } from '@/state/IdentityContext';

/** `/login?reason=` value the guard sends; LoginRoute turns it into a plain message. */
export const SESSION_ENDED_REASON = 'session-ended';

/**
 * App-wide answer to a dead session (#20): the moment any authenticated
 * request comes back 401 (`apiFetch`), clear the stored session and send the
 * person to `/login` with a plain explanation. Rendered once, inside the
 * router (it needs `useNavigate`), by AppShell.
 *
 * `/login` and `/join` themselves are not a `returnTo` target, and a page the
 * person was on comes along so a successful re-login lands them back there.
 */
export function SessionGuard() {
  const { session, logout } = useIdentity();
  const navigate = useNavigate();
  const location = useLocation();
  const hasSession = session !== null;

  useEffect(() => {
    return onSessionRejected(() => {
      // Already signed out (e.g. the sign-out revoke itself answered 401): nothing to do.
      if (!hasSession) return;
      logout();
      const here = `${location.pathname}${location.search}${location.hash}`;
      const params = new URLSearchParams({ reason: SESSION_ENDED_REASON });
      if (!/^\/(login|join)(\/|$|\?)/i.test(location.pathname)) params.set('returnTo', here);
      navigate(`/login?${params.toString()}`, { replace: true });
    });
  }, [hasSession, logout, navigate, location]);

  return null;
}
