import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * Privacy policy and terms — DRAFTS. Every statement about data reflects what the code does
 * today; everything legal (entity, jurisdiction, retention periods, rights wording) is a
 * placeholder for counsel. Linked from /login and the join screen.
 */
function DraftBanner() {
  return (
    <div className="error-block" role="note" data-testid="legal-draft-banner">
      <p>
        <strong>DRAFT — needs legal review — not yet in force.</strong> This page describes how ShiftSync handles data today so it can be
        reviewed. Items in [brackets] are placeholders.
      </p>
    </div>
  );
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="panel space-y-4 p-5 text-sm leading-relaxed">
      <DraftBanner />
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
      <p className="text-xs text-muted-foreground">
        <Link to="/privacy" className="hit-44 inline-block">Privacy policy (draft)</Link> · <Link to="/terms" className="hit-44 inline-block">Terms (draft)</Link> ·{" "}
        <Link to="/login" className="hit-44 inline-block">Back to sign in</Link>
      </p>
    </article>
  );
}

/** Small footer used on the sign-in and join screens (store reviewers and new staff look for these). */
export function LegalLinks() {
  return (
    <p className="mt-6 text-center text-xs text-muted-foreground" data-testid="legal-links">
      <Link to="/privacy" className="hit-44 inline-block underline-offset-2 hover:text-foreground hover:underline">
        Privacy policy (draft)
      </Link>
      {' · '}
      <Link to="/terms" className="hit-44 inline-block underline-offset-2 hover:text-foreground hover:underline">
        Terms (draft)
      </Link>
    </p>
  );
}

export function PrivacyContent() {
  return (
    <Page title="Privacy policy (draft)">
      <p>
        ShiftSync is operated by [legal entity name], [address] ("we"). Venues use it to schedule and communicate with their staff. Contact:
        [privacy contact email].
      </p>
      <h2 className="font-semibold">What we hold</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>Account: your name, mobile number (used to sign in), and the venue and role your manager set; optionally a job title and preferred language.</li>
        <li>Work records: shifts, availability, cover/swap requests, attendance clock-ins, announcements, shout-outs and floor feedback.</li>
        <li>Sign-in: one-time codes and login links (stored hashed or expiring), and session records.</li>
        <li>
          Voice commands, if you use them: the audio is sent for transcription with a short spelling list from your own venue only — the
          names of its current team members as shown in the app, and its section and role names (never phone numbers, email addresses,
          applicants, former staff or anyone at another venue). ShiftSync itself decides who a named person is, from your venue's team
          list, and asks you when a name could mean more than one person. The text of the command is kept in an activity log.
        </li>
        <li>Rosters a manager uploads: spreadsheets and text PDFs are read on our own server; a preview is held for about 15 minutes until confirmed.</li>
        <li>Notifications: if you turn on push notifications, your browser's push address.</li>
      </ul>
      <h2 className="font-semibold">Who processes it</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>Hosting: Railway (application and database, [region]) and Vercel (the web app).</li>
        <li>
          Google (Gemini / Vertex AI) — a third-party AI service outside the UAE — for voice commands, and for reading photographed, scanned or
          unusual roster files. A roster file is sent only after the manager agrees, each time.
        </li>
        <li>Browser push services (Apple, Google, Mozilla), only if you enable notifications.</li>
        <li>[SMS / WhatsApp provider, when one is added.]</li>
      </ul>
      <h2 className="font-semibold">Deleting your account</h2>
      <p>
        Profile → Delete account removes your account immediately: your name, number and other personal details are erased and every
        session ends. Shifts and attendance you already worked stay in your venue's records without your name, because the venue needs
        them for [payroll / labour-law] purposes for [retention period]. Security audit entries are kept for [period].
      </p>
      <h2 className="font-semibold">Your rights</h2>
      <p>[Access, correction, deletion and objection rights under the applicable law (e.g. UAE PDPL), and how to exercise them.]</p>
    </Page>
  );
}

export function TermsContent() {
  return (
    <Page title="Terms of use (draft)">
      <p>These terms between [legal entity name] and the venue and its users govern use of ShiftSync. [Governing law and venue.]</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Venues are responsible for the accuracy of the rosters they publish and for having their staff's permission to add them.</li>
        <li>Managers confirm every roster on the review screen before it is saved; AI-read rosters must be checked before confirming.</li>
        <li>Don't misuse the service: no access to other venues' data, no automated scraping, no attempts to bypass sign-in.</li>
        <li>[Service availability, liability limits, fees, suspension and termination.]</li>
      </ul>
    </Page>
  );
}
