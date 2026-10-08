import type { ReactNode } from 'react';
import { ArrowLeftRight, CalendarCheck, CalendarX, LayoutTemplate, MapPin, Plane, UserPlus } from 'lucide-react';
import type { CancelShiftIntent, ParsedIntent, ReadingDetails } from '@/api/voice';
import { AnnouncementCard, ShoutoutCard } from '@/components/shiftsync/FeedCards';
import { formatStamp, initials } from '@/lib/feedFormat';
import { cn } from '@/lib/utils';
import { fullDay, shiftWhen } from '@/lib/voiceWhen';
import { daysInclusive, publishSentence } from '@/lib/voiceWording';

/**
 * What a voice command will do, drawn the way the app shows the result: a shout-out or an
 * announcement as its board card, a shift as its rota line (person, day, time), a swap or join
 * request as its request line. Every name comes from the server's `details` (the caller's own
 * venue), never from the model's wording.
 */

/** Days and times are spelled out in full ("Friday 9 October 2026, 18:30 – 01:00 (ends Saturday)") so a wrong one shows. */
const day = fullDay;

function Avatar({ name }: { name: string | null | undefined }) {
  return (
    <span
      className={cn(
        'grid h-10 w-10 shrink-0 place-items-center rounded-full border text-xs font-semibold',
        name ? 'border-accent/30 bg-accent/10 text-accent' : 'border-dashed border-border text-foreground/60',
      )}
      aria-hidden
    >
      {name ? initials(name) : '—'}
    </span>
  );
}

function Tag({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'gold' | 'danger' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]',
        tone === 'gold' && 'border-accent/40 bg-accent/10 text-accent',
        tone === 'danger' && 'border-destructive/40 bg-destructive/10 text-destructive',
        tone === 'muted' && 'border-border text-foreground/60',
      )}
    >
      {children}
    </span>
  );
}

/**
 * One rota-style line: who (and their role), then what/when (one or more lines), with an optional
 * tag and a "was" line for edits. `danger` marks something being taken away (a cancellation).
 */
function Line({
  lead,
  title,
  role,
  detail,
  was,
  tag,
  danger = false,
}: {
  lead: ReactNode;
  title: string;
  role?: string | null;
  detail: string | string[];
  was?: string;
  tag?: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className={cn('flex min-w-0 items-start gap-3.5 rounded-2xl border p-3.5', danger ? 'border-destructive/45 bg-destructive/[0.06]' : 'border-border bg-background/50')}>
      {lead}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="truncate text-[15px] font-semibold text-foreground/87">{title}</p>
          {tag}
        </div>
        {role && <p className="mt-0.5 text-xs font-medium text-accent">{role}</p>}
        {(Array.isArray(detail) ? detail : [detail]).map((line) => (
          <p key={line} className="mt-1 text-[13px] leading-snug text-foreground/87">
            {line}
          </p>
        ))}
        {was && <p className="mt-1 text-xs text-foreground/60">Was: {was}</p>}
      </div>
    </div>
  );
}

const iconLead = (icon: ReactNode) => (
  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-accent" aria-hidden>
    {icon}
  </span>
);

/** These need the server's names to be drawn truthfully; without them the sheet shows its sentence only. */
const NEEDS_DETAILS = new Set(['CREATE_SHIFT', 'EDIT_SHIFT', 'ASSIGN_SECTION', 'REQUEST_SWAP', 'APPROVE_SWAP', 'DECLINE_SWAP', 'APPROVE_JOIN', 'DECLINE_JOIN', 'CANCEL_SHIFT']);

/** The preview, with its caption; nothing at all when there is nothing truthful to draw. */
export function VoicePreview({ intent, viewerName }: { intent: ParsedIntent; viewerName: string }) {
  const hasDetails = 'details' in intent && !!intent.details;
  if (!hasDetails && NEEDS_DETAILS.has(intent.intent)) return null;
  const d = 'details' in intent && intent.intent !== 'CANCEL_SHIFT' ? intent.details : undefined;
  const card = previewCard(intent, d, viewerName);
  if (!card) return null;
  const isPost = intent.intent === 'POST_SHOUTOUT' || intent.intent === 'POST_ANNOUNCEMENT';
  const caption = isPost
    ? 'How it will look'
    : intent.intent === 'CANCEL_SHIFT'
      ? 'Shift to cancel'
      : intent.intent === 'PUBLISH_ROTA' && intent.counts
        ? 'Before you publish'
        : 'What will change';
  return (
    <div className="mt-4">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-foreground/60">{caption}</p>
      {card}
    </div>
  );
}

/** The cancellation card: whose shift comes off the rota, with its day and times in full. */
function CancelCard({ details }: { details: CancelShiftIntent['details'] }) {
  const person = details.person;
  return (
    <>
      <Line
        lead={<Avatar name={person} />}
        title={person ?? 'Open shift'}
        role={person ? details.personRole : null}
        detail={[details.role, shiftWhen(details.date, details.start, details.end)].filter(Boolean).join(' · ')}
        tag={<Tag tone="danger">Cancel</Tag>}
        danger
      />
      <p className="mt-2 text-xs text-foreground/60">
        {person ? `This shift comes off the rota, and ${person} is no longer working it.` : 'This open shift comes off the rota.'}
      </p>
    </>
  );
}

/** The publish card when the server sent its counts: the two numbers that matter, large, and one plain sentence. */
function PublishCard({ weekStart, counts }: { weekStart: string; counts: { shiftsChanging: number; peopleNotified: number } }) {
  return (
    <div className="rounded-2xl border border-accent/50 bg-accent/[0.06] p-3.5">
      <div className="flex min-w-0 items-center gap-3">
        {iconLead(<CalendarCheck className="h-4 w-4" />)}
        <p className="min-w-0 flex-1 text-[15px] font-semibold text-foreground/87">Week of {day(weekStart)}</p>
        <Tag tone="gold">Publish</Tag>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-border bg-background/50 px-3 py-2.5">
          <dt className="text-[11px] font-medium text-foreground/60">Shifts changing</dt>
          <dd className="mt-0.5 font-['Instrument_Serif',ui-serif,Georgia,serif] text-[34px] leading-none tabular-nums text-accent">{counts.shiftsChanging}</dd>
        </div>
        <div className="rounded-xl border border-border bg-background/50 px-3 py-2.5">
          <dt className="text-[11px] font-medium text-foreground/60">People notified</dt>
          <dd className="mt-0.5 font-['Instrument_Serif',ui-serif,Georgia,serif] text-[34px] leading-none tabular-nums text-accent">{counts.peopleNotified}</dd>
        </div>
      </dl>
      <p className="mt-2.5 text-sm text-foreground/87">{publishSentence(counts)}</p>
      <p className="mt-0.5 text-xs text-foreground/60">Staff see the published week as soon as you confirm.</p>
    </div>
  );
}

function previewCard(intent: ParsedIntent, d: ReadingDetails | undefined, viewerName: string): ReactNode {
  switch (intent.intent) {
    case 'POST_SHOUTOUT':
      return (
        <>
          <ShoutoutCard as="div" name={d?.person ?? intent.targetUserName} note={intent.content} meta={`${viewerName} · just now`} />
          {d?.person && d.personRole && (
            <p className="mt-2 text-xs text-foreground/60">
              For {d.person} · {d.personRole}
            </p>
          )}
        </>
      );
    case 'POST_ANNOUNCEMENT':
      return <AnnouncementCard as="div" body={intent.content} meta={`${viewerName} · ${formatStamp(new Date().toISOString())} · just now`} />;
    case 'CREATE_SHIFT': {
      const person = d?.person ?? null;
      // A split shift: both parts spelled out in full, each on its own line.
      const detail = intent.second
        ? [
            [d?.role, 'Split shift, two parts'].filter(Boolean).join(' · '),
            `1st: ${shiftWhen(intent.date, intent.start, intent.end)}`,
            `2nd: ${shiftWhen(intent.date, intent.second.start, intent.second.end)}`,
          ]
        : [d?.role, shiftWhen(intent.date, intent.start, intent.end)].filter(Boolean).join(' · ');
      return <Line lead={<Avatar name={person} />} title={person ?? 'Open shift'} role={person ? d?.personRole : null} detail={detail} tag={<Tag>Draft</Tag>} />;
    }
    case 'CANCEL_SHIFT':
      return <CancelCard details={intent.details} />;
    case 'REQUEST_TIME_OFF': {
      const days = daysInclusive(intent.startDate, intent.endDate) ?? 1;
      const when = intent.startDate === intent.endDate ? fullDay(intent.startDate) : `From ${fullDay(intent.startDate)} to ${fullDay(intent.endDate)}`;
      return (
        <Line
          lead={iconLead(<Plane className="h-4 w-4" />)}
          // Always the caller's own days (a voice time-off request carries no person): said on the card.
          title={`Your time off · ${days === 1 ? '1 day' : `${days} days`}`}
          detail={[when, ...(intent.reason ? [`Reason: ${intent.reason}`] : [])]}
          tag={<Tag>Request</Tag>}
        />
      );
    }
    case 'EDIT_SHIFT': {
      const before = d?.shift;
      const person = d && 'person' in d ? (d.person ?? null) : (before?.person ?? null);
      const after = {
        role: d?.role ?? before?.role,
        date: intent.date ?? before?.date,
        start: intent.start ?? before?.start,
        end: intent.end ?? before?.end,
      };
      return (
        <Line
          lead={<Avatar name={person} />}
          title={person ?? 'Open shift'}
          role={person && d && 'person' in d ? d.personRole : null}
          detail={[after.role, after.date && (after.start && after.end ? shiftWhen(after.date, after.start, after.end) : day(after.date))].filter(Boolean).join(' · ')}
          was={before ? [before.person ?? 'Open', shiftWhen(before.date, before.start, before.end)].join(' · ') : undefined}
          tag={<Tag tone="gold">Change</Tag>}
        />
      );
    }
    case 'ASSIGN_SECTION':
      return (
        <Line
          lead={<Avatar name={d?.person ?? intent.targetUserName} />}
          title={d?.person ?? intent.targetUserName ?? ''}
          role={d?.personRole}
          detail={[day(intent.shiftDate), intent.period === 'PM' ? 'Evening (PM)' : 'Morning (AM)', intent.dutyLabel].filter(Boolean).join(' · ')}
          tag={
            <Tag tone="gold">
              <MapPin className="-mt-px mr-1 inline h-3 w-3" aria-hidden />
              {d?.section ?? 'Section'}
            </Tag>
          }
        />
      );
    case 'REQUEST_SWAP':
      return (
        <Line
          lead={iconLead(<ArrowLeftRight className="h-4 w-4" />)}
          title={`Ask ${d?.person ?? intent.targetUserName} to cover`}
          role={d?.personRole}
          detail={d?.shift ? `Your shift · ${shiftWhen(d.shift.date, d.shift.start, d.shift.end)}` : 'Your shift'}
          tag={<Tag>Request</Tag>}
        />
      );
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      return (
        <Line
          lead={<Avatar name={d?.person} />}
          title={d?.person ? `${d.person}'s swap request` : 'Swap request'}
          detail={[d?.cover ? `${d.cover} to cover` : null, d?.shift && shiftWhen(d.shift.date, d.shift.start, d.shift.end)].filter(Boolean).join(' · ')}
          tag={intent.intent === 'APPROVE_SWAP' ? <Tag tone="gold">Approve</Tag> : <Tag tone="danger">Decline</Tag>}
        />
      );
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN':
      return (
        <Line
          lead={iconLead(<UserPlus className="h-4 w-4" />)}
          title={d?.person ?? 'Join request'}
          detail="Asked to join your team"
          tag={intent.intent === 'APPROVE_JOIN' ? <Tag tone="gold">Approve</Tag> : <Tag tone="danger">Decline</Tag>}
        />
      );
    case 'MARK_AVAILABILITY':
      return (
        <Line
          lead={iconLead(<CalendarX className="h-4 w-4" />)}
          title={day(intent.date)}
          detail="Your availability"
          tag={<Tag tone="gold">{intent.type === 'UNAVAILABLE' ? 'Unavailable' : 'Prefer off'}</Tag>}
        />
      );
    case 'PUBLISH_ROTA':
      if (intent.counts) return <PublishCard weekStart={intent.weekStart} counts={intent.counts} />;
      return <Line lead={iconLead(<CalendarCheck className="h-4 w-4" />)} title={`Week of ${day(intent.weekStart)}`} detail="Rota goes live; staff are notified" tag={<Tag tone="gold">Publish</Tag>} />;
    case 'APPLY_ROTA_TEMPLATE':
      return (
        <Line
          lead={iconLead(<LayoutTemplate className="h-4 w-4" />)}
          title={intent.templateName}
          detail={`Draft shifts for the week of ${day(intent.weekStart)}`}
          tag={<Tag>Template</Tag>}
        />
      );
    default:
      return null;
  }
}
