import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../prisma.js';
import { withAuditedTransaction } from '../auditLog.js';
import { notifyUser } from '../push.js';
import { consumeInviteUse } from '../inviteLinks.js';
import { foldedNameKey, nameCloseness, personNameKey } from '../../parsing/resolveRows.js';

export const JOIN_PHONE_TAKEN_ERROR = "This phone number already belongs to another staff account, so this request can't be approved. Decline it instead.";
export const JOIN_LINK_CHOICE_MESSAGE = 'This person could be someone imported from your roster. Choose who they are, or add them as a new person.';
export const JOIN_LINK_TARGET_INVALID_MESSAGE = "That staff record can't be linked: only someone imported from this venue's roster who hasn't signed in yet can be.";

/** Join requests one phone may ever file at one venue, whatever became of them; past this only a manager can add them. */
export const MAX_JOIN_ATTEMPTS = 3;

/** What a declined applicant sees, from /login or from the venue's join link. */
export function joinDeclinedMessage(venueName: string, canReapply: boolean): string {
  return canReapply
    ? `Your request to join ${venueName} was declined. You can apply again with your full name through ${venueName}'s invite link, or ask a manager there to add you to the staff list.`
    : `Your request to join ${venueName} was declined. Ask a manager there to add you to the staff list, then sign in with this number.`;
}

/** The join link's answer once a phone has used up its attempts at a venue. */
export function joinAttemptsExhaustedMessage(venueName: string): string {
  return `You've already applied to ${venueName} ${MAX_JOIN_ATTEMPTS} times. Ask a manager there to add you.`;
}

/** Whether this phone may still file a join request at this venue. */
export async function canReapplyToJoin(locationId: string, phone: string): Promise<boolean> {
  return (await prisma.joinRequest.count({ where: { locationId, phone } })) < MAX_JOIN_ATTEMPTS;
}

export type JoinFiling =
  | { kind: 'open'; requestId: string }
  | { kind: 'created'; requestId: string; fullName: string }
  | { kind: 'exhausted' }
  | { kind: 'needs_name'; declined: boolean }
  | { kind: 'link_unusable' };

class InviteLinkUnusableError extends Error {}

/**
 * Files a PENDING join request for a phone with no account at this venue —
 * or reports why not. An open request is returned as-is (no duplicate, no
 * invite use); a phone that has filed `MAX_JOIN_ATTEMPTS` here is refused.
 * Only a new request consumes a use of `inviteLinkId`. Runs under a
 * per-(phone, venue) advisory lock, so concurrent verifies can neither file
 * two requests nor pass the cap together.
 */
export async function fileJoinRequest(
  input: { locationId: string; phone: string; fullName: string | null; inviteLinkId: string | null },
  client: PrismaClient = prisma,
): Promise<JoinFiling> {
  const { locationId, phone, fullName, inviteLinkId } = input;
  try {
    return await client.$transaction(async (tx): Promise<JoinFiling> => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`join:${locationId}:${phone}`}))::text`;
      const history = await tx.joinRequest.findMany({ where: { locationId, phone }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true } });
      const open = history.find((r) => r.status === 'PENDING');
      if (open) return { kind: 'open', requestId: open.id };
      if (history.length >= MAX_JOIN_ATTEMPTS) return { kind: 'exhausted' };
      if (!fullName) return { kind: 'needs_name', declined: history[0]?.status === 'DECLINED' };
      if (inviteLinkId && !(await consumeInviteUse(tx, inviteLinkId))) throw new InviteLinkUnusableError();
      const created = await tx.joinRequest.create({ data: { locationId, phone, fullName, status: 'PENDING' } });
      return { kind: 'created', requestId: created.id, fullName: created.fullName };
    });
  } catch (err) {
    if (err instanceof InviteLinkUnusableError) return { kind: 'link_unusable' };
    throw err;
  }
}

/** Exact-target P2002 on `User.phone`, same check as staffDirectory.ts's `isPhoneConflict`. */
function isPhoneConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target as unknown;
  return Array.isArray(target) && target.length === 1 && target[0] === 'phone';
}

/**
 * Thrown inside the decide transactions (both decline and approve) when the
 * atomic `joinRequest.updateMany` guard finds the request is no longer
 * PENDING — i.e. a concurrent decision (a double-approve, or an
 * approve/decline race on the same request) already reviewed it between our
 * initial read and this write. Thrown (rather than just returning a flag) so
 * the transaction rolls back the rest of what it was about to write too —
 * on the approve path that includes the just-created User row, so a losing
 * race never leaves an orphan staff member with no matching "approved"
 * request. Mirrors `swapActions.ts`'s `ShiftAlreadyReassignedError`.
 */
export class JoinRequestAlreadyReviewedError extends Error {}

/**
 * A staff record a join request might be: someone a roster import added who has never signed in
 * (active STAFF, no phone, no email). Approving the request can claim that record — and its
 * shifts — instead of adding the same person twice.
 */
export interface JoinLinkCandidate {
  userId: string;
  fullName: string;
  roleName: string | null;
  /** 'exact': the same full name. 'close': part of it (first name or surname only), a nickname, an initial, another spelling. */
  match: 'exact' | 'close';
}

/**
 * What approving a request does about imported records:
 *  - 'link': exactly one imported record carries the requester's full name (two words or more),
 *    and no other imported record is even close — it is claimed without asking;
 *  - 'choose': anything else that could be them (two with the same name, a first name only, a
 *    nickname, an initial...) — the manager must say which, or "new person", when approving;
 *  - 'new': nothing could be them — a new staff member is added.
 * Approval itself is always the manager's.
 */
export type JoinLinkPlan = { kind: 'link'; candidate: JoinLinkCandidate } | { kind: 'choose'; candidates: JoinLinkCandidate[] } | { kind: 'new' };

/** Imported, never signed in: the only records a join request may claim. */
export const importedRecordWhere = (locationId: string) =>
  ({ locationId, systemRole: 'STAFF', isActive: true, deletedAt: null, phone: null, email: null }) as const;

export type ImportedRecord = { id: string; fullName: string; role: { name: string } | null };

/** Every word of the shorter name is one of the longer one's ("Karim" or "Saleh" for "Karim Saleh"). */
function wordsWithin(a: string, b: string): boolean {
  const [short, long] = [foldedNameKey(a).split(' '), foldedNameKey(b).split(' ')].sort((x, y) => x.length - y.length) as [string[], string[]];
  return short[0] !== '' && short.every((w) => long.includes(w));
}

export function joinLinkPlan(requestName: string, imported: ImportedRecord[]): JoinLinkPlan {
  const key = personNameKey(requestName);
  if (!key) return { kind: 'new' };
  const candidates = imported
    .flatMap((u): JoinLinkCandidate[] => {
      const match = personNameKey(u.fullName) === key ? 'exact' : wordsWithin(requestName, u.fullName) || nameCloseness(requestName, u.fullName) ? 'close' : null;
      return match ? [{ userId: u.id, fullName: u.fullName, roleName: u.role?.name ?? null, match }] : [];
    })
    .sort((a, b) => (a.match === b.match ? a.fullName.localeCompare(b.fullName) : a.match === 'exact' ? -1 : 1));
  if (!candidates.length) return { kind: 'new' };
  // A one-word name ("Karim") is a first name only, however exactly it matches: never linked on its own.
  if (candidates.length === 1 && candidates[0]!.match === 'exact' && key.includes(' ')) return { kind: 'link', candidate: candidates[0]! };
  return { kind: 'choose', candidates };
}

/** The approve call needs the manager's choice (JoinLinkPlan 'choose') and didn't carry one. */
class LinkChoiceRequiredError extends Error {
  constructor(readonly candidates: JoinLinkCandidate[]) {
    super('link choice required');
  }
}
/** The chosen record isn't an imported, never-signed-in staff record of this venue (or was just claimed). */
class LinkTargetInvalidError extends Error {}

/**
 * Approves or declines a PENDING join request.
 *
 * Approving creates a real, active User from the request's phone/fullName
 * and links it back onto the request — this is the one place a JoinRequest
 * ever produces a real staff member — or claims the imported record that is
 * this person (see JoinLinkPlan). `linkTo` is the manager's choice: an
 * imported record's id, or 'new'; it is required when the plan is 'choose'.
 * `decision` and `jobTitle` are assumed already parsed/validated by the
 * caller (the HTTP route, or the voice route).
 */
export async function decideJoinRequest(input: {
  requestId: string;
  decision: 'approve' | 'decline';
  reviewedById: string | null;
  jobTitle?: string | null;
  linkTo?: string | null;
}): Promise<
  | { result: 'ok'; status: 'APPROVED' | 'DECLINED'; userId?: string; linked?: boolean }
  | { result: 'not_found' }
  | { result: 'already_reviewed' }
  | { result: 'phone_taken' }
  | { result: 'link_choice_required'; candidates: JoinLinkCandidate[] }
  | { result: 'link_target_invalid' }
> {
  const existing = await prisma.joinRequest.findUnique({
    where: { id: input.requestId },
    include: { location: { select: { name: true } } },
  });
  if (!existing) return { result: 'not_found' };
  if (existing.status !== 'PENDING') return { result: 'already_reviewed' };

  if (input.decision === 'decline') {
    const declined = await withAuditedTransaction(
      prisma,
      async (tx) => {
        // Atomic guard: only decline if the request is still PENDING. Two
        // concurrent decisions on the same request (double-decline, or an
        // approve/decline race) can both pass the plain `existing.status`
        // check above (which only reflects what was true at read time), but
        // only one `updateMany` here can ever match and actually flip status.
        const result = await tx.joinRequest.updateMany({
          where: { id: input.requestId, status: 'PENDING' },
          data: { status: 'DECLINED', reviewedById: input.reviewedById, reviewedAt: new Date() },
        });
        if (result.count === 0) {
          throw new JoinRequestAlreadyReviewedError();
        }
        return true;
      },
      () => ({
        locationId: existing.locationId,
        actorId: input.reviewedById,
        action: 'JOIN_DECLINED',
        entityType: 'JoinRequest',
        entityId: input.requestId,
        note: `Declined join request for ${existing.fullName}`,
      }),
    ).catch((err) => {
      if (err instanceof JoinRequestAlreadyReviewedError) return null;
      throw err;
    });
    if (!declined) return { result: 'already_reviewed' };
    return { result: 'ok', status: 'DECLINED' };
  }

  const jobTitle = input.jobTitle ?? null;
  const created = await withAuditedTransaction(
    prisma,
    async (tx) => {
      // A roster import adds everyone on the roster as staff with no phone. When that person
      // joins through the venue link, the request claims their record (and its shifts)
      // instead of creating a second one: on its own only for one exact full-name match with
      // nothing else close, otherwise only the record the manager chose (JoinLinkPlan).
      const imported = await tx.user.findMany({
        where: importedRecordWhere(existing.locationId),
        select: { id: true, fullName: true, role: { select: { name: true } } },
      });
      const plan = joinLinkPlan(existing.fullName, imported);
      if (!input.linkTo && plan.kind === 'choose') throw new LinkChoiceRequiredError(plan.candidates);
      const chosen = input.linkTo === 'new' ? null : input.linkTo || (plan.kind === 'link' ? plan.candidate.userId : null);
      let user: { id: string };
      if (chosen) {
        // Guarded write: only an imported, never-signed-in staff record of this venue, and only
        // if a concurrent approval hasn't just claimed it.
        const claim = await tx.user.updateMany({
          where: { id: chosen, ...importedRecordWhere(existing.locationId) },
          data: { phone: existing.phone, ...(jobTitle ? { jobTitle } : {}) },
        });
        if (claim.count === 0) throw new LinkTargetInvalidError();
        user = { id: chosen };
      } else {
        user = await tx.user.create({
          data: { locationId: existing.locationId, fullName: existing.fullName, phone: existing.phone, jobTitle },
        });
      }
      const claimed = !!chosen;
      // Same atomic guard as the decline branch above. If this loses the
      // race, throwing rolls back the `user.create` too, so a losing
      // approval never leaves an orphan User with no matching approved
      // request.
      const result = await tx.joinRequest.updateMany({
        where: { id: input.requestId, status: 'PENDING' },
        data: { status: 'APPROVED', reviewedById: input.reviewedById, reviewedAt: new Date(), createdUserId: user.id },
      });
      if (result.count === 0) {
        throw new JoinRequestAlreadyReviewedError();
      }
      return { id: user.id, claimed };
    },
    (user) => ({
      locationId: existing.locationId,
      actorId: input.reviewedById,
      action: 'JOIN_APPROVED',
      entityType: 'JoinRequest',
      entityId: input.requestId,
      note: `Approved join request for ${existing.fullName} — ${user.claimed ? 'linked to existing' : 'created'} User ${user.id}`,
    }),
  ).catch((err) => {
    if (err instanceof JoinRequestAlreadyReviewedError) return 'already_reviewed' as const;
    if (err instanceof LinkChoiceRequiredError) return { choose: err.candidates };
    if (err instanceof LinkTargetInvalidError) return 'link_target_invalid' as const;
    // `User.phone` is globally unique, deactivated users included; the insert itself is the race-safe check.
    if (isPhoneConflict(err)) return 'phone_taken' as const;
    throw err;
  });
  if (created === 'phone_taken') {
    // A concurrent approval of this same request collides on the phone too; that one is "already reviewed".
    const current = await prisma.joinRequest.findUnique({ where: { id: input.requestId }, select: { status: true } });
    return { result: current?.status === 'PENDING' ? 'phone_taken' : 'already_reviewed' };
  }
  if (created === 'already_reviewed' || created === 'link_target_invalid') return { result: created };
  if ('choose' in created) return { result: 'link_choice_required', candidates: created.choose };
  void notifyUser(created.id, {
    title: "You're in",
    body: `${existing.location.name} approved your request — welcome!`,
    url: '/my-shifts',
  });
  return { result: 'ok', status: 'APPROVED', userId: created.id, linked: created.claimed };
}
