import type { AssignmentPeriod, Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';

export const SECTION_ASSIGNMENT_INCLUDE = {
  staff: { select: { id: true, fullName: true } },
} as const;

export type SectionAssignmentWithStaff = Prisma.SectionAssignmentGetPayload<{
  include: typeof SECTION_ASSIGNMENT_INCLUDE;
}>;

/**
 * Raw upsert — exactly the `tx.sectionAssignment.upsert(...)` call
 * `routes/floorPlan.ts`'s `POST /assignments` made inline before this
 * extraction, including the conditional dutyLabel-touch semantics (see
 * that route's `hasDutyLabelKey` comment: a plain re-assign must not
 * clobber a label set earlier via inline edit). `touchDutyLabel` is that
 * same distinction, made explicit instead of re-derived from the
 * request body inside this function — the caller (route or voice) still
 * decides whether the label was explicitly supplied.
 *
 * Validation (section/staff existence, same-location membership) is the
 * CALLER's responsibility — same validate-in-caller split as
 * `shiftActions.ts` and the precedent `swapActions.ts`.
 */
export async function upsertSectionAssignment(
  input: {
    sectionId: string;
    staffId: string;
    shiftDate: Date;
    period: AssignmentPeriod;
    dutyLabel: string | null;
    createdById: string;
    touchDutyLabel: boolean;
  },
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SectionAssignmentWithStaff> {
  return client.sectionAssignment.upsert({
    where: {
      sectionId_staffId_shiftDate_period: {
        sectionId: input.sectionId,
        staffId: input.staffId,
        shiftDate: input.shiftDate,
        period: input.period,
      },
    },
    create: {
      sectionId: input.sectionId,
      staffId: input.staffId,
      shiftDate: input.shiftDate,
      period: input.period,
      dutyLabel: input.dutyLabel,
      createdById: input.createdById,
    },
    update: input.touchDutyLabel ? { dutyLabel: input.dutyLabel } : {},
    include: SECTION_ASSIGNMENT_INCLUDE,
  });
}
