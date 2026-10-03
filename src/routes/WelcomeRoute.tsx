import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { useIdentity } from '../state/IdentityContext';
import { takeStaffWelcome } from '../lib/staffWelcome';

const AUTO_CONTINUE_MS = 3000;

/**
 * "You're in": the short screen a newly approved staff member sees once,
 * then straight to My Shifts (on its own after a moment, or on tap). Anyone
 * arriving here without a pending welcome is sent on to My Shifts at once,
 * so the URL can never dead-end. No manager wording, no setup steps.
 */
export default function WelcomeContent() {
  const { session } = useIdentity();
  const navigate = useNavigate();
  const [welcome] = useState(() => takeStaffWelcome());

  useEffect(() => {
    if (!welcome || !session) return;
    const id = setTimeout(() => navigate('/my-shifts', { replace: true }), AUTO_CONTINUE_MS);
    return () => clearTimeout(id);
  }, [welcome, session, navigate]);

  if (!session) return <Navigate to="/login?as=staff" replace />;
  if (!welcome) return <Navigate to="/my-shifts" replace />;

  return (
    <section className="panel mx-auto max-w-md p-8 text-center" data-testid="staff-welcome" aria-live="polite">
      <CheckCircle2 className="mx-auto h-12 w-12 text-accent" aria-hidden />
      <p className="eyebrow mt-4">Staff</p>
      <h2 className="mt-1 text-2xl font-semibold tracking-tight">You're in</h2>
      <p className="hint mt-2">
        Welcome to {welcome.venueName ?? 'the team'}, {session.user.fullName.split(' ')[0]}. Your shifts live in My Shifts; your manager posts
        the week there.
      </p>
      <button type="button" className="btn btn-primary mt-6 w-full" onClick={() => navigate('/my-shifts', { replace: true })}>
        See my shifts
      </button>
      <p className="mt-3 text-xs text-muted-foreground">Taking you there in a moment…</p>
    </section>
  );
}
