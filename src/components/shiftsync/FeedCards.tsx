import type { ReactNode } from 'react';
import { Megaphone } from 'lucide-react';
import { initials } from '@/lib/feedFormat';

/**
 * The shout-out and announcement cards as they appear on the venue board (Shoutouts.tsx,
 * Announcements.tsx), shared with the voice confirm sheet's preview so "what you'll post" is
 * drawn by the same markup as "what was posted".
 */

export function ShoutoutCard({ name, note, meta, action, as: Tag = 'li' }: { name: string; note: string; meta: string; action?: ReactNode; as?: 'li' | 'div' }) {
  return (
    <Tag className="rounded-xl border border-border bg-background/40 p-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-[11px] font-semibold text-accent">
          {initials(name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="text-sm text-muted-foreground">{note}</p>
          <p className="mt-1.5 text-[11px] text-muted-foreground">{meta}</p>
        </div>
        {action}
      </div>
    </Tag>
  );
}

export function AnnouncementCard({ body, meta, action, as: Tag = 'li' }: { body: string; meta: string; action?: ReactNode; as?: 'li' | 'div' }) {
  return (
    <Tag className="rounded-xl border border-border bg-background/40 p-3">
      <div className="flex min-w-0 items-start gap-3">
        <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-relaxed">{body}</p>
          <p className="mt-1.5 text-[11px] text-muted-foreground">{meta}</p>
        </div>
        {action}
      </div>
    </Tag>
  );
}
