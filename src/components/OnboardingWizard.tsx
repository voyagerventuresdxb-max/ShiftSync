import { useEffect, useRef, useState } from 'react';
import { motion, type Variants } from 'motion/react';
import { CheckCircle2, Coffee, Disc3, Hotel, Sparkles, Umbrella, UtensilsCrossed, Wine } from 'lucide-react';
import ShiftUpload from './ShiftUpload';
import { fetchLocation, updateLocation, VENUE_TYPES } from '../api/locations';
import { useIdentity } from '../state/IdentityContext';

/**
 * Shared spring used for every staggered entrance in the wizard (Welcome,
 * Venue's cards, Invite's payoff) — tuned short/stiff so a 2-4 item stagger
 * still settles in well under a second, matching the app's existing
 * confident-not-slow motion elsewhere (RadialDock etc).
 */
const RISE_SPRING = { type: 'spring', stiffness: 160, damping: 26 } as const;

/** Parent variants: staggers whichever children use `riseItem` below. `custom` sets the per-screen stagger gap. */
const staggerContainer: Variants = {
  hidden: {},
  visible: (staggerMs: number = 70) => ({
    transition: { staggerChildren: staggerMs / 1000 },
  }),
};

const riseItem: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: RISE_SPRING },
};

const VENUE_TYPE_OPTIONS = [
  { value: 'Fine Dining', Icon: UtensilsCrossed },
  { value: 'Bar / Lounge', Icon: Wine },
  { value: 'Nightclub', Icon: Disc3 },
  { value: 'Rooftop / Beach Club', Icon: Umbrella },
  { value: 'Hotel F&B Outlet', Icon: Hotel },
  { value: 'Café / Bakery', Icon: Coffee },
] satisfies { value: (typeof VENUE_TYPES)[number]; Icon: typeof Coffee }[];

type Step = 'welcome' | 'venue' | 'roster' | 'review' | 'invite';

interface Invite {
  inviteUrl: string;
  qrDataUrl: string;
  whatsappUrl: string;
}

export default function OnboardingWizard({ locationId }: { locationId: string }) {
  const { session } = useIdentity();
  const [step, setStep] = useState<Step>('welcome');
  /** Whether the roster step actually committed an import, or was skipped — the review copy must not claim an import that never happened. */
  const [rosterImported, setRosterImported] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loadingInvite, setLoadingInvite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [venueName, setVenueName] = useState('');
  const [venueType, setVenueType] = useState<string | null>(null);
  const [venueLoading, setVenueLoading] = useState(true);
  const [venueSaving, setVenueSaving] = useState(false);
  const [venueError, setVenueError] = useState<string | null>(null);

  /** Holds the roster→review handoff delay (see onCommitted below) so it can be cleared if the wizard unmounts mid-wait. */
  const handoffTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (handoffTimeoutRef.current) clearTimeout(handoffTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    // The venue-setup step is session-gated server-side now — with no
    // session yet there is no token to send. Resolve loading (rather than
    // leaving the spinner/disabled Continue button stuck forever) and say
    // why, instead of firing a request that can only 401.
    if (!session) {
      setVenueLoading(false);
      setVenueError('You need to be signed in to set up your venue.');
      return;
    }
    let cancelled = false;
    fetchLocation(session.token, locationId)
      .then((loc) => {
        if (cancelled) return;
        setVenueName(loc.name);
        setVenueType(loc.venueType);
      })
      .catch((err) => {
        if (cancelled) return;
        setVenueError(err instanceof Error ? err.message : 'Could not load venue details.');
      })
      .finally(() => {
        if (!cancelled) setVenueLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locationId, session]);

  const handleVenueContinue = async () => {
    const trimmedName = venueName.trim();
    if (!trimmedName) {
      setVenueError('Venue name is required.');
      return;
    }
    if (!session) {
      setVenueError('You need to be signed in to set up your venue.');
      return;
    }
    setVenueError(null);
    setVenueSaving(true);
    try {
      await updateLocation(session.token, locationId, { name: trimmedName, venueType });
      setStep('roster');
    } catch (err) {
      setVenueError(err instanceof Error ? err.message : 'Could not save venue details.');
    } finally {
      setVenueSaving(false);
    }
  };

  const loadInvite = async () => {
    setError(null);
    setLoadingInvite(true);
    try {
      const res = await fetch(`/api/onboarding/${locationId}/invite`);
      if (!res.ok) throw new Error('Could not generate the invite link.');
      const data = (await res.json()) as Invite;
      setInvite(data);
      setStep('invite');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate the invite link.');
    } finally {
      setLoadingInvite(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      {step !== 'welcome' && (
        <div className="flex gap-2">
          {(['venue', 'roster', 'review', 'invite'] as const).map((s) => (
            <span
              key={s}
              className={`rounded-full px-3 py-1 text-xs font-medium ${step === s ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              {s}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}

      {step === 'welcome' && (
        <motion.section
          className="panel p-6 text-center space-y-3"
          initial="hidden"
          animate="visible"
          custom={70}
          variants={staggerContainer}
        >
          <motion.div
            variants={riseItem}
            className="glow-gold mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-2"
          >
            <Sparkles className="h-6 w-6 text-accent" aria-hidden />
          </motion.div>
          <motion.p variants={riseItem} className="eyebrow">
            AI-Powered
          </motion.p>
          <motion.h1 variants={riseItem} className="text-2xl font-semibold text-foreground">
            Trade the spreadsheet chaos for minutes, not hours.
          </motion.h1>
          <motion.p variants={riseItem} className="hint">
            Built for how Dubai's top venues actually run.
          </motion.p>
          <motion.button variants={riseItem} className="btn btn-primary mt-4" onClick={() => setStep('venue')}>
            Continue
          </motion.button>
        </motion.section>
      )}

      {step === 'venue' && (
        <section className="panel p-5 space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-foreground">
              Every venue runs differently. Yours shouldn't have to fit a template.
            </h2>
            <p className="hint mb-0">
              Tell us about {venueName.trim() || 'your venue'} so ShiftSync fits your floor, not the other way
              around.
            </p>
          </div>

          {venueError && (
            <div className="error-block" role="alert">
              <p>{venueError}</p>
            </div>
          )}

          <div>
            <label htmlFor="venue-name" className="eyebrow mb-1 block">
              Venue name
            </label>
            <input
              id="venue-name"
              type="text"
              value={venueName}
              onChange={(e) => setVenueName(e.target.value)}
              placeholder="e.g. Il Gattopardo"
              disabled={venueLoading || venueSaving}
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-foreground outline-none focus:border-accent"
            />
          </div>

          <div>
            <p className="eyebrow mb-2">What kind of venue is this?</p>
            <motion.div
              className="grid grid-cols-2 gap-2 sm:grid-cols-3"
              initial="hidden"
              animate="visible"
              custom={60}
              variants={staggerContainer}
            >
              {VENUE_TYPE_OPTIONS.map(({ value, Icon }) => (
                <motion.button
                  key={value}
                  type="button"
                  variants={riseItem}
                  whileTap={{ scale: 0.97 }}
                  whileHover={{ scale: 1.015 }}
                  transition={RISE_SPRING}
                  onClick={() => setVenueType(value)}
                  aria-pressed={venueType === value}
                  disabled={venueLoading || venueSaving}
                  className={`flex flex-col items-center gap-2 rounded-lg border p-3 text-center text-sm transition-colors ${
                    venueType === value
                      ? 'border-accent bg-accent/10 text-foreground'
                      : 'border-border bg-surface-2 text-muted-foreground hover:border-accent/40 hover:text-foreground'
                  }`}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                  {value}
                </motion.button>
              ))}
            </motion.div>
          </div>

          <button
            className="btn btn-primary mt-2"
            onClick={() => void handleVenueContinue()}
            disabled={venueLoading || venueSaving || !venueName.trim()}
          >
            {venueSaving ? 'Saving…' : 'Continue'}
          </button>
        </section>
      )}

      {step === 'roster' && (
        <section className="panel p-5 space-y-3">
          <div>
            <h2 className="text-xl font-semibold text-foreground">Our AI reads it for you.</h2>
            <p className="hint mb-0">
              Upload what you're using now — Excel, a photo of the printed sheet, whatever it is.
            </p>
          </div>
          <ShiftUpload
            locationId={locationId}
            uploadingLabel="Reading your roster…"
            onCommitted={() => {
              setRosterImported(true);
              // Let ShiftUpload's own "done" success state actually be seen before
              // handing off to the next step — without this delay the two setStep
              // calls land in the same render and the success moment never paints.
              handoffTimeoutRef.current = setTimeout(() => setStep('review'), 900);
            }}
          />
          <button className="btn btn-ghost mt-4" onClick={() => setStep('review')}>
            Set it up as I go instead
          </button>
        </section>
      )}

      {step === 'review' && (
        <section className="panel p-5">
          <p className="hint">
            {rosterImported
              ? 'Your roster has been imported.'
              : 'You can import your roster later from the Scheduling page.'}{' '}
            When you're ready, generate an invite link for your team to join.
          </p>
          <button className="btn btn-primary mt-4" onClick={() => void loadInvite()} disabled={loadingInvite}>
            {loadingInvite ? 'Generating…' : 'Generate invite'}
          </button>
        </section>
      )}

      {step === 'invite' && invite && (
        <motion.section
          className="panel p-5 text-center space-y-3"
          initial="hidden"
          animate="visible"
          custom={100}
          variants={staggerContainer}
        >
          <motion.div
            variants={riseItem}
            className="glow-gold mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-2"
          >
            <CheckCircle2 className="h-6 w-6 text-success" aria-hidden />
          </motion.div>
          <motion.h2 variants={riseItem} className="text-xl font-semibold text-foreground">
            Your team's about to stop guessing their hours.
          </motion.h2>
          <motion.p variants={riseItem} className="hint">
            Share this link or QR code — they'll be on ShiftSync before their next shift.
          </motion.p>
          <motion.img
            variants={riseItem}
            src={invite.qrDataUrl}
            alt="Invite QR code"
            className="mx-auto h-48 w-48"
          />
          <motion.p variants={riseItem} className="mt-3 break-all text-sm text-muted-foreground">
            {invite.inviteUrl}
          </motion.p>
          <motion.a
            variants={riseItem}
            href={invite.whatsappUrl}
            target="_blank"
            rel="noreferrer"
            className="btn btn-primary mt-4 inline-flex"
          >
            Share via WhatsApp
          </motion.a>
        </motion.section>
      )}
    </div>
  );
}
