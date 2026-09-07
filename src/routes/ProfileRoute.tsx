import { useIdentity } from '../state/IdentityContext';
import { NotificationSettings } from '../components/shiftsync/NotificationSettings';

export default function ProfileContent() {
  const { session, logout } = useIdentity();

  if (!session) {
    return <p className="panel p-5 text-sm text-muted-foreground">Sign in via Join to see your profile.</p>;
  }

  return (
    <div className="space-y-5">
      <section className="panel p-5">
        <p className="eyebrow">Account</p>
        <h2 className="text-lg font-semibold">{session.user.fullName}</h2>
        {session.user.jobTitle && <p className="text-sm text-muted-foreground">{session.user.jobTitle}</p>}
        <button className="btn btn-ghost mt-4" onClick={logout}>
          Sign out
        </button>
      </section>

      <NotificationSettings />
    </div>
  );
}
