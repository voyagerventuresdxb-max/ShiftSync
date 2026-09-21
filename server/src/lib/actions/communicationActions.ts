import { prisma } from '../prisma.js';
import { notifyUsersBatched, notifyUser } from '../push.js';

/**
 * Extraction target for `Announcement`/`Shoutout` creation — see spec
 * 2026-09-11-voice-post-announcement-shoutout-design.md §2.2. Both models
 * exist for one purpose (posting to the Home feed), and this slice adds
 * voice support for both together, so — unlike shiftActions.ts↔shifts.ts's
 * strict 1:1 file pairing — one action file covers both, the same way
 * rotaActions.ts (Slice 3) already combined two distinct REST routes under
 * one topic.
 *
 * Per §2.3, this extraction is also where three gaps the pre-existing REST
 * routes had (confirmed by direct inspection: no auth at all on either POST
 * route, no length cap, no rate limit anywhere) get closed — enforced once
 * here so voice's /execute and the REST routes inherit the identical rule,
 * rather than validated per caller. The auth gap itself (`requireSession`)
 * is closed at the route layer, not here — see routes/announcements.ts and
 * routes/shoutouts.ts.
 *
 * `locationId` here is trusted as already belonging to the caller — both
 * `input.locationId` args are the session-derived `req.user.locationId` at
 * every call site (routes/announcements.ts, routes/shoutouts.ts, voice.ts),
 * never a request-supplied value (2026-09-20 tenant-isolation fix: the REST
 * routes previously forwarded `req.body.locationId` straight through, and
 * this function only ever checked that the location *existed*, not that it
 * was the caller's own — closed at the route layer, same as the auth gap
 * above, not by adding an ownership check in here).
 */

const ANNOUNCEMENT_BODY_MAX = 1000;
const SHOUTOUT_NOTE_MAX = 500;
const ANNOUNCEMENT_RATE_LIMIT_PER_HOUR = 10;
const SHOUTOUT_RATE_LIMIT_PER_HOUR = 20;

async function recentCount(model: 'announcement' | 'shoutout', locationId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  if (model === 'announcement') return prisma.announcement.count({ where: { locationId, createdAt: { gte: since } } });
  return prisma.shoutout.count({ where: { locationId, createdAt: { gte: since } } });
}

export type CreateAnnouncementResult =
  | { result: 'ok'; announcement: { id: string; body: string; authorId: string | null; authorName: string | null; createdAt: Date } }
  | { result: 'location_not_found'; message: string }
  | { result: 'author_not_found'; message: string }
  | { result: 'too_long'; message: string }
  | { result: 'rate_limited'; message: string };

export async function createAnnouncement(input: {
  locationId: string;
  authorId: string | null;
  body: string;
}): Promise<CreateAnnouncementResult> {
  if (input.body.length > ANNOUNCEMENT_BODY_MAX) {
    return { result: 'too_long', message: `Announcement text is too long (max ${ANNOUNCEMENT_BODY_MAX} characters).` };
  }
  const location = await prisma.location.findUnique({ where: { id: input.locationId } });
  if (!location) return { result: 'location_not_found', message: `Location "${input.locationId}" not found.` };
  if (input.authorId) {
    const author = await prisma.user.findUnique({ where: { id: input.authorId } });
    // Beyond the spec's reference snippet: also require the author belong to
    // THIS announcement's own location, mirroring createShoutout's
    // employeeId check below — an existence-only check would let a caller
    // misattribute a post to a real user in an unrelated venue. The
    // pre-extraction REST route had exactly this gap (confirmed by direct
    // inspection of routes/announcements.ts before this extraction: its
    // author lookup checks existence only, never location) — closed here as
    // part of the same extraction, same reasoning as the cross-tenant
    // templateId gap Slice 3's review caught in APPLY_ROTA_TEMPLATE.
    if (!author || author.locationId !== input.locationId) {
      return { result: 'author_not_found', message: `Author "${input.authorId}" not found.` };
    }
  }
  if ((await recentCount('announcement', input.locationId)) >= ANNOUNCEMENT_RATE_LIMIT_PER_HOUR) {
    return { result: 'rate_limited', message: 'Too many announcements posted recently — please wait before posting another.' };
  }

  const created = await prisma.announcement.create({
    data: { locationId: input.locationId, authorId: input.authorId, body: input.body },
    include: { author: { select: { fullName: true } } },
  });

  // Real delivery on top of the write above — never inside it, a push
  // failure must not roll back the post. Every active staff member at the
  // location except the author, batched (not one big Promise.all) since this
  // is the app's one full-roster fan-out — see lib/push.ts's own comment on
  // notifyUsersBatched for why.
  const recipients = await prisma.user.findMany({
    where: { locationId: input.locationId, isActive: true, id: { not: input.authorId ?? undefined } },
    select: { id: true },
  });
  void notifyUsersBatched(
    recipients.map((r) => r.id),
    { title: 'New announcement', body: input.body, url: '/' },
  );

  return {
    result: 'ok',
    announcement: {
      id: created.id,
      body: created.body,
      authorId: created.authorId,
      authorName: created.author?.fullName ?? null,
      createdAt: created.createdAt,
    },
  };
}

export type CreateShoutoutResult =
  | {
      result: 'ok';
      shoutout: { id: string; employeeId: string; employeeName: string; authorId: string | null; authorName: string | null; note: string; createdAt: Date };
    }
  | { result: 'employee_not_found'; message: string }
  | { result: 'author_not_found'; message: string }
  | { result: 'too_long'; message: string }
  | { result: 'rate_limited'; message: string };

export async function createShoutout(input: {
  locationId: string;
  employeeId: string;
  authorId: string | null;
  shiftSnapshot: string | null;
  note: string;
}): Promise<CreateShoutoutResult> {
  if (input.note.length > SHOUTOUT_NOTE_MAX) {
    return { result: 'too_long', message: `Shoutout note is too long (max ${SHOUTOUT_NOTE_MAX} characters).` };
  }
  const employee = await prisma.user.findUnique({ where: { id: input.employeeId } });
  if (!employee || employee.locationId !== input.locationId) {
    return { result: 'employee_not_found', message: `Staff member "${input.employeeId}" not found.` };
  }
  if (input.authorId) {
    const author = await prisma.user.findUnique({ where: { id: input.authorId } });
    // Same cross-tenant fix as createAnnouncement's author check above.
    if (!author || author.locationId !== input.locationId) {
      return { result: 'author_not_found', message: `Author "${input.authorId}" not found.` };
    }
  }
  if ((await recentCount('shoutout', input.locationId)) >= SHOUTOUT_RATE_LIMIT_PER_HOUR) {
    return { result: 'rate_limited', message: 'Too many shoutouts posted recently — please wait before posting another.' };
  }

  const created = await prisma.shoutout.create({
    data: { locationId: input.locationId, employeeId: input.employeeId, authorId: input.authorId, shiftSnapshot: input.shiftSnapshot, note: input.note },
    include: { employee: { select: { fullName: true } }, author: { select: { fullName: true } } },
  });

  // Skipped for the rare self-tag case (employeeId === authorId) — nobody
  // needs telling they recognized themselves.
  if (created.employeeId !== created.authorId) {
    void notifyUser(created.employeeId, {
      title: 'You got a shoutout!',
      body: `${created.author?.fullName ?? 'Someone'} recognized you: "${created.note}"`,
      url: '/',
    });
  }

  return {
    result: 'ok',
    shoutout: {
      id: created.id,
      employeeId: created.employeeId,
      employeeName: created.employee.fullName,
      authorId: created.authorId,
      authorName: created.author?.fullName ?? null,
      note: created.note,
      createdAt: created.createdAt,
    },
  };
}
