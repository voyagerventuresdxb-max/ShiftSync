import { useEffect, useMemo, useState } from 'react';
import { mintInvite, type MintedInvite } from '../../api/onboarding';
import { fetchLocation } from '../../api/locations';
import { fetchStaffDirectory, updateStaffMember, type StaffDirectoryEntry } from '../../api/staffDirectory';
import { useIdentity } from '../../state/IdentityContext';
import OnboardingScreenShell from './OnboardingScreenShell';

/**
 * Onboarding · 05 · Invite — ported from `ShiftSync Invite.dc.html` (the
 * link-first canonical version — its sibling "v1 (list-first)" file puts
 * the per-person list first, which is explicitly NOT what the product spec
 * wants: link+QR primary, individual invite a collapsed fallback).
 *
 * Real-data deviations from the prototype's simulated version:
 *  - The join-link, QR, and WhatsApp share link are the ACTUAL ones this app
 *    already mints server-side (`POST` via `mintInvite` — a real scannable
 *    QR PNG, not the prototype's placeholder pseudo-QR pattern).
 *  - "Or invite someone individually" lists real Staff Directory entries
 *    (`fetchStaffDirectory`), not the prototype's 12 seeded names. Staff
 *    parsed from the roster but not yet matched to a real User (Review's
 *    "new employee" rows) have no User record yet and so don't appear here
 *    — that's by design, not a gap: they're exactly who the primary QR/link
 *    flow is for (they self-onboard and create their own User by tapping
 *    it), while this fallback list is for already-known staff who need a
 *    direct nudge or have no WhatsApp group to share the link in.
 *  - "Send N direct invites" has no bulk-messaging backend to call (none
 *    exists anywhere in this app) — it opens one `wa.me/<phone>` deep link
 *    per selected person, client-side, the same mechanism the main Share-
 *    to-WhatsApp button already uses for the venue-wide link.
 *  - A phone typed into the individual list is persisted immediately
 *    (`updateStaffMember`) — real staff-record data, not local-only state.
 *  - "Finish setup"/"Skip" navigate to the real dashboard rather than the
 *    prototype's own reset/restart links, which have no meaning once a
 *    real venue has actually finished onboarding.
 */

function decodeWhatsAppMessage(whatsappUrl: string): string {
  try {
    return decodeURIComponent(new URL(whatsappUrl).searchParams.get('text') ?? '');
  } catch {
    return '';
  }
}

export default function InviteScreen({ locationId, onBack, onFinish }: { locationId: string; onBack: () => void; onFinish: () => void }) {
  const { session } = useIdentity();

  const [invite, setInvite] = useState<MintedInvite | null>(null);
  const [venueName, setVenueName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [qrSaved, setQrSaved] = useState(false);

  const [staff, setStaff] = useState<StaffDirectoryEntry[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phoneDrafts, setPhoneDrafts] = useState<Map<string, string>>(new Map());
  const [directSentCount, setDirectSentCount] = useState(0);
  const [done, setDone] = useState<'finished' | 'skipped' | null>(null);

  useEffect(() => {
    if (!session) {
      setLoading(false);
      setError('You need to be signed in to generate an invite link.');
      return;
    }
    let cancelled = false;
    Promise.all([mintInvite(session.token, locationId), fetchLocation(session.token, locationId), fetchStaffDirectory(session.token, locationId)])
      .then(([mintedInvite, location, directory]) => {
        if (cancelled) return;
        setInvite(mintedInvite);
        setVenueName(location.name);
        setStaff(directory.filter((s) => s.isActive));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load the invite link.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, locationId]);

  const messagePreview = useMemo(() => (invite ? decodeWhatsAppMessage(invite.whatsappUrl) : ''), [invite]);

  const handleCopy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access denied/unavailable — the link is already visible and
      // selectable in the card, so this is a degraded-but-not-broken case.
    }
  };

  const handleSaveQr = () => {
    if (!invite) return;
    const a = document.createElement('a');
    a.href = invite.qrDataUrl;
    a.download = `${venueName ?? 'shiftsync'}-join-qr.png`;
    a.click();
    setQrSaved(true);
  };

  const phoneFor = (s: StaffDirectoryEntry) => phoneDrafts.get(s.id) ?? (s.phone ?? '').replace(/^\+?971/, '').trim();

  const commitPhone = async (s: StaffDirectoryEntry) => {
    if (!session) return;
    const digits = phoneFor(s).trim();
    const full = digits ? `+971${digits.replace(/\D/g, '')}` : null;
    if (full === s.phone) return;
    try {
      const updated = await updateStaffMember(session.token, s.id, { phone: full });
      setStaff((prev) => prev.map((p) => (p.id === s.id ? updated : p)));
    } catch {
      // Best-effort — the draft stays in phoneDrafts either way so nothing
      // typed is lost; a conflict (e.g. that number already belongs to
      // someone else) just means the next persisted read won't reflect it.
    }
  };

  const selectedStaff = staff.filter((s) => selected.has(s.id) && phoneFor(s).trim());

  const handleSendDirect = () => {
    if (!invite || !venueName) return;
    for (const s of selectedStaff) {
      const digits = phoneFor(s).replace(/\D/g, '');
      const text = encodeURIComponent(`Hi ${s.fullName.split(' ')[0]}, you've been added to ${venueName}'s team on ShiftSync. Join here: ${invite.inviteUrl}`);
      window.open(`https://wa.me/971${digits}?text=${text}`, '_blank');
    }
    setDirectSentCount((c) => c + selectedStaff.length);
    setSelected(new Set());
  };

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(onFinish, 1600);
    return () => clearTimeout(t);
  }, [done, onFinish]);

  if (done) {
    const finished = done === 'finished';
    return (
      <div className="ob-root" style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 40px' }}>
        <img src="/shiftsync-mark.svg" alt="ShiftSync" style={{ width: 88, height: 44, display: 'block', marginBottom: 28 }} />
        <div className="ob-serif" style={{ fontSize: 34, lineHeight: 1.15, color: 'var(--ob-champagne)', letterSpacing: '-.005em' }}>
          {finished ? "You're set up." : 'Your room, your pace.'}
        </div>
        <div style={{ font: "500 13.5px/1.55 'Manrope'", color: 'var(--ob-bronze)', marginTop: 14, maxWidth: 270 }}>
          {finished
            ? shared || directSentCount > 0
              ? 'Your team can join the moment they tap. Taking you to your dashboard.'
              : 'Your join-link lives in Roster — share it any time. Taking you to your dashboard.'
            : "Your join-link is waiting in Roster whenever you're ready. Taking you to your dashboard."}
        </div>
        <button
          onClick={onFinish}
          style={{ marginTop: 36, font: "500 11px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-dim-2)', borderBottom: '1px solid rgba(85,81,74,.5)', paddingBottom: 3, background: 'transparent', border: 0 }}
        >
          Continue to Dashboard
        </button>
      </div>
    );
  }

  const ctaEngaged = shared || directSentCount > 0;

  return (
    <OnboardingScreenShell
      stepIndex={4}
      eyebrow="Step 5 of 5 · Invite"
      title="One link. Your whole team."
      onBack={onBack}
      footer={
        <>
          {error && <div style={{ color: '#e5484d', font: "400 13px/1.5 'Manrope'", marginBottom: 14 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '0 4px 14px' }}>
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="#8B7550" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
              <path d="M2.5 7.5l3.2-1.2 1.2-3.2 1.2 3.2 3.2 1.2-3.2 1.2-1.2 3.2-1.2-3.2z" />
            </svg>
            <div style={{ font: "400 12px/1.5 'Manrope'", color: 'var(--ob-bronze)' }}>They&apos;ll get a link on WhatsApp to set up their own access. No app download required to start.</div>
          </div>
          <button
            onClick={() => setDone('finished')}
            disabled={loading}
            style={{
              width: '100%',
              padding: '16px 20px',
              borderRadius: 14,
              background: ctaEngaged ? 'var(--ob-bone)' : 'rgba(239,234,224,.10)',
              color: ctaEngaged ? '#100D0A' : 'var(--ob-bone)',
              border: ctaEngaged ? '1px solid transparent' : '1px solid rgba(239,234,224,.14)',
              font: "600 14px/1 'Manrope'",
              letterSpacing: '.005em',
              transition: 'all .52s var(--ob-ease-out)',
              cursor: loading ? 'default' : 'pointer',
            }}
          >
            Finish setup
          </button>
          <div style={{ textAlign: 'center', marginTop: 14, font: "500 10px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-dim-2)' }}>
            Then · Dashboard
          </div>
        </>
      }
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -8 }}>
        <button onClick={() => setDone('skipped')} style={{ padding: 8, font: "500 10px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)', background: 'transparent', border: 0 }}>
          Skip — invite later
        </button>
      </div>

      <div style={{ font: "400 12.5px/1.5 'Manrope'", color: 'var(--ob-stone)', marginTop: -8 }}>Your team taps the link, confirms their name, and they&apos;re in. No manual entry.</div>

      {loading ? (
        <div style={{ font: "400 13px/1.5 'Manrope'", color: 'var(--ob-stone)' }}>Generating your invite link…</div>
      ) : invite ? (
        <>
          {/* Join link card */}
          <div style={{ borderRadius: 16, border: '1px solid rgba(201,166,107,.32)', background: 'rgba(201,166,107,.045)', padding: '14px 14px 14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ font: "500 9px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>Venue join-link</div>
                <div className="ob-serif" style={{ fontSize: 15, lineHeight: 1.2, color: 'var(--ob-bone)', marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {invite.inviteUrl.replace(/^https?:\/\//, '')}
                </div>
              </div>
              <button
                onClick={() => void handleCopy()}
                style={{
                  flexShrink: 0,
                  padding: '8px 12px',
                  borderRadius: 9,
                  border: `1px solid ${copied ? 'rgba(201,166,107,.7)' : 'rgba(239,234,224,.12)'}`,
                  color: copied ? 'var(--ob-champagne)' : 'var(--ob-stone)',
                  font: "500 10.5px/1 'Manrope'",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  background: 'transparent',
                  transition: 'all .22s var(--ob-ease-out)',
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <a
              href={invite.whatsappUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => setShared(true)}
              className="ob-press"
              style={{
                marginTop: 14,
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                padding: '15px 18px',
                borderRadius: 12,
                background: 'var(--ob-bone)',
                color: '#100D0A',
                font: "600 14px/1 'Manrope'",
                letterSpacing: '.005em',
              }}
            >
              <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 1.8a8.2 8.2 0 0 1 0 16.4c-1.5 0-2.9-.4-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 0 1 12 3.8zm-3.3 4.3c-.2 0-.5 0-.7.3-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.2 5 4.4 2.5 1 3 .8 3.5.7.5 0 1.7-.7 2-1.4.2-.7.2-1.3.1-1.4-.1-.1-.2-.2-.5-.3l-1.8-.9c-.2-.1-.4-.1-.6.1l-.8 1c-.2.2-.3.2-.6.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.5-1.1.1-.2 0-.3 0-.5l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.6z" />
              </svg>
              Share to WhatsApp
            </a>
            <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(5,4,3,.55)', border: '1px solid rgba(239,234,224,.06)', font: "400 11px/1.5 'Manrope'", color: 'var(--ob-stone)' }}>
              <span style={{ color: 'var(--ob-dim-2)', letterSpacing: '.2em', textTransform: 'uppercase', fontSize: 9, fontWeight: 500 }}>Message preview · </span>
              {messagePreview}
            </div>
          </div>

          {/* QR (secondary) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(239,234,224,.07)', background: 'rgba(239,234,224,.02)' }}>
            <div style={{ width: 72, height: 72, borderRadius: 10, background: 'var(--ob-bone)', padding: 6, flexShrink: 0 }}>
              <img src={invite.qrDataUrl} alt="Invite QR code" style={{ width: '100%', height: '100%', display: 'block' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ob-serif" style={{ fontSize: 15, lineHeight: 1.2, color: 'var(--ob-bone)' }}>Or post the QR</div>
              <div style={{ font: "400 11px/1.45 'Manrope'", color: 'var(--ob-bronze)', marginTop: 3 }}>Print it for the pass or the staff room. Same link.</div>
              <button onClick={handleSaveQr} style={{ marginTop: 8, font: "500 10px/1 'Manrope'", letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--ob-champagne)', background: 'transparent', border: 0 }}>
                {qrSaved ? 'Saved' : 'Save as image'}
              </button>
            </div>
          </div>

          {/* Individual (collapsed) */}
          <div style={{ borderRadius: 14, border: '1px solid rgba(239,234,224,.07)', background: 'rgba(239,234,224,.02)' }}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => setListOpen((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setListOpen((v) => !v);
              }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '13px 14px', cursor: 'pointer' }}
            >
              <div>
                <div className="ob-serif" style={{ fontSize: 15, lineHeight: 1.2, color: 'var(--ob-bone)' }}>Or invite someone individually</div>
                <div style={{ font: "400 11px/1.45 'Manrope'", color: 'var(--ob-bronze)', marginTop: 3 }}>
                  {listOpen ? 'Tick anyone to send a direct invite.' : `${staff.length} people from Staff Directory · for no-WhatsApp or a direct nudge`}
                </div>
              </div>
              <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="#55514A" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: `rotate(${listOpen ? 180 : 0}deg)`, transition: 'transform .32s var(--ob-ease-out)' }}>
                <path d="M3 4.5l3 3 3-3" />
              </svg>
            </div>
            {listOpen && (
              <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {staff.length === 0 && <div style={{ font: "400 12px/1.5 'Manrope'", color: 'var(--ob-stone)', padding: '4px 4px 8px' }}>No staff on file yet.</div>}
                {staff.map((s) => {
                  const has = phoneFor(s).trim().length > 0;
                  const on = selected.has(s.id) && has;
                  return (
                    <div
                      key={s.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: `1px solid ${on ? 'rgba(201,166,107,.32)' : 'rgba(239,234,224,.06)'}`,
                        background: on ? 'rgba(201,166,107,.045)' : 'rgba(239,234,224,.015)',
                        opacity: has ? 1 : 0.72,
                        transition: 'all .22s var(--ob-ease-out)',
                      }}
                    >
                      <button
                        aria-label="Select"
                        disabled={!has}
                        onClick={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(s.id)) next.delete(s.id);
                            else next.add(s.id);
                            return next;
                          })
                        }
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 7,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          border: `1px solid ${on ? 'rgba(201,166,107,.7)' : 'rgba(239,234,224,.14)'}`,
                          color: 'var(--ob-champagne)',
                          background: on ? 'rgba(201,166,107,.14)' : 'transparent',
                          transition: 'all .22s var(--ob-ease-out)',
                        }}
                      >
                        {on && (
                          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2.5 6.2l2.3 2.3 4.7-5" />
                          </svg>
                        )}
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                          <span className="ob-serif" style={{ fontSize: 15, lineHeight: 1.15, color: 'var(--ob-bone)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {s.fullName}
                          </span>
                          <span style={{ font: "500 10px/1 'Manrope'", letterSpacing: '.02em', color: 'var(--ob-bronze)', flexShrink: 0 }}>{s.roleName ?? s.jobTitle ?? ''}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                          <span style={{ font: "500 11.5px/1 'Manrope'", color: 'var(--ob-bronze)', flexShrink: 0 }}>+971</span>
                          <input
                            value={phoneFor(s)}
                            onChange={(e) => setPhoneDrafts((prev) => new Map(prev).set(s.id, e.target.value))}
                            onBlur={() => void commitPhone(s)}
                            placeholder="Add mobile number"
                            inputMode="tel"
                            autoComplete="off"
                            style={{
                              font: "500 12px/1 'Manrope'",
                              color: has ? 'var(--ob-bone)' : 'var(--ob-dim-2)',
                              letterSpacing: '.02em',
                              padding: '3px 0',
                              width: '100%',
                              background: 'transparent',
                              border: 0,
                              borderBottom: `1px solid ${has ? 'transparent' : 'rgba(201,166,107,.28)'}`,
                              outline: 'none',
                              transition: 'all .22s var(--ob-ease-out)',
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
                {selectedStaff.length > 0 && (
                  <button
                    onClick={handleSendDirect}
                    style={{
                      marginTop: 4,
                      width: '100%',
                      padding: 12,
                      borderRadius: 10,
                      border: '1px solid rgba(201,166,107,.6)',
                      color: 'var(--ob-champagne)',
                      font: "500 12px/1 'Manrope'",
                      letterSpacing: '.02em',
                      background: 'rgba(201,166,107,.08)',
                    }}
                  >
                    Send {selectedStaff.length} direct invite{selectedStaff.length === 1 ? '' : 's'} on WhatsApp
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      ) : null}
    </OnboardingScreenShell>
  );
}
