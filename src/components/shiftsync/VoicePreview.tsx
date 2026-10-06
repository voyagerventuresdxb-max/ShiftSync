import type { ReactNode } from 'react';
import { ArrowLeftRight, CalendarCheck, CalendarX, LayoutTemplate, MapPin, UserPlus } from 'lucide-react';
import type { ParsedIntent } from '@/api/voice';
import { AnnouncementCard, ShoutoutCard } from '@/components/shiftsync/FeedCards';
import { formatStamp, initials } from '@/lib/feedFormat';
import { cn } from '@/lib/utils';

/**
 * What a voice command will do, drawn the way the app shows the result: a shout-out or an
 * announcement as its board card, a shift as its rota line (person, day, time), a swap or join
 * request as its request line. Every name comes from the server's `details` (the caller's own
 * venue), never from the model's wording.
 */

/** "Sat 10 Oct" for a YYYY-MM-DD venue day. */
function day(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const span = (start: string, end: string) => `${start}–${end}`;

function Avatar({ name }: { name: string | null | undefined }) {
  return (
    <span
      className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-full border text-[11px] font-semibold',
        name ? 'border-accent/30 bg-accent/10 text-accent' : 'border-dashed border-border text-foreground/38',
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

/** One rota-style line: who, then what/when, with an optional tag and a "was" line for edits. */
function Line({ lead, title, detail, was, tag }: { lead: ReactNode; title: string; detail: string; was?: string; tag?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-background/40 p-3">
      {lead}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="truncate text-sm font-semibold text-foreground/87">{title}</p>
          {tag}
        </div>
        <p className="mt-0.5 text-xs text-foreground/60">{detail}</p>
        {was && <p className="mt-0.5 text-[11px] text-foreground/38">Was: {was}</p>}
      </div>
    </div>
  );
}

const iconLead = (icon: ReactNode) => (
  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-accent" aria-hidden>
    {icon}
  </span>
);

export function VoicePreview({ intent, viewerName }: { intent: ParsedIntent; viewerName: string }) {
  const d = intent.intent === 'UNRECOGNIZED' ? undefined : intent.details;
  switch (intent.intent) {
    case 'POST_SHOUTOUT':
      return <ShoutoutCard as="div" name={d?.person ?? intent.targetUserName} note={intent.content} meta={`${viewerName} · just now`} />;
    case 'POST_ANNOUNCEMENT':
      return <AnnouncementCard as="div" body={intent.content} meta={`${viewerName} · ${formatStamp(new Date().toISOString())} · just now`} />;
    case 'CREATE_SHIFT': {
      const person = d?.person ?? null;
      return (
        <Line
          lead={<Avatar name={person} />}
          title={person ?? 'Open shift'}
          detail={[d?.role, day(intent.date), span(intent.start, intent.end)].filter(Boolean).join(' · ')}
          tag={<Tag>Draft</Tag>}
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
          detail={[after.role, after.date && day(after.date), after.start && after.end && span(after.start, after.end)].filter(Boolean).join(' · ')}
          was={before ? [before.person ?? 'Open', day(before.date), span(before.start, before.end)].join(' · ') : undefined}
          tag={<Tag tone="gold">Change</Tag>}
        />
      );
    }
    case 'ASSIGN_SECTION':
      return (
        <Line
          lead={<Avatar name={d?.person ?? intent.targetUserName} />}
          title={d?.person ?? intent.targetUserName ?? ''}
          detail={[day(intent.shiftDate), intent.period, intent.dutyLabel].filter(Boolean).join(' · ')}
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
          detail={d?.shift ? `Your shift · ${day(d.shift.date)} · ${span(d.shift.start, d.shift.end)}` : 'Your shift'}
          tag={<Tag>Request</Tag>}
        />
      );
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      return (
        <Line
          lead={<Avatar name={d?.person} />}
          title={d?.person ? `${d.person}'s swap request` : 'Swap request'}
          detail={[d?.cover ? `${d.cover} to cover` : null, d?.shift && day(d.shift.date), d?.shift && span(d.shift.start, d.shift.end)].filter(Boolean).join(' · ')}
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
