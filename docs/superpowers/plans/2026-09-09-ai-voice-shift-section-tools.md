# AI Voice: Shift Create/Edit + Section Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend ShiftSync's existing voice pipeline with three manager-only intents (`CREATE_SHIFT`, `EDIT_SHIFT`, `ASSIGN_SECTION`), a confidence-threshold gate, a `VoiceInteractionLog` observability table, and audio-pipeline hardening (shorter cap, native noise suppression, vocabulary biasing).

**Architecture:** Same shape as the six shipped intents in `server/src/routes/voice.ts`: `/parse-intent` resolves a transcript into a schema-constrained intent via Gemini, `/execute` re-validates role/location/entity existence server-side and calls the same mutator the REST API uses, wrapped in `withAuditedTransaction`. New work extracts the shift-create/edit and section-assignment Prisma writes into `lib/actions/` (matching the existing `swapActions.ts`/`joinActions.ts` pattern: pure mutator, validation stays in each caller), adds these three intents to the schema/prompt/context, adds a self-reported `confidence` field with a threshold gate, and adds a `VoiceInteractionLog` table populated at parse- and execute-time.

**Tech Stack:** Express, Prisma/PostgreSQL, `@google/genai` (Gemini structured output), `node:test` + `node:assert/strict`, React 19, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-09-09-ai-voice-shift-section-tools-design.md`

## Global Constraints

- No wage/hourly/overtime logic anywhere in this feature — compensation is flat monthly salary (spec §3).
- Voice never writes to the DB directly — every mutation goes through the exact same mutator the REST UI uses (spec §1, §5).
- Role scoping is structural: `CREATE_SHIFT`/`EDIT_SHIFT`/`ASSIGN_SECTION` are added to `MANAGER_INTENTS` only, never `STAFF_INTENTS` — a STAFF session's Gemini schema never contains them (spec §6.1).
- `confidence` is required on every `ParsedIntent` variant except `UNRECOGNIZED`, both server-side (`intentSchema.ts`) and the client mirror (`src/api/voice.ts`) — gating must be uniform across old and new intents (spec §6.1).
- No behavior change to the existing REST routes (`shifts.ts`, `floorPlan.ts`) from the mutator extraction — pure mechanical extraction of the write call only, validation stays where it is today (spec §5).
- Existing tests (`shifts.test.ts`, `floorPlan.test.ts`, `voice.test.ts`'s current cases) must keep passing unmodified throughout.
- Transcription stays on Gemini — no new provider/dependency (spec §1).
- User-cancel on the confirm sheet is NOT logged to `VoiceInteractionLog` (spec §3).

---

## File Structure

**New files:**
- `server/src/lib/actions/shiftActions.ts` — `createShift`, `updateShift` mutators + `SHIFT_INCLUDE`/`ShiftWithRelations` shared type.
- `server/src/lib/actions/shiftActions.test.ts` — unit tests for the two mutators.
- `server/src/lib/actions/sectionActions.ts` — `upsertSectionAssignment` mutator.
- `server/src/lib/actions/sectionActions.test.ts` — unit test for the mutator.
- `server/src/voice/interactionLog.ts` — `logParsedInteraction`, `updateInteractionOutcome`.

**Modified files:**
- `prisma/schema.prisma` — add `VoiceInteractionLog` model + `VoiceInteractionOutcome` enum, plus relation fields on `Location`/`User`.
- `server/src/routes/shifts.ts` — POST `/` and PATCH `/:id` call the extracted mutators instead of inlining `tx.shift.create`/`.update`.
- `server/src/routes/floorPlan.ts` — POST `/assignments` calls the extracted mutator instead of inlining `tx.sectionAssignment.upsert`.
- `server/src/voice/intentSchema.ts` — add `confidence` to every variant, add the 3 new intents to `MANAGER_INTENTS` + the union + `schemaFor`.
- `server/src/voice/prompts.ts` — extend `PromptContext` with roles/weekShifts/floorSections, extend the prompt text.
- `server/src/voice/parseIntent.ts` — extend `buildContext` to fetch the new context fields (manager-tier only), add the confidence-threshold gate.
- `server/src/routes/voice.ts` — add 3 new `validateIntentShape` cases, 3 new `/execute` switch cases, wire `interactionLog` calls into `/parse-intent` and `/execute`.
- `src/api/voice.ts` — mirror `confidence`, the 3 new `ParsedIntent` variants, and `voiceLogId` threading.
- `src/components/shiftsync/AppShell.tsx` — store/thread `voiceLogId`, shorten recording cap, add noise-suppression constraints.
- `server/src/routes/voice.test.ts` — new integration test cases.

---

### Task 1: `VoiceInteractionLog` schema + migration

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma model `VoiceInteractionLog` with fields `id, locationId, actorId, transcript, resolvedIntent, confidence, outcome, declineReason, createdAt, updatedAt`; enum `VoiceInteractionOutcome` with values `PENDING_CONFIRMATION, LOW_CONFIDENCE, UNRECOGNIZED, EXECUTED, REJECTED_VALIDATION, REJECTED_PERMISSION, ERROR`. Both consumed by Task 8/9.

- [ ] **Step 1: Add the enum and model to `prisma/schema.prisma`**

Add near the other voice-adjacent models (after the `AuditLog` model, around line 313):

```prisma
enum VoiceInteractionOutcome {
  PENDING_CONFIRMATION
  LOW_CONFIDENCE
  UNRECOGNIZED
  EXECUTED
  REJECTED_VALIDATION
  REJECTED_PERMISSION
  ERROR
}

model VoiceInteractionLog {
  id             String                  @id @default(cuid())
  locationId     String                  @map("location_id")
  actorId        String                  @map("actor_id")
  transcript     String                  @db.Text
  resolvedIntent String                  @map("resolved_intent")
  confidence     Float?
  outcome        VoiceInteractionOutcome
  declineReason  String?                 @map("decline_reason") @db.Text
  createdAt      DateTime                @default(now()) @map("created_at")
  updatedAt      DateTime                @updatedAt @map("updated_at")

  location Location @relation(fields: [locationId], references: [id], onDelete: Cascade)
  actor    User     @relation(fields: [actorId], references: [id], onDelete: Cascade)

  @@index([locationId, createdAt])
  @@map("voice_interaction_logs")
}
```

- [ ] **Step 2: Add the relation fields on `Location` and `User`**

In `Location` (around line 48, next to `auditLogs`):
```prisma
  auditLogs             AuditLog[]
  voiceInteractionLogs  VoiceInteractionLog[]
```

In `User` (around line 134, next to `auditLogsActor`):
```prisma
  auditLogsActor          AuditLog[]                 @relation("AuditActor")
  voiceInteractionLogs    VoiceInteractionLog[]
```

- [ ] **Step 3: Generate and apply the migration**

Run: `npm run prisma:migrate -- --name add_voice_interaction_log`
Expected: a new folder under `prisma/migrations/` containing the `CREATE TABLE "voice_interaction_logs"` SQL, applied to the dev database with no errors, and `npm run prisma:generate` runs automatically as part of `migrate dev`.

- [ ] **Step 4: Verify the Prisma client picked up the new model**

Run: `npm run server:typecheck`
Expected: no errors (confirms `@prisma/client`'s generated types now include `VoiceInteractionLog`/`VoiceInteractionOutcome`, even though nothing references them yet).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add VoiceInteractionLog table for voice observability"
```

---

### Task 2: Extract `createShift`/`updateShift` into `lib/actions/shiftActions.ts`

**Files:**
- Create: `server/src/lib/actions/shiftActions.ts`
- Create: `server/src/lib/actions/shiftActions.test.ts`
- Modify: `server/src/routes/shifts.ts:1-217`

**Interfaces:**
- Consumes: `prisma` from `../prisma.js`, `Prisma` type from `@prisma/client`.
- Produces: `SHIFT_INCLUDE` (const), `ShiftWithRelations` (type), `createShift(data: Prisma.ShiftCreateInput, client?: Prisma.TransactionClient | typeof prisma): Promise<ShiftWithRelations>`, `updateShift(id: string, data: Prisma.ShiftUpdateInput, client?: Prisma.TransactionClient | typeof prisma): Promise<ShiftWithRelations>`. Consumed by Task 3 (voice.ts execute) and this task's own route rewiring.

- [ ] **Step 1: Write `shiftActions.ts`**

```ts
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';

/**
 * The Prisma `include` every shift read/write uses. Moved here from
 * routes/shifts.ts so routes/voice.ts's CREATE_SHIFT/EDIT_SHIFT cases can
 * share it instead of redefining the shape.
 */
export const SHIFT_INCLUDE = {
  assignee: { select: { id: true, fullName: true } },
  role: { select: { id: true, name: true } },
} as const;

export type ShiftWithRelations = Prisma.ShiftGetPayload<{ include: typeof SHIFT_INCLUDE }>;

/**
 * Raw create — exactly the `tx.shift.create(...)` call
 * `routes/shifts.ts`'s `POST /` made inline before this extraction.
 * Validation (role/user existence, same-location membership, date/time
 * shape) is the CALLER's responsibility, not this function's — mirrors
 * `lib/actions/swapActions.ts`'s `createSwapRequest`, which is the
 * established precedent for this split in this codebase.
 */
export async function createShift(
  data: Prisma.ShiftCreateInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ShiftWithRelations> {
  return client.shift.create({ data, include: SHIFT_INCLUDE });
}

/** Raw update — exactly the `tx.shift.update(...)` call `PATCH /:id` made inline before this extraction. Same validate-in-caller split as `createShift`. */
export async function updateShift(
  id: string,
  data: Prisma.ShiftUpdateInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ShiftWithRelations> {
  return client.shift.update({ where: { id }, data, include: SHIFT_INCLUDE });
}
```

- [ ] **Step 2: Write `shiftActions.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createShift, updateShift, SHIFT_INCLUDE } from './shiftActions.js';

const prisma = new PrismaClient();

test('createShift creates a real Shift row with the shared SHIFT_INCLUDE shape', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data must exist to run this test');

  const shift = await createShift({
    location: { connect: { id: location!.id } },
    role: { connect: { id: role!.id } },
    date: new Date('2026-09-20T00:00:00.000Z'),
    startTime: new Date('2026-09-20T09:00:00.000Z'),
    endTime: new Date('2026-09-20T17:00:00.000Z'),
    breakMinutes: 30,
    sidework: [],
    status: 'DRAFT',
  });

  try {
    assert.ok(shift.id);
    assert.equal(shift.role.id, role!.id, 'the shared SHIFT_INCLUDE must eager-load role');
    assert.equal(shift.assignee, null);

    const updated = await updateShift(shift.id, { breakMinutes: 45 });
    assert.equal(updated.breakMinutes, 45);
  } finally {
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
  }
});
```

- [ ] **Step 3: Run the test to verify it fails (module doesn't exist yet is not the case — run to confirm the DB round-trip actually works)**

Run: `node --import tsx --test server/src/lib/actions/shiftActions.test.ts`
Expected: PASS (this is a straightforward extraction of already-working code, not new logic — the test is a regression guard, not a red/green TDD cycle).

- [ ] **Step 4: Rewire `routes/shifts.ts`'s POST `/` to call `createShift`**

Modify `server/src/routes/shifts.ts`. Add the import at the top:
```ts
import { createShift, updateShift, SHIFT_INCLUDE } from '../lib/actions/shiftActions.js';
```
Delete the local `const SHIFT_INCLUDE = {...} as const;` block (lines 46-49) — it's now imported.

Replace lines 140-148 (the `withAuditedTransaction` call inside POST `/`):
```ts
    const created = await withAuditedTransaction(
      prisma,
      (tx) =>
        createShift(
          { locationId, roleId, userId, createdById, date: new Date(`${date}T00:00:00.000Z`), startTime, endTime, breakMinutes, managerNotes: briefingNote, sidework, status: 'DRAFT' } as unknown as Parameters<typeof createShift>[0],
          tx,
        ),
      (shift) => ({ locationId, actorId: createdById, shiftId: shift.id, action: 'SHIFT_CREATED', entityType: 'Shift', entityId: shift.id }),
    );
```

The `as unknown as Parameters<typeof createShift>[0]` cast exists because the original inline code passed a flat `{ locationId, roleId, userId, ... }` object (Prisma's scalar-FK create shorthand), which is a valid `Prisma.ShiftCreateInput` at the Prisma-client runtime level but TypeScript's generated `ShiftCreateInput` type expects the `location: { connect: ... }` relation-object form for required relations. Rather than rewrite this route's existing object-construction to the verbose relation form (a bigger diff than this extraction should make), keep the flat shape and cast once at the call site — Prisma accepts both shapes identically at runtime (this is exactly what the original inline `tx.shift.create({ data: {...flat shape...} })` already did, uncast, because `data` there wasn't typed as `Prisma.ShiftCreateInput` explicitly).

- [ ] **Step 5: Rewire `routes/shifts.ts`'s PATCH `/:id` to call `updateShift`**

Replace line 209 (`(tx) => tx.shift.update({ where: { id }, data, include: SHIFT_INCLUDE }),`):
```ts
      (tx) => updateShift(id, data as Prisma.ShiftUpdateInput, tx),
```
Add `Prisma` to the existing `@prisma/client` type-only import at the top of the file (check whether `Prisma` is already imported; if not, add `import type { Prisma } from '@prisma/client';`).

- [ ] **Step 6: Run the existing REST route tests to confirm zero behavior change**

Run: `node --import tsx --test server/src/routes/shifts.test.ts`
Expected: PASS, identical to before the extraction.

- [ ] **Step 7: Typecheck**

Run: `npm run server:typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/lib/actions/shiftActions.ts server/src/lib/actions/shiftActions.test.ts server/src/routes/shifts.ts
git commit -m "refactor: extract shift create/update into lib/actions/shiftActions.ts"
```

---

### Task 3: Extract `upsertSectionAssignment` into `lib/actions/sectionActions.ts`

**Files:**
- Create: `server/src/lib/actions/sectionActions.ts`
- Create: `server/src/lib/actions/sectionActions.test.ts`
- Modify: `server/src/routes/floorPlan.ts:386-457`

**Interfaces:**
- Consumes: `prisma` from `../prisma.js`, `AssignmentPeriod` type from `@prisma/client`.
- Produces: `upsertSectionAssignment(data: { sectionId: string; staffId: string; shiftDate: Date; period: AssignmentPeriod; dutyLabel: string | null; createdById: string; touchDutyLabel: boolean }, client?): Promise<SectionAssignmentWithStaff>`. Consumed by Task 3's own route rewiring and Task 9 (voice execute).

- [ ] **Step 1: Write `sectionActions.ts`**

```ts
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
```

- [ ] **Step 2: Write `sectionActions.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { upsertSectionAssignment } from './sectionActions.js';

const prisma = new PrismaClient();

test('upsertSectionAssignment creates then re-assigns without clobbering an unset dutyLabel key', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const staff = await prisma.user.findFirst({ where: { locationId: location!.id } });
  const floorPlanImage = await prisma.floorPlanImage.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && staff && floorPlanImage, 'seed data (location, staff, floor plan image) must exist to run this test');

  const section = await prisma.floorSection.create({
    data: { locationId: location!.id, floorPlanImageId: floorPlanImage!.id, label: '__task3-test__ section', polygon: [], paxCapacity: 4 },
  });
  const shiftDate = new Date('2026-09-21T00:00:00.000Z');

  try {
    const created = await upsertSectionAssignment({
      sectionId: section.id, staffId: staff!.id, shiftDate, period: 'AM', dutyLabel: 'Host', createdById: staff!.id, touchDutyLabel: true,
    });
    assert.equal(created.dutyLabel, 'Host');

    const reassigned = await upsertSectionAssignment({
      sectionId: section.id, staffId: staff!.id, shiftDate, period: 'AM', dutyLabel: null, createdById: staff!.id, touchDutyLabel: false,
    });
    assert.equal(reassigned.id, created.id, 'same compound key must upsert the same row');
    assert.equal(reassigned.dutyLabel, 'Host', 'touchDutyLabel:false must not clobber the existing label');
  } finally {
    await prisma.sectionAssignment.deleteMany({ where: { sectionId: section.id } });
    await prisma.floorSection.delete({ where: { id: section.id } }).catch(() => {});
  }
});
```

- [ ] **Step 3: Run the test**

Run: `node --import tsx --test server/src/lib/actions/sectionActions.test.ts`
Expected: PASS.

- [ ] **Step 4: Rewire `routes/floorPlan.ts`'s POST `/assignments`**

Add the import at the top:
```ts
import { upsertSectionAssignment } from '../lib/actions/sectionActions.js';
```

Replace lines 419-430 (the `withAuditedTransaction`'s `tx.sectionAssignment.upsert(...)` call):
```ts
    const assignment = await withAuditedTransaction(
      prisma,
      (tx) =>
        upsertSectionAssignment(
          { sectionId, staffId, shiftDate, period: period as 'AM' | 'PM', dutyLabel, createdById, touchDutyLabel: hasDutyLabelKey },
          tx,
        ),
```
(Keep the existing `(upserted) => ({...})` audit-entry callback below it unchanged.)

- [ ] **Step 5: Run the existing REST route tests**

Run: `node --import tsx --test server/src/routes/floorPlan.test.ts`
Expected: PASS, identical to before.

- [ ] **Step 6: Typecheck**

Run: `npm run server:typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/actions/sectionActions.ts server/src/lib/actions/sectionActions.test.ts server/src/routes/floorPlan.ts
git commit -m "refactor: extract section-assignment upsert into lib/actions/sectionActions.ts"
```

---

### Task 4: Add `confidence` to every `ParsedIntent` variant + the 3 new intents to `intentSchema.ts`

**Files:**
- Modify: `server/src/voice/intentSchema.ts`
- Modify: `src/api/voice.ts:22-29`

**Interfaces:**
- Produces: `MANAGER_INTENTS` now includes `'CREATE_SHIFT' | 'EDIT_SHIFT' | 'ASSIGN_SECTION'`; `ParsedIntent` union's non-`UNRECOGNIZED` variants all require `confidence: number`. Consumed by Task 5 (prompts), Task 6 (parseIntent gate), Task 9 (voice.ts execute), Task 10 (frontend).

- [ ] **Step 1: Update `server/src/voice/intentSchema.ts`**

```ts
import type { SystemRole } from '@prisma/client';
import { Type } from '@google/genai';

export const STAFF_INTENTS = ['MARK_AVAILABILITY', 'REQUEST_SWAP'] as const;

export const MANAGER_INTENTS = [
  ...STAFF_INTENTS,
  'APPROVE_SWAP',
  'DECLINE_SWAP',
  'APPROVE_JOIN',
  'DECLINE_JOIN',
  'CREATE_SHIFT',
  'EDIT_SHIFT',
  'ASSIGN_SECTION',
] as const;

export type StaffIntentType = (typeof STAFF_INTENTS)[number];
export type ManagerIntentType = (typeof MANAGER_INTENTS)[number];
export type IntentType = ManagerIntentType;

export type ParsedIntent =
  | { intent: 'MARK_AVAILABILITY'; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; confidence: number; summary: string }
  | { intent: 'REQUEST_SWAP'; shiftId: string; targetUserId: string; targetUserName: string; reason: string | null; confidence: number; summary: string }
  | { intent: 'APPROVE_SWAP'; swapRequestId: string; confidence: number; summary: string }
  | { intent: 'DECLINE_SWAP'; swapRequestId: string; confidence: number; summary: string }
  | { intent: 'APPROVE_JOIN'; joinRequestId: string; confidence: number; summary: string }
  | { intent: 'DECLINE_JOIN'; joinRequestId: string; confidence: number; summary: string }
  | { intent: 'CREATE_SHIFT'; roleId: string; date: string; start: string; end: string; userId: string | null; confidence: number; summary: string }
  | { intent: 'EDIT_SHIFT'; shiftId: string; roleId?: string; date?: string; start?: string; end?: string; userId?: string | null; confidence: number; summary: string }
  | { intent: 'ASSIGN_SECTION'; sectionId: string; staffId: string; shiftDate: string; period: 'AM' | 'PM'; dutyLabel: string | null; confidence: number; summary: string }
  | { intent: 'UNRECOGNIZED'; reason: string; summary: string };

function schemaFor(intents: readonly string[]) {
  return {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING, enum: [...intents, 'UNRECOGNIZED'] },
      date: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD, for MARK_AVAILABILITY/CREATE_SHIFT/EDIT_SHIFT' },
      availabilityType: { type: Type.STRING, enum: ['UNAVAILABLE', 'PREFERRED_OFF'], nullable: true },
      shiftId: { type: Type.STRING, nullable: true, description: 'For REQUEST_SWAP/EDIT_SHIFT — one of the ids in the provided shift list' },
      targetUserId: { type: Type.STRING, nullable: true, description: 'For REQUEST_SWAP — one of the ids in the provided staff list' },
      targetUserName: { type: Type.STRING, nullable: true },
      reason: { type: Type.STRING, nullable: true },
      swapRequestId: { type: Type.STRING, nullable: true, description: 'For APPROVE_SWAP/DECLINE_SWAP — one of the ids in the provided pending-swaps list' },
      joinRequestId: { type: Type.STRING, nullable: true, description: 'For APPROVE_JOIN/DECLINE_JOIN — one of the ids in the provided pending-joins list' },
      roleId: { type: Type.STRING, nullable: true, description: 'For CREATE_SHIFT/EDIT_SHIFT — one of the ids in the provided roles list' },
      userId: { type: Type.STRING, nullable: true, description: 'For CREATE_SHIFT/EDIT_SHIFT — one of the ids in the provided staff list, or null for an open/unassigned shift' },
      start: { type: Type.STRING, nullable: true, description: 'HH:MM, for CREATE_SHIFT/EDIT_SHIFT' },
      end: { type: Type.STRING, nullable: true, description: 'HH:MM, for CREATE_SHIFT/EDIT_SHIFT' },
      sectionId: { type: Type.STRING, nullable: true, description: 'For ASSIGN_SECTION — one of the ids in the provided floor sections list' },
      staffId: { type: Type.STRING, nullable: true, description: 'For ASSIGN_SECTION — one of the ids in the provided staff list' },
      shiftDate: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD, for ASSIGN_SECTION' },
      period: { type: Type.STRING, enum: ['AM', 'PM'], nullable: true, description: 'For ASSIGN_SECTION' },
      dutyLabel: { type: Type.STRING, nullable: true, description: 'For ASSIGN_SECTION — optional free-text duty note' },
      confidence: { type: Type.NUMBER, nullable: true, description: 'How certain you are (0 to 1) that every id/date/time above is correct and unambiguous. Required for every intent except UNRECOGNIZED.' },
      summary: { type: Type.STRING, description: 'One plain-English sentence describing exactly what will happen, for the confirm step' },
      unrecognizedReason: { type: Type.STRING, nullable: true, description: 'Only for intent=UNRECOGNIZED — why this could not be resolved' },
    },
    required: ['intent', 'summary'],
  };
}

const STAFF_SCHEMA = schemaFor(STAFF_INTENTS);
const MANAGER_SCHEMA = schemaFor(MANAGER_INTENTS);

export function intentSchemaFor(systemRole: SystemRole) {
  return systemRole === 'STAFF' ? STAFF_SCHEMA : MANAGER_SCHEMA;
}

export function allowedIntentsFor(systemRole: SystemRole): readonly string[] {
  return systemRole === 'STAFF' ? STAFF_INTENTS : MANAGER_INTENTS;
}
```

Note: `confidence` stays `nullable: true` at the Gemini-schema level (Gemini's structured-output mode does not support conditionally-required-per-enum-value fields), but `normalizeParsedIntent` in Task 6 treats a missing/non-numeric `confidence` on any non-UNRECOGNIZED intent as `0` — i.e. fails closed to "always clarify" rather than silently trusting an absent score. `required: ['intent', 'summary']` is intentionally NOT changed to include `confidence` for this same reason.

- [ ] **Step 2: Mirror the same union in `src/api/voice.ts`**

Replace lines 22-29:
```ts
export type ParsedIntent =
  | { intent: 'MARK_AVAILABILITY'; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; confidence: number; summary: string }
  | { intent: 'REQUEST_SWAP'; shiftId: string; targetUserId: string; targetUserName: string; reason: string | null; confidence: number; summary: string }
  | { intent: 'APPROVE_SWAP'; swapRequestId: string; confidence: number; summary: string }
  | { intent: 'DECLINE_SWAP'; swapRequestId: string; confidence: number; summary: string }
  | { intent: 'APPROVE_JOIN'; joinRequestId: string; confidence: number; summary: string }
  | { intent: 'DECLINE_JOIN'; joinRequestId: string; confidence: number; summary: string }
  | { intent: 'CREATE_SHIFT'; roleId: string; date: string; start: string; end: string; userId: string | null; confidence: number; summary: string }
  | { intent: 'EDIT_SHIFT'; shiftId: string; roleId?: string; date?: string; start?: string; end?: string; userId?: string | null; confidence: number; summary: string }
  | { intent: 'ASSIGN_SECTION'; sectionId: string; staffId: string; shiftDate: string; period: 'AM' | 'PM'; dutyLabel: string | null; confidence: number; summary: string }
  | { intent: 'UNRECOGNIZED'; reason: string; summary: string };
```

- [ ] **Step 3: Typecheck both halves**

Run: `npm run server:typecheck && npm run typecheck`
Expected: errors in `parseIntent.ts`'s `normalizeParsedIntent` (missing `confidence` on the returned object) and in `routes/voice.ts` (switch cases not yet exhaustive) — this is expected; Tasks 5–9 fix these. Confirm the errors are ONLY in those two files, nothing else broke.

- [ ] **Step 4: Commit**

```bash
git add server/src/voice/intentSchema.ts src/api/voice.ts
git commit -m "feat(voice): add confidence field + CREATE_SHIFT/EDIT_SHIFT/ASSIGN_SECTION to the intent schema"
```

---

### Task 5: Extend `PromptContext` + `buildSystemPrompt` with roles/shifts/sections

**Files:**
- Modify: `server/src/voice/prompts.ts`

**Interfaces:**
- Consumes: nothing new (pure additive to existing `PromptContext`).
- Produces: `PromptContext` gains `roles?`, `weekShifts?`, `floorSections?`. Consumed by Task 6 (`buildContext` populates them).

- [ ] **Step 1: Extend `PromptContext` and `buildSystemPrompt`**

```ts
import type { SystemRole } from '@prisma/client';
import { allowedIntentsFor } from './intentSchema.js';

export interface PromptContext {
  today: string;
  callerName: string;
  callerShifts: { id: string; date: string; startTime: string; endTime: string }[];
  staffDirectory: { id: string; fullName: string }[];
  pendingSwapRequests?: { id: string; requesterName: string; shiftLabel: string }[];
  pendingJoinRequests?: { id: string; fullName: string; phone: string }[];
  /** Manager-tier only — every role at this venue, for CREATE_SHIFT/EDIT_SHIFT. */
  roles?: { id: string; name: string }[];
  /** Manager-tier only — every shift at this venue from today through +7 days, for EDIT_SHIFT/ASSIGN_SECTION reference. */
  weekShifts?: { id: string; roleName: string; date: string; start: string; end: string; assigneeName: string | null }[];
  /** Manager-tier only — every floor section at this venue, for ASSIGN_SECTION. */
  floorSections?: { id: string; label: string }[];
}

export function buildSystemPrompt(systemRole: SystemRole, ctx: PromptContext): string {
  const allowed = allowedIntentsFor(systemRole);
  const lines = [
    `You are ShiftSync's voice command interpreter for a hospitality venue in the UAE. Today is ${ctx.today}. The caller is ${ctx.callerName}, whose account role is ${systemRole}.`,
    ``,
    `You may ONLY ever respond with one of these intents: ${allowed.join(', ')}, or UNRECOGNIZED if none of them confidently match what was said. Never invent an intent outside this list — the caller's role does not permit anything else, and any other intent will be rejected by the server regardless of what you output.`,
    ``,
    `Known staff at this venue (name → id, use these ids, never invent one):`,
    ...ctx.staffDirectory.map((s) => `- ${s.fullName} → ${s.id}`),
  ];

  if (allowed.includes('REQUEST_SWAP')) {
    lines.push(``, `The caller's own upcoming shifts (id → date, time):`);
    lines.push(...ctx.callerShifts.map((s) => `- ${s.id} → ${s.date}, ${s.startTime}-${s.endTime}`));
  }

  if (ctx.pendingSwapRequests?.length) {
    lines.push(``, `Pending swap requests this caller could approve or decline (id → who requested, which shift):`);
    lines.push(...ctx.pendingSwapRequests.map((r) => `- ${r.id} → ${r.requesterName}, ${r.shiftLabel}`));
  }

  if (ctx.pendingJoinRequests?.length) {
    lines.push(``, `Pending join requests this caller could approve or decline (id → name, phone):`);
    lines.push(...ctx.pendingJoinRequests.map((r) => `- ${r.id} → ${r.fullName}, ${r.phone}`));
  }

  if (ctx.roles?.length) {
    lines.push(``, `Roles at this venue (name → id, for CREATE_SHIFT/EDIT_SHIFT — use these ids, never invent one):`);
    lines.push(...ctx.roles.map((r) => `- ${r.name} → ${r.id}`));
  }

  if (ctx.weekShifts?.length) {
    lines.push(``, `This venue's shifts, today through the next 7 days (id → role, date, time, who's assigned or "open" — for EDIT_SHIFT/ASSIGN_SECTION reference):`);
    lines.push(...ctx.weekShifts.map((s) => `- ${s.id} → ${s.roleName}, ${s.date} ${s.start}-${s.end}, ${s.assigneeName ?? 'open'}`));
  }

  if (ctx.floorSections?.length) {
    lines.push(``, `Floor sections at this venue (name → id, for ASSIGN_SECTION — use these ids, never invent one):`);
    lines.push(...ctx.floorSections.map((s) => `- ${s.label} → ${s.id}`));
  }

  lines.push(
    ``,
    `If a name, date, time, role, shift, or section is ambiguous or you cannot find a confident match in the lists above, respond with intent=UNRECOGNIZED and explain why in unrecognizedReason — never guess an id that isn't listed above, and never invent a date or time.`,
    `Always fill in "summary" with one plain-English sentence describing exactly what will happen if this is confirmed, e.g. "Mark you unavailable on Friday, August 29th", "Approve Sarah's swap request for her Tuesday shift", "Create a Bartender shift for Ahmed, Friday 6pm-2am", or "Move Ahmed to the Bar section, Friday PM."`,
    `Always fill in "confidence" (0 to 1) with how certain you are that this exactly matches what the caller asked for and that every id/date/time you filled in is correct — lower it whenever a name, date, or time was even slightly ambiguous before you resolved it.`,
  );

  return lines.join('\n');
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run server:typecheck`
Expected: no new errors introduced by this file (the `buildContext` gap from Task 4 remains until Task 6).

- [ ] **Step 3: Commit**

```bash
git add server/src/voice/prompts.ts
git commit -m "feat(voice): extend prompt context with roles/shifts/sections for manager callers"
```

---

### Task 6: `buildContext` fetches the new fields + confidence-threshold gate in `parseIntent.ts`

**Files:**
- Modify: `server/src/voice/parseIntent.ts`

**Interfaces:**
- Consumes: `PromptContext` (Task 5), `MANAGER_INTENTS`/`ParsedIntent` (Task 4).
- Produces: `parseVoiceIntent` now returns intents with `confidence` populated, and coerces low-confidence real intents to `UNRECOGNIZED`-shaped output. Also produces `LAST_ATTEMPTED_INTENT` info needed by Task 8's logging — see Step 3's `attemptedIntent` return addition.

- [ ] **Step 1: Extend `buildContext`**

In `buildContext`, after the existing `if (user.systemRole !== 'STAFF') { ... }` block that populates `pendingSwapRequests`/`pendingJoinRequests` (still inside that same `if`), add:

```ts
    const roles = await prisma.role.findMany({ where: { locationId: user.locationId }, select: { id: true, name: true } });
    ctx.roles = roles;

    const sections = await prisma.floorSection.findMany({ where: { locationId: user.locationId }, select: { id: true, label: true } });
    ctx.floorSections = sections;

    const weekEnd = new Date(startOfToday);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
    const venueShifts = await prisma.shift.findMany({
      where: { locationId: user.locationId, date: { gte: startOfToday, lt: weekEnd } },
      include: { role: { select: { name: true } }, assignee: { select: { fullName: true } } },
      orderBy: { date: 'asc' },
      take: 200,
    });
    ctx.weekShifts = venueShifts.map((s) => ({
      id: s.id,
      roleName: s.role.name,
      date: s.date.toISOString().slice(0, 10),
      start: formatVenueTime(s.startTime, timezone),
      end: formatVenueTime(s.endTime, timezone),
      assigneeName: s.assignee?.fullName ?? null,
    }));
```

(`startOfToday` and `timezone` are already in scope from the existing function body above this block.)

- [ ] **Step 2: Add the confidence threshold constant and gate**

Near the top of `parseIntent.ts`, after the imports:
```ts
/**
 * Below this, a real (non-UNRECOGNIZED) intent is coerced to an
 * UNRECOGNIZED-shaped response before it reaches the client — the model
 * attempted a match but wasn't confident enough to execute unattended.
 * The ORIGINAL attempted intent/confidence is still what gets logged
 * (see routes/voice.ts's /parse-intent handler + interactionLog.ts) —
 * only the client-facing response is coerced.
 */
export const CONFIDENCE_THRESHOLD = 0.6;
```

- [ ] **Step 3: Change `parseVoiceIntent`'s return type and apply the gate**

`parseVoiceIntent` currently returns `Promise<ParsedIntent>`. Change its return type to a small wrapper so the caller (routes/voice.ts, Task 8) can log the real attempted intent even when the response is coerced:

```ts
export interface VoiceIntentResolution {
  /** What the client should see/act on — coerced to UNRECOGNIZED if below CONFIDENCE_THRESHOLD. */
  response: ParsedIntent;
  /** What the model actually returned, uncoerced — always logged as-is. */
  attempted: ParsedIntent;
}
```

Change the function signature to `export async function parseVoiceIntent(...): Promise<VoiceIntentResolution>` and replace its final two lines (`const raw = JSON.parse(...); return normalizeParsedIntent(raw);`) with:

```ts
    const raw = JSON.parse(response.text ?? '{}');
    const attempted = normalizeParsedIntent(raw);
    if (attempted.intent === 'UNRECOGNIZED' || attempted.confidence >= CONFIDENCE_THRESHOLD) {
      return { response: attempted, attempted };
    }
    return {
      response: { intent: 'UNRECOGNIZED', reason: `I understood this as "${attempted.summary}" but wasn't confident enough to act on it without you rephrasing.`, summary: 'Could not confidently resolve this command.' },
      attempted,
    };
```

- [ ] **Step 4: Update `normalizeParsedIntent` to fail closed on a missing/invalid confidence and cover the 3 new intents**

Replace the whole function:

```ts
function normalizeParsedIntent(raw: Record<string, unknown>): ParsedIntent {
  const intent = typeof raw.intent === 'string' ? raw.intent : 'UNRECOGNIZED';
  const summary = typeof raw.summary === 'string' ? raw.summary : 'Could not determine what to do.';
  // A missing/non-numeric/out-of-range confidence fails CLOSED to 0 — an
  // absent score must never be treated as "the model was certain."
  const rawConfidence = raw.confidence;
  const confidence = typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : 0;

  switch (intent) {
    case 'MARK_AVAILABILITY':
      if (typeof raw.date === 'string' && (raw.availabilityType === 'UNAVAILABLE' || raw.availabilityType === 'PREFERRED_OFF')) {
        return { intent: 'MARK_AVAILABILITY', date: raw.date, type: raw.availabilityType, confidence, summary };
      }
      break;
    case 'REQUEST_SWAP':
      if (typeof raw.shiftId === 'string' && typeof raw.targetUserId === 'string') {
        return {
          intent: 'REQUEST_SWAP',
          shiftId: raw.shiftId,
          targetUserId: raw.targetUserId,
          targetUserName: typeof raw.targetUserName === 'string' ? raw.targetUserName : '',
          reason: typeof raw.reason === 'string' ? raw.reason : null,
          confidence,
          summary,
        };
      }
      break;
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      if (typeof raw.swapRequestId === 'string') {
        return { intent, swapRequestId: raw.swapRequestId, confidence, summary };
      }
      break;
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN':
      if (typeof raw.joinRequestId === 'string') {
        return { intent, joinRequestId: raw.joinRequestId, confidence, summary };
      }
      break;
    case 'CREATE_SHIFT':
      if (typeof raw.roleId === 'string' && typeof raw.date === 'string' && typeof raw.start === 'string' && typeof raw.end === 'string') {
        return {
          intent: 'CREATE_SHIFT',
          roleId: raw.roleId,
          date: raw.date,
          start: raw.start,
          end: raw.end,
          userId: typeof raw.userId === 'string' ? raw.userId : null,
          confidence,
          summary,
        };
      }
      break;
    case 'EDIT_SHIFT':
      if (typeof raw.shiftId === 'string') {
        return {
          intent: 'EDIT_SHIFT',
          shiftId: raw.shiftId,
          roleId: typeof raw.roleId === 'string' ? raw.roleId : undefined,
          date: typeof raw.date === 'string' ? raw.date : undefined,
          start: typeof raw.start === 'string' ? raw.start : undefined,
          end: typeof raw.end === 'string' ? raw.end : undefined,
          userId: typeof raw.userId === 'string' || raw.userId === null ? raw.userId : undefined,
          confidence,
          summary,
        };
      }
      break;
    case 'ASSIGN_SECTION':
      if (typeof raw.sectionId === 'string' && typeof raw.staffId === 'string' && typeof raw.shiftDate === 'string' && (raw.period === 'AM' || raw.period === 'PM')) {
        return {
          intent: 'ASSIGN_SECTION',
          sectionId: raw.sectionId,
          staffId: raw.staffId,
          shiftDate: raw.shiftDate,
          period: raw.period,
          dutyLabel: typeof raw.dutyLabel === 'string' ? raw.dutyLabel : null,
          confidence,
          summary,
        };
      }
      break;
  }
  return {
    intent: 'UNRECOGNIZED',
    reason: typeof raw.unrecognizedReason === 'string' ? raw.unrecognizedReason : 'Could not confidently match this to a supported command.',
    summary,
  };
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run server:typecheck`
Expected: a new error in `routes/voice.ts`'s `/parse-intent` handler (it still expects `parseVoiceIntent` to return a bare `ParsedIntent`, not `VoiceIntentResolution`) — expected, fixed in Task 8.

- [ ] **Step 6: Commit**

```bash
git add server/src/voice/parseIntent.ts
git commit -m "feat(voice): add confidence-threshold gate to parseVoiceIntent"
```

---

### Task 7: `interactionLog.ts` helper

**Files:**
- Create: `server/src/voice/interactionLog.ts`

**Interfaces:**
- Consumes: `prisma` from `../lib/prisma.js`, `VoiceInteractionOutcome` from `@prisma/client` (Task 1), `ParsedIntent` from `./intentSchema.js`.
- Produces: `logParsedInteraction(user, transcript, resolution): Promise<string>` (returns the new row's id), `updateInteractionOutcome(logId, outcome, declineReason?): Promise<void>`. Consumed by Task 8.

- [ ] **Step 1: Write `interactionLog.ts`**

```ts
import type { VoiceInteractionOutcome } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { ParsedIntent } from './intentSchema.js';
import type { VoiceIntentResolution } from './parseIntent.js';

/**
 * Classifies a fresh parse result into its at-parse-time outcome —
 * EXECUTED/REJECTED_* only happen later, at /execute (see
 * updateInteractionOutcome below).
 */
function outcomeAtParseTime(resolution: VoiceIntentResolution): VoiceInteractionOutcome {
  if (resolution.attempted.intent === 'UNRECOGNIZED') return 'UNRECOGNIZED';
  if (resolution.response.intent === 'UNRECOGNIZED') return 'LOW_CONFIDENCE';
  return 'PENDING_CONFIRMATION';
}

/**
 * Writes one row per /parse-intent call — every real attempt, regardless
 * of outcome. Called AFTER parseVoiceIntent resolves successfully (a
 * VoiceIntentError from the Gemini call itself is never logged here — see
 * routes/voice.ts's /parse-intent handler, which only calls this on the
 * success path). Returns the row's id so the client can round-trip it
 * back on /execute.
 */
export async function logParsedInteraction(
  user: { id: string; locationId: string },
  transcript: string,
  resolution: VoiceIntentResolution,
): Promise<string> {
  const attempted = resolution.attempted as ParsedIntent;
  const confidence = attempted.intent === 'UNRECOGNIZED' ? null : attempted.confidence;
  const row = await prisma.voiceInteractionLog.create({
    data: {
      locationId: user.locationId,
      actorId: user.id,
      transcript,
      resolvedIntent: attempted.intent,
      confidence,
      outcome: outcomeAtParseTime(resolution),
    },
    select: { id: true },
  });
  return row.id;
}

/** Called from /execute right before its response is sent, to record the final outcome of a PENDING_CONFIRMATION row. */
export async function updateInteractionOutcome(
  logId: string,
  outcome: VoiceInteractionOutcome,
  declineReason?: string,
): Promise<void> {
  await prisma.voiceInteractionLog.update({
    where: { id: logId },
    data: { outcome, declineReason: declineReason ?? null },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run server:typecheck`
Expected: no errors in this new file (it may still show the pending Task 8 error in `routes/voice.ts`, unrelated to this file).

- [ ] **Step 3: Commit**

```bash
git add server/src/voice/interactionLog.ts
git commit -m "feat(voice): add VoiceInteractionLog read/write helpers"
```

---

### Task 8: Wire logging + confidence resolution into `/parse-intent`

**Files:**
- Modify: `server/src/routes/voice.ts` (the `/parse-intent` handler only — `/execute` is Task 9)

**Interfaces:**
- Consumes: `parseVoiceIntent` returning `VoiceIntentResolution` (Task 6), `logParsedInteraction` (Task 7).
- Produces: `/api/voice/parse-intent` response gains `voiceLogId: string`. Consumed by Task 10 (frontend) and Task 9 (`/execute` accepting it back).

- [ ] **Step 1: Update the import and the handler**

Add to the imports:
```ts
import { logParsedInteraction } from '../voice/interactionLog.js';
```

Replace the `/parse-intent` handler body:
```ts
voiceRouter.post('/parse-intent', requireSession, parseIntentRateLimiter, async (req, res) => {
  try {
    const transcript = String(req.body?.transcript ?? '').trim();
    if (!transcript) return res.status(400).json({ error: 'transcript is required.' });

    const resolution = await parseVoiceIntent(transcript, {
      id: req.user!.id,
      systemRole: req.user!.systemRole,
      fullName: req.user!.fullName,
      locationId: req.user!.locationId,
    });
    const voiceLogId = await logParsedInteraction({ id: req.user!.id, locationId: req.user!.locationId }, transcript, resolution);
    return res.status(200).json({ transcript, intent: resolution.response, voiceLogId });
  } catch (err) {
    if (err instanceof VoiceIntentError) {
      console.error('[voice.parseIntent] unavailable', err);
      return res.status(503).json({ error: VOICE_UNAVAILABLE });
    }
    console.error('[voice.parseIntent] failed', err);
    return res.status(500).json({ error: 'Unexpected error while parsing the voice command.' });
  }
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run server:typecheck`
Expected: `/execute`'s `ALL_INTENTS`/`validateIntentShape`/switch still don't know about the 3 new intents — those errors remain until Task 9. No error should remain specifically about `/parse-intent` or `parseVoiceIntent`'s return type.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/voice.ts
git commit -m "feat(voice): log every parsed interaction, return voiceLogId from /parse-intent"
```

---

### Task 9: `/execute` — 3 new cases, shape validation, outcome logging

**Files:**
- Modify: `server/src/routes/voice.ts` (`validateIntentShape` + `/execute` handler)

**Interfaces:**
- Consumes: `createShift`/`updateShift` (Task 2), `upsertSectionAssignment` (Task 3), `updateInteractionOutcome` (Task 7), `formatVenueTime`/`venueTimezoneFor` (existing `lib/venueTime.js`), `combineDateAndTime` (existing `parsing/normalize.js`).
- Produces: `/api/voice/execute` handles `CREATE_SHIFT`, `EDIT_SHIFT`, `ASSIGN_SECTION`; accepts optional `voiceLogId` in the request body.

- [ ] **Step 1: Add imports**

```ts
import { createShift, updateShift } from '../lib/actions/shiftActions.js';
import { upsertSectionAssignment } from '../lib/actions/sectionActions.js';
import { updateInteractionOutcome } from '../voice/interactionLog.js';
import { combineDateAndTime } from '../parsing/normalize.js';
import { formatVenueTime, venueTimezoneFor } from '../lib/venueTime.js';
```

(`routes/voice.ts` did not previously import `formatVenueTime` — the six existing intents never needed to render a stored time back out. `EDIT_SHIFT`'s partial-update logic does, exactly like `routes/shifts.ts`'s `PATCH /:id` already does.)

- [ ] **Step 2: Add the 3 new `validateIntentShape` cases**

Insert before the existing `case 'UNRECOGNIZED':` line:
```ts
    case 'CREATE_SHIFT': {
      if (!isNonEmptyString(intent.roleId)) return 'roleId is required.';
      if (!DATE_RE.test(intent.date)) return 'date must be YYYY-MM-DD.';
      const d = new Date(`${intent.date}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== intent.date) {
        return 'date must be a real calendar date (YYYY-MM-DD).';
      }
      if (!TIME_RE.test(intent.start) || !TIME_RE.test(intent.end)) return 'start/end must be HH:MM.';
      return null;
    }
    case 'EDIT_SHIFT': {
      if (!isNonEmptyString(intent.shiftId)) return 'shiftId is required.';
      if (intent.date !== undefined && !DATE_RE.test(intent.date)) return 'date must be YYYY-MM-DD.';
      if (intent.start !== undefined && !TIME_RE.test(intent.start)) return 'start must be HH:MM.';
      if (intent.end !== undefined && !TIME_RE.test(intent.end)) return 'end must be HH:MM.';
      return null;
    }
    case 'ASSIGN_SECTION': {
      if (!isNonEmptyString(intent.sectionId)) return 'sectionId is required.';
      if (!isNonEmptyString(intent.staffId)) return 'staffId is required.';
      if (!DATE_RE.test(intent.shiftDate)) return 'shiftDate must be YYYY-MM-DD.';
      if (intent.period !== 'AM' && intent.period !== 'PM') return 'period must be "AM" or "PM".';
      return null;
    }
```

Add the new `TIME_RE` constant next to the existing `DATE_RE`:
```ts
const TIME_RE = /^\d{2}:\d{2}$/;
```

- [ ] **Step 3: Replace the entire `/execute` handler**

The outcome-logging wrapper touches every return site in this handler (guard clauses, all six existing intent branches, the catch block), not just the three new cases — so rather than describing the edit in prose, here is the complete replacement body for `voiceRouter.post('/execute', ...)`, including the three new cases:

```ts
voiceRouter.post('/execute', requireSession, async (req, res) => {
  const transcript = String(req.body?.transcript ?? '');
  const intent = req.body?.intent as ParsedIntent | undefined;
  const voiceLogId = typeof req.body?.voiceLogId === 'string' ? req.body.voiceLogId : null;

  /**
   * Every response path in this handler routes through here so
   * VoiceInteractionLog's outcome always reflects what actually happened —
   * a caller that never sent a voiceLogId (a hand-crafted request) still
   * gets the normal response, just with no log row to update.
   */
  const respond = async (
    status: number,
    body: Record<string, unknown>,
    outcome: 'EXECUTED' | 'REJECTED_VALIDATION' | 'REJECTED_PERMISSION' | 'ERROR',
    declineReason?: string,
  ) => {
    if (voiceLogId) {
      await updateInteractionOutcome(voiceLogId, outcome, declineReason).catch((err) =>
        console.error('[voice.execute] failed to update interaction log', err),
      );
    }
    return res.status(status).json(body);
  };

  try {
    if (!intent || typeof intent.intent !== 'string') {
      return respond(400, { error: 'A parsed intent is required.' }, 'REJECTED_VALIDATION', 'A parsed intent is required.');
    }

    if (!ALL_INTENTS.includes(intent.intent)) {
      const msg = `"${intent.intent}" is not a recognized voice command.`;
      return respond(400, { error: msg }, 'REJECTED_VALIDATION', msg);
    }

    const allowed = allowedIntentsFor(req.user!.systemRole);
    if (intent.intent !== 'UNRECOGNIZED' && !allowed.includes(intent.intent as (typeof allowed)[number])) {
      const msg = `Your role does not permit the "${intent.intent}" action.`;
      return respond(403, { error: msg }, 'REJECTED_PERMISSION', msg);
    }

    const shapeError = validateIntentShape(intent);
    if (shapeError) return respond(400, { error: shapeError }, 'REJECTED_VALIDATION', shapeError);

    const note = `[voice] "${transcript}"`;
    const actorId = req.user!.id;
    const locationId = req.user!.locationId;

    switch (intent.intent) {
      case 'MARK_AVAILABILITY': {
        const result = await withAuditedTransaction(
          prisma,
          (tx) => markAvailability({ userId: actorId, date: intent.date, type: intent.type, note }, tx),
          (marked) => ({ locationId, actorId, action: 'AVAILABILITY_MARKED', entityType: 'AvailabilityMark', entityId: marked.mark.id, note }),
        );
        return respond(200, { executed: true, result: result.mark }, 'EXECUTED');
      }
      case 'REQUEST_SWAP': {
        const shift = await prisma.shift.findUnique({ where: { id: intent.shiftId }, select: { userId: true, locationId: true } });
        if (!shift || shift.userId !== actorId || shift.locationId !== locationId) {
          const msg = 'That shift could not be found among your own upcoming shifts.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const target = await prisma.user.findFirst({
          where: { id: intent.targetUserId, locationId, isActive: true },
          select: { id: true },
        });
        if (!target) {
          const msg = 'That staff member could not be found at your location.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const created = await withAuditedTransaction(
          prisma,
          (tx) => createSwapRequest({ shiftId: intent.shiftId, requestedById: actorId, targetUserId: intent.targetUserId, reason: intent.reason ?? null }, tx),
          (request) => ({ locationId, actorId, shiftId: intent.shiftId, action: 'SWAP_REQUESTED', entityType: 'ShiftSwapRequest', entityId: request.id, note }),
        );
        void notifySwapRequested(created, locationId);
        return respond(201, { executed: true, result: created }, 'EXECUTED');
      }
      case 'APPROVE_SWAP':
      case 'DECLINE_SWAP': {
        const sr = await prisma.shiftSwapRequest.findUnique({
          where: { id: intent.swapRequestId },
          select: { status: true, shift: { select: { locationId: true } } },
        });
        if (!sr || sr.shift.locationId !== locationId) {
          const msg = 'That swap request could not be found.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        if (sr.status !== 'PENDING') {
          const msg = `That swap request was already ${sr.status.toLowerCase()}.`;
          return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
        }

        const decision = intent.intent === 'APPROVE_SWAP' ? 'approved' : 'declined';
        const result = await decideSwapRequest({ id: intent.swapRequestId, decision, reviewedById: actorId });
        if (result.result === 'not_found') {
          const msg = 'That swap request could not be found.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        if (result.result === 'conflict') {
          const msg = 'That shift was already reassigned by another swap request.';
          return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        await writeAuditLog(prisma, {
          locationId: sr.shift.locationId,
          actorId,
          shiftId: result.request.shiftId,
          action: intent.intent === 'APPROVE_SWAP' ? 'SWAP_APPROVED' : 'SWAP_DECLINED',
          entityType: 'ShiftSwapRequest',
          entityId: intent.swapRequestId,
          note,
        });
        void notifySwapDecided(result.request, decision);
        return respond(200, { executed: true, result: result.request }, 'EXECUTED');
      }
      case 'APPROVE_JOIN':
      case 'DECLINE_JOIN': {
        const jr = await prisma.joinRequest.findUnique({ where: { id: intent.joinRequestId }, select: { locationId: true } });
        if (!jr || jr.locationId !== locationId) {
          const msg = 'That join request could not be found.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }

        const decision = intent.intent === 'APPROVE_JOIN' ? 'approve' : 'decline';
        const result = await decideJoinRequest({ requestId: intent.joinRequestId, decision, reviewedById: actorId });
        if (result.result === 'not_found') {
          const msg = 'That join request could not be found.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        if (result.result === 'already_reviewed') {
          const msg = 'That join request was already reviewed.';
          return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        await writeAuditLog(prisma, {
          locationId: jr.locationId,
          actorId,
          action: intent.intent === 'APPROVE_JOIN' ? 'JOIN_APPROVED' : 'JOIN_DECLINED',
          entityType: 'JoinRequest',
          entityId: intent.joinRequestId,
          note,
        });
        return respond(200, { executed: true, result: { status: result.status, userId: result.userId } }, 'EXECUTED');
      }
      case 'CREATE_SHIFT': {
        const role = await prisma.role.findUnique({ where: { id: intent.roleId } });
        if (!role || role.locationId !== locationId) {
          const msg = `Role "${intent.roleId}" not found.`;
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        if (intent.userId) {
          const staff = await prisma.user.findUnique({ where: { id: intent.userId } });
          if (!staff || staff.locationId !== locationId) {
            const msg = `Staff member "${intent.userId}" not found.`;
            return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
          }
        }
        const timezone = await venueTimezoneFor(locationId);
        const overnight = intent.end <= intent.start;
        const startTime = combineDateAndTime(intent.date, intent.start, timezone);
        const endTime = combineDateAndTime(intent.date, intent.end, timezone, overnight);

        const created = await withAuditedTransaction(
          prisma,
          (tx) =>
            createShift(
              {
                locationId,
                roleId: intent.roleId,
                userId: intent.userId,
                createdById: actorId,
                date: new Date(`${intent.date}T00:00:00.000Z`),
                startTime,
                endTime,
                breakMinutes: 0,
                sidework: [],
                status: 'DRAFT',
              } as unknown as Parameters<typeof createShift>[0],
              tx,
            ),
          (shift) => ({ locationId, actorId, shiftId: shift.id, action: 'SHIFT_CREATED', entityType: 'Shift', entityId: shift.id, note }),
        );
        return respond(201, { executed: true, result: created }, 'EXECUTED');
      }
      case 'EDIT_SHIFT': {
        const existing = await prisma.shift.findUnique({ where: { id: intent.shiftId } });
        if (!existing || existing.locationId !== locationId) {
          const msg = `Shift "${intent.shiftId}" not found.`;
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const timezone = await venueTimezoneFor(locationId);
        const data: Record<string, unknown> = {};
        if (intent.roleId !== undefined) {
          const role = await prisma.role.findUnique({ where: { id: intent.roleId } });
          if (!role || role.locationId !== locationId) {
            const msg = `Role "${intent.roleId}" not found.`;
            return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
          }
          data.roleId = intent.roleId;
        }
        if (intent.userId !== undefined) {
          if (intent.userId) {
            const staff = await prisma.user.findUnique({ where: { id: intent.userId } });
            if (!staff || staff.locationId !== locationId) {
              const msg = `Staff member "${intent.userId}" not found.`;
              return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
            }
            data.userId = intent.userId;
          } else {
            data.userId = null;
          }
        }
        const nextDate = intent.date ?? existing.date.toISOString().slice(0, 10);
        const nextStart = intent.start ?? formatVenueTime(existing.startTime, timezone);
        const nextEnd = intent.end ?? formatVenueTime(existing.endTime, timezone);
        if (intent.date !== undefined || intent.start !== undefined || intent.end !== undefined) {
          const overnight = nextEnd <= nextStart;
          data.date = new Date(`${nextDate}T00:00:00.000Z`);
          data.startTime = combineDateAndTime(nextDate, nextStart, timezone);
          data.endTime = combineDateAndTime(nextDate, nextEnd, timezone, overnight);
        }

        const updated = await withAuditedTransaction(
          prisma,
          (tx) => updateShift(intent.shiftId, data as Parameters<typeof updateShift>[1], tx),
          () => ({ locationId, actorId, shiftId: intent.shiftId, action: 'SHIFT_UPDATED', entityType: 'Shift', entityId: intent.shiftId, note }),
        );
        return respond(200, { executed: true, result: updated }, 'EXECUTED');
      }
      case 'ASSIGN_SECTION': {
        const section = await prisma.floorSection.findUnique({ where: { id: intent.sectionId } });
        if (!section || section.locationId !== locationId) {
          const msg = `Section "${intent.sectionId}" not found.`;
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const staff = await prisma.user.findUnique({ where: { id: intent.staffId } });
        if (!staff || staff.locationId !== locationId) {
          const msg = `Staff member "${intent.staffId}" not found.`;
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const shiftDate = new Date(`${intent.shiftDate}T00:00:00.000Z`);

        const assignment = await withAuditedTransaction(
          prisma,
          (tx) =>
            upsertSectionAssignment(
              { sectionId: intent.sectionId, staffId: intent.staffId, shiftDate, period: intent.period, dutyLabel: intent.dutyLabel, createdById: actorId, touchDutyLabel: true },
              tx,
            ),
          (upserted) => ({
            locationId,
            actorId,
            shiftId: null,
            action: 'SHIFT_ASSIGNED',
            entityType: 'SectionAssignment',
            entityId: upserted.id,
            note,
          }),
        );
        return respond(201, { executed: true, result: assignment }, 'EXECUTED');
      }
      case 'UNRECOGNIZED': {
        const msg = 'This command was not recognized — nothing was executed.';
        return respond(400, { error: msg }, 'REJECTED_VALIDATION', 'unrecognized');
      }
      default: {
        const msg = 'Unknown intent.';
        return respond(400, { error: msg }, 'REJECTED_VALIDATION', msg);
      }
    }
  } catch (err) {
    console.error('[voice.execute] failed', err);
    return respond(500, { error: 'Unexpected error while executing the voice command.' }, 'ERROR');
  }
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run server:typecheck`
Expected: no errors.

- [ ] **Step 5: Run the full existing voice test suite**

Run: `node --import tsx --test server/src/routes/voice.test.ts`
Expected: all existing (pre-Task-9) test cases still PASS — confirms the `respond()` wrapping didn't change any status code or response body for the six existing intents.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/voice.ts
git commit -m "feat(voice): execute CREATE_SHIFT/EDIT_SHIFT/ASSIGN_SECTION, log outcomes to VoiceInteractionLog"
```

---

### Task 10: Frontend `src/api/voice.ts` — thread `voiceLogId`

**Files:**
- Modify: `src/api/voice.ts`

**Interfaces:**
- Produces: `parseVoiceIntent` return type gains `voiceLogId: string`; `executeVoiceIntent` accepts and sends it. Consumed by Task 11.

- [ ] **Step 1: Update `parseVoiceIntent`'s return type and `executeVoiceIntent`'s signature**

```ts
export async function parseVoiceIntent(token: string, transcript: string): Promise<{ transcript: string; intent: ParsedIntent; voiceLogId: string }> {
  return request('/api/voice/parse-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ transcript }),
  });
}

export async function executeVoiceIntent(
  token: string,
  transcript: string,
  intent: ParsedIntent,
  voiceLogId: string,
): Promise<{ executed: boolean; result: unknown }> {
  return request('/api/voice/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ transcript, intent, voiceLogId }),
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: a new error in `AppShell.tsx` (calls `executeVoiceIntent` with 3 args, now needs 4) — expected, fixed in Task 11.

- [ ] **Step 3: Commit**

```bash
git add src/api/voice.ts
git commit -m "feat(voice): thread voiceLogId through the frontend voice API client"
```

---

### Task 11: `AppShell.tsx` — voiceLogId state, recording cap, noise suppression

**Files:**
- Modify: `src/components/shiftsync/AppShell.tsx`

**Interfaces:**
- Consumes: `parseVoiceIntent`/`executeVoiceIntent` (Task 10).

- [ ] **Step 1: Store `voiceLogId` alongside `voiceResult`**

Find the `voiceResult` state declaration (`const [voiceResult, setVoiceResult] = useState<{ transcript: string; intent: ParsedIntent } | null>(null);`) and change its type to include `voiceLogId`:
```ts
  const [voiceResult, setVoiceResult] = useState<{ transcript: string; intent: ParsedIntent; voiceLogId: string } | null>(null);
```

In `handleRecordingComplete`, update the block that calls `parseVoiceIntent`:
```ts
        const { transcript } = await transcribeAudio(session.token, blob);
        const { intent, voiceLogId } = await parseVoiceIntent(session.token, transcript);
        setVoiceResult({ transcript, intent, voiceLogId });
```

In `handleVoiceConfirm`, update the call to `executeVoiceIntent`:
```ts
      await executeVoiceIntent(session.token, voiceResult.transcript, voiceResult.intent, voiceResult.voiceLogId);
```

- [ ] **Step 2: Shorten the recording cap**

Find the max-duration timeout (search for the comment mentioning "45s") and change its value to 10000 (10 seconds). Update the comment to match:
```ts
// 10s hard cap — matches the product requirement that voice commands stay
// short and specific; MediaRecorder otherwise records until the tab is
// closed or stop() is called.
```

- [ ] **Step 3: Add noise-suppression constraints to `getUserMedia`**

Find `navigator.mediaDevices.getUserMedia({ audio: true })` and change to:
```ts
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual verification (per `run` skill / dev server)**

Run: `npm run dev:all`
Then in the browser: sign in as a MANAGER, tap the mic, say "create a bartender shift for tomorrow, 6pm to 2am" (adjust names to your seed data), confirm the transcript displays, confirm the summary in `VoiceCommandSheet` reads correctly, confirm the recording auto-stops at 10s if held, confirm the shift appears on the schedule after confirming.
Expected: full round trip works with no console errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/shiftsync/AppShell.tsx
git commit -m "feat(voice): thread voiceLogId through AppShell, tighten recording cap, add noise suppression"
```

---

### Task 12: Domain-vocabulary biasing in `/transcribe`

**Files:**
- Modify: `server/src/routes/voice.ts` (`/transcribe` handler)
- Modify: `server/src/voice/transcribe.ts`

**Interfaces:**
- Consumes: `prisma` (already imported in `voice.ts`).
- Produces: `transcribeAudio(buffer, mimeType, vocabularyHint?)` — new optional 3rd parameter.

- [ ] **Step 1: Add the optional vocabulary-hint parameter to `transcribeAudio`**

In `server/src/voice/transcribe.ts`, change the function signature and prompt construction:
```ts
export async function transcribeAudio(buffer: Buffer, mimeType: string, vocabularyHint?: string): Promise<string> {
  const genai = getClient();

  const instruction = vocabularyHint
    ? `Transcribe this voice command to plain text. Return ONLY the transcribed words, nothing else — no punctuation commentary, no quotes around it. This is a hospitality-venue staff-scheduling command; it may reference these names/terms — bias your transcription toward them when the audio is ambiguous: ${vocabularyHint}`
    : 'Transcribe this voice command to plain text. Return ONLY the transcribed words, nothing else — no punctuation commentary, no quotes around it.';

  try {
    const response = await genai.models.generateContent({
      model: voiceModel(),
      contents: [
        {
          role: 'user',
          parts: [
            { text: instruction },
            { inlineData: { mimeType, data: buffer.toString('base64') } },
          ],
        },
      ],
    });
```
(Rest of the function body unchanged.)

- [ ] **Step 2: Build and pass the hint from `/transcribe`**

In `server/src/routes/voice.ts`'s `/transcribe` handler, before calling `transcribeAudio`:
```ts
voiceRouter.post('/transcribe', requireSession, transcribeRateLimiter, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });

    const [staff, sections, roles] = await Promise.all([
      prisma.user.findMany({ where: { locationId: req.user!.locationId, isActive: true }, select: { fullName: true } }),
      prisma.floorSection.findMany({ where: { locationId: req.user!.locationId }, select: { label: true } }),
      prisma.role.findMany({ where: { locationId: req.user!.locationId }, select: { name: true } }),
    ]);
    const vocabulary = [
      ...staff.map((s) => s.fullName),
      ...sections.map((s) => s.label),
      ...roles.map((r) => r.name),
      'rota', 'floor', 'section', 'swap', 'cover', 'shift',
    ].join(', ');

    const transcript = await transcribeAudio(req.file.buffer, req.file.mimetype, vocabulary);
    return res.status(200).json({ transcript });
  } catch (err) {
```
(Rest of the handler unchanged.)

- [ ] **Step 3: Typecheck**

Run: `npm run server:typecheck`
Expected: no errors.

- [ ] **Step 4: Run the existing voice test suite one more time (full regression check)**

Run: `node --import tsx --test server/src/routes/voice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/voice/transcribe.ts server/src/routes/voice.ts
git commit -m "feat(voice): bias transcription with staff/section/role vocabulary hint"
```

---

### Task 13: Integration tests for the 3 new intents + confidence/logging behavior

**Files:**
- Modify: `server/src/routes/voice.test.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add `CREATE_SHIFT` tests**

Append to `voice.test.ts` (following the file's existing `withServer`/`sessionFor` helpers and fixture-cleanup style exactly):

```ts
test('POST /api/voice/execute: CREATE_SHIFT from a MANAGER session creates a real Shift with a [voice] AuditLog row', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ create-shift manager', systemRole: 'MANAGER' },
  });

  let createdShiftId = '';
  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'create a shift tomorrow 9 to 5',
          intent: { intent: 'CREATE_SHIFT', roleId: role!.id, date: '2026-09-22', start: '09:00', end: '17:00', userId: null, confidence: 0.9, summary: 'Create an open shift, Sept 22nd, 9am-5pm.' },
        }),
      });
      assert.equal(res.status, 201, 'MANAGER must be able to execute CREATE_SHIFT');
      const body = (await res.json()) as { executed: boolean; result: { id: string } };
      assert.equal(body.executed, true);
      createdShiftId = body.result.id;
    });

    const shift = await prisma.shift.findUnique({ where: { id: createdShiftId } });
    assert.ok(shift, 'a real Shift row must exist');
    assert.equal(shift!.roleId, role!.id);
    assert.equal(shift!.userId, null);

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'Shift', entityId: createdShiftId, action: 'SHIFT_CREATED', note: { contains: '[voice]' } },
    });
    assert.ok(auditRow, 'a real AuditLog row with action SHIFT_CREATED and a [voice] note must exist');
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: 'Shift', entityId: createdShiftId } });
    await prisma.shift.delete({ where: { id: createdShiftId } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: a STAFF session cannot CREATE_SHIFT even with a hand-crafted intent — 403, nothing created', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ create-shift staff', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'create a shift for myself',
          intent: { intent: 'CREATE_SHIFT', roleId: role!.id, date: '2026-09-22', start: '09:00', end: '17:00', userId: null, confidence: 0.9, summary: 'x' },
        }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /does not permit/i);
    });

    const leaked = await prisma.shift.findMany({ where: { locationId: location!.id, date: new Date('2026-09-22T00:00:00.000Z'), roleId: role!.id, userId: null } });
    assert.equal(leaked.length, 0, 'no Shift may be created from a STAFF-session CREATE_SHIFT attempt');
  } finally {
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: ASSIGN_SECTION from a MANAGER session creates a real SectionAssignment', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const floorPlanImage = await prisma.floorPlanImage.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && floorPlanImage, 'seed data (location + a floor plan image) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ assign-section manager', systemRole: 'MANAGER' },
  });
  const staff = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ assign-section staff', systemRole: 'STAFF' },
  });
  const section = await prisma.floorSection.create({
    data: { locationId: location!.id, floorPlanImageId: floorPlanImage!.id, label: '__task13-test__ Bar', polygon: [], paxCapacity: 6 },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'move the staff member to the bar section tomorrow afternoon',
          intent: { intent: 'ASSIGN_SECTION', sectionId: section.id, staffId: staff.id, shiftDate: '2026-09-23', period: 'PM', dutyLabel: null, confidence: 0.9, summary: 'x' },
        }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { executed: boolean; result: { id: string; staffId: string } };
      assert.equal(body.executed, true);
      assert.equal(body.result.staffId, staff.id);
    });

    const assignment = await prisma.sectionAssignment.findFirst({ where: { sectionId: section.id, staffId: staff.id } });
    assert.ok(assignment, 'a real SectionAssignment row must exist');

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'SectionAssignment', entityId: assignment!.id, action: 'SHIFT_ASSIGNED', note: { contains: '[voice]' } },
    });
    assert.ok(auditRow, 'a real AuditLog row with a [voice] note must exist');
  } finally {
    await prisma.sectionAssignment.deleteMany({ where: { sectionId: section.id } });
    await prisma.floorSection.delete({ where: { id: section.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staff.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});
```

- [ ] **Step 2: Add the `/execute` outcome-logging test**

```ts
test('POST /api/voice/execute: a real voiceLogId gets its outcome updated to EXECUTED on success', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ log-outcome staff', systemRole: 'STAFF' },
  });

  const logRow = await prisma.voiceInteractionLog.create({
    data: {
      locationId: location!.id,
      actorId: staffCaller.id,
      transcript: "I can't work next Monday",
      resolvedIntent: 'MARK_AVAILABILITY',
      confidence: 0.95,
      outcome: 'PENDING_CONFIRMATION',
    },
  });

  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: "I can't work next Monday",
          intent: { intent: 'MARK_AVAILABILITY', date: '2026-09-28', type: 'UNAVAILABLE', confidence: 0.95, summary: 'x' },
          voiceLogId: logRow.id,
        }),
      });
      assert.equal(res.status, 200);
    });

    const updated = await prisma.voiceInteractionLog.findUnique({ where: { id: logRow.id } });
    assert.equal(updated!.outcome, 'EXECUTED');
  } finally {
    await prisma.availabilityMark.deleteMany({ where: { userId: staffCaller.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: staffCaller.id } });
    await prisma.voiceInteractionLog.delete({ where: { id: logRow.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/parse-intent returns voiceLogId and writes a real VoiceInteractionLog row', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    // This test needs a real Gemini call; skip cleanly in environments with no key configured, same policy as the rest of this file's implicit dependency on GEMINI_API_KEY for /parse-intent coverage.
    return;
  }

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task13-test__ parse-log staff', systemRole: 'STAFF' },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: 'complete gibberish asdkjfh laksjdhf' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { voiceLogId: string };
      assert.ok(body.voiceLogId);
      voiceLogId = body.voiceLogId;
    });

    const row = await prisma.voiceInteractionLog.findUnique({ where: { id: voiceLogId } });
    assert.ok(row, 'a real VoiceInteractionLog row must exist');
    assert.equal(row!.actorId, staffCaller.id);
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});
```

- [ ] **Step 3: Run the full voice test suite**

Run: `node --import tsx --test server/src/routes/voice.test.ts`
Expected: all tests PASS (existing six-intent tests + this task's new ones). The `parse-intent` test skips cleanly if `GEMINI_API_KEY` isn't set in the test environment.

- [ ] **Step 4: Run the full server test suite as a final regression check**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/voice.test.ts
git commit -m "test(voice): cover CREATE_SHIFT/ASSIGN_SECTION execution and interaction-log outcomes"
```

---

## Deferred (see spec §9, not part of this plan)

- RNNoise/WASM noise suppression, custom VAD silence-trimming.
- `TimeOffRequest` approve/decline, `RotaPublish`, `RotaTemplate`, `Announcement`/`Shoutout` voice tools, read-only voice queries.
- Logging user-initiated Cancel on the confirm sheet.
- Real floor-noise/accent audio testing (manual QA — spec §10 — requires audio samples from the team; not automatable here).
