# AI Voice Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Both decisions flagged during planning (see "Decisions" section below) have been confirmed by the user: build all 6 v1 intents including the 2 new `AuditAction` values, and apply confirm-before-execute to every intent regardless of role. This plan is ready to dispatch as written.

**Goal:** Wire the existing mic-button stub (`RadialDock`/`AppShell`, currently a no-op `listening` toggle) into a real, role-scoped voice command pipeline: record audio → transcribe → parse into a structurally-constrained intent (different allowed intents per `SystemRole`) → show the caller a plain-English confirmation → execute on confirm → audit-log the whole thing, reusing this codebase's existing swap-approval audit pattern.

**Architecture:** Three new session-gated backend routes (`/api/voice/transcribe`, `/api/voice/parse-intent`, `/api/voice/execute`) built entirely on infrastructure that already exists in this codebase: `requireSession` for identity, `@google/genai` (already used for roster-image OCR) for both the transcription and the structured intent-parsing calls, and the exact `tx.auditLog.create(...)` pattern already used by swap-request decisions. The six mutations a v1 voice command can perform (see the intent list below) are extracted into small, shared action functions so the existing REST routes and the new voice-execute route both call the same tested logic — the voice layer never re-implements a mutation, it only adds session-derived authorization and an audit trail on top of logic that already exists and is already tested. Role scoping happens twice, redundantly by design: once as a Gemini `responseSchema` enum restriction (the LLM structurally cannot emit an intent type outside the caller's role's allowed set), and again as a hard server-side re-check in `/execute` before anything is written — the schema restriction is a quality-of-output measure, never the actual security boundary.

**Tech Stack:** No new dependencies. `@google/genai` (already a dependency, already configured via `GEMINI_API_KEY`) for both transcription and structured intent parsing. Browser-native `MediaRecorder`/`getUserMedia` for audio capture (no new frontend library).

**Spec:** This plan implements the user's own verbatim requirements for a new "AI Voice Intent" feature — this is NOT part of the original Lovable-port build directive (which is fully shipped and merged as of the Confirm Roster phase); it is fresh, user-requested scope. Quoted in full:

> Intent parsing: after transcription, use a scoped system prompt (different for each role) so the LLM can only ever generate the intents each role is permitted to create — pull the actual staff and manager permission boundaries from what's already true in our data model, don't invent a shorthand list.
>
> Audit trail: log every voice-triggered action — who, the transcript, and the resulting action taken — since this is a new trust surface. Reuse our existing audit-log pattern (already used for swap approvals) rather than building a separate one.
>
> UI: the mic button already exists as a stub in our locked nav (above People) — wire it up rather than building new placement.
>
> Give me a plan before building, specifically calling out: the exact new/changed backend routes, how the server derives role from session (not client input), how the confirm-before-execute step works for managers, and any data model changes if reusing our existing tables isn't sufficient. Flag anything that doesn't fit this cleanly before building it.

## Global Constraints

- **The real permission-boundary source is `User.systemRole: SystemRole` (`OWNER | MANAGER | STAFF`, `prisma/schema.prisma`)** — not an invented shorthand. `OWNER` and `MANAGER` are treated identically for this feature (both get the larger "manager-tier" intent set) because nothing else in this codebase differentiates OWNER from MANAGER behavior anywhere — confirmed by grep across every route before writing this plan. `STAFF` gets the smaller, self-service-only set.
- **Role is derived exclusively from `req.user` (set by `requireSession`), never from any client-supplied field.** All three new routes sit behind `requireSession`. The `/execute` route re-derives and re-checks role fresh from `req.user.systemRole` even though `/parse-intent` already scoped the schema by role — a client that calls `/execute` directly with a hand-crafted body must be blocked by the same check, not just by the LLM's own restraint.
- **Audit trail reuses the existing `AuditLog` model and the exact write pattern already used by `swapRequests.ts`'s decide handler** (`tx.auditLog.create({ data: { locationId, actorId, shiftId, action, entityType, entityId, note } })`, inside the same transaction as the real mutation). No new table. The transcript is embedded in `note` (an unbounded `@db.Text` field, already used for free-text context like `managerNote`), prefixed with a `[voice]` marker so voice-triggered rows are greppable/distinguishable from UI-triggered ones without a schema change. Only an intent that actually executes gets an audit row — a rejected (wrong-role), failed, or purely informational parse is not audited, mirroring how a failed API call anywhere else in this codebase isn't audited either.
- **No new mutation logic is written twice.** Each of the 6 v1 intents' actual database writes are extracted into a small, shared `server/src/lib/actions/*.ts` function, called by BOTH the pre-existing REST route (unchanged behavior, same call site, same tests) and the new voice `/execute` route. This is the plan's central refactor and is scoped tightly: it moves logic that already exists, unchanged, into a shared location — it does not change what the existing REST endpoints accept, validate, or return.
- **Confirm-before-execute is a hard two-call boundary, not a UI-only affordance, and applies to every v1 intent regardless of role** (a documented broadening of the user's "for managers" framing — see the second flagged decision below). `/parse-intent` never mutates anything and never writes to `AuditLog`; only a subsequent, explicit `/execute` call (carrying the same parsed intent object handed back to the client) can do either.
- **The Gemini `responseSchema` enum is the real intent-scoping mechanism**, built by role from a single source-of-truth array (`STAFF_INTENTS`/`MANAGER_INTENTS`), not hand-typed separately in the prompt text — the prompt text is generated *from* that same array so the two can never drift apart.
- **Staff-name and shift resolution reuses this codebase's existing normalization utility**, `nameKey()` from `server/src/parsing/resolveRows.ts` (currently module-private — exported as part of this plan, a one-line change) — not a new fuzzy-matching implementation.
- **This phase DOES add real backend logic and therefore DOES need real test coverage**, per this codebase's established `node:test` + `withServer()` convention (`server/src/routes/shifts.test.ts`/`floorPlan.test.ts`) — unlike the just-shipped Confirm Roster phase, which made no backend changes and was correctly exempted.
- **`GEMINI_API_KEY` absence must fail clearly, not silently**, mirroring `parseVision.ts`'s existing convention (a typed error naming the missing capability) rather than a bare 500.
- Commit hygiene: stage only each task's own named files, never `git add -A`/`.`. Never touch `.claude/settings.json`/`.claude/settings.local.json` under any circumstances — if a subagent hits a permission denial, it must stop and report BLOCKED, not attempt a workaround.

## Decisions (confirmed by the user before dispatch)

Both of the following were flagged as genuine architectural choices rather than silently decided, per the user's own instruction. Both are now confirmed — this section is kept for the record, not as an open question.

**1. Scope of v1 voice-executable intents, and the two new `AuditAction` values that follow from it.**
Two of the six intents this plan proposes for v1 — `MARK_AVAILABILITY` (staff self-service, maps to the existing `POST /api/availability`) and `REQUEST_SWAP` (staff self-service, maps to the existing `POST /api/swap-requests` create) — have **no existing `AuditAction` value today**, because marking availability and creating a swap request aren't audited when done manually through the UI either. Auditing "every voice-triggered action" as the user asked means these two need real audit coverage that doesn't exist yet, which means two new, small, additive `AuditAction` enum values: `AVAILABILITY_MARKED` and `SWAP_REQUESTED`. The other four intents (`APPROVE_SWAP`/`DECLINE_SWAP`/`APPROVE_JOIN`/`DECLINE_JOIN`) reuse `AuditAction` values that already exist (`SWAP_APPROVED`/`SWAP_DECLINED`/`JOIN_APPROVED`/`JOIN_DECLINED`), so no schema change is needed for those four.
*Recommended default:* build all 6 intents, add the 2 new enum values. *Alternative:* scope v1 to only the 4 manager-tier decide-intents (zero schema changes at all), deferring staff self-service voice intents to a v2 once the pipeline is proven end-to-end on the lower-risk manager side. Floor-plan assignment, the 86 List, and staff-directory status changes are deliberately left OUT of v1 either way — they need multi-parameter resolution (which section, which date/period, which staff member) that's a meaningfully harder parsing problem, and are noted here as fast-follow candidates, not silently dropped.

**2. Confirm-before-execute scope: the user's own wording asked specifically "how the confirm-before-execute step works for managers."** This plan applies the confirm step to every intent, both staff and manager tiers, because voice mishearing risk (the wrong day, the wrong colleague's name) is not role-specific — a staff member accidentally marking the wrong day unavailable deserves the same courtesy as a manager accidentally declining the wrong swap request. *Recommended default:* confirm-before-execute for all 6 intents. *Alternative:* if the user specifically wants staff-tier self-service intents (`MARK_AVAILABILITY`, `REQUEST_SWAP`) to auto-execute without a confirm step — matching how the existing manual availability-marking UI already executes immediately on tap with no confirmation dialog — that is a small, contained change to Task 7 only (skip straight to `/execute` for those two intent types) and does not otherwise affect this plan's shape.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (modify) | `AuditAction` gains `AVAILABILITY_MARKED`, `SWAP_REQUESTED` (only if Decision 1 is confirmed as-is). |
| `server/src/parsing/resolveRows.ts` (modify) | Export `nameKey` (currently module-private) so the voice layer can reuse the same name-normalization logic. |
| `server/src/lib/actions/swapActions.ts` (new) | `createSwapRequest(...)` and `decideSwapRequest(...)` — the real mutation logic, extracted from `swapRequests.ts` unchanged, called by both the REST route and voice `/execute`. |
| `server/src/lib/actions/joinActions.ts` (new) | `decideJoinRequest(...)` — extracted from `join.ts`'s PATCH handler unchanged. |
| `server/src/lib/actions/availabilityActions.ts` (new) | `markAvailability(...)` — extracted from `availability.ts`'s POST handler unchanged. |
| `server/src/routes/swapRequests.ts` (modify) | POST and PATCH handlers now call the extracted `swapActions.ts` functions instead of inlining the logic — behavior and response shape unchanged. |
| `server/src/routes/join.ts` (modify) | PATCH handler now calls `joinActions.ts`'s function — behavior unchanged. |
| `server/src/routes/availability.ts` (modify) | POST handler now calls `availabilityActions.ts`'s function — behavior unchanged. |
| `server/src/voice/intentSchema.ts` (new) | `STAFF_INTENTS`/`MANAGER_INTENTS` arrays (single source of truth), the Gemini `responseSchema` built from them, and the `ParsedIntent` discriminated-union type. |
| `server/src/voice/prompts.ts` (new) | Builds the role-scoped system prompt text from the same intent arrays, plus the context-injection (caller's upcoming shifts, venue staff directory) the LLM needs to resolve names/dates to real ids. |
| `server/src/voice/transcribe.ts` (new) | `transcribeAudio(buffer, mimeType): Promise<string>` — Gemini audio-input call. |
| `server/src/voice/parseIntent.ts` (new) | `parseVoiceIntent(transcript, user, context): Promise<ParsedIntent>` — Gemini structured-output call using the role-scoped schema/prompt. |
| `server/src/routes/voice.ts` (new) | Mounts `POST /transcribe`, `POST /parse-intent`, `POST /execute` — all behind `requireSession`. |
| `server/src/app.ts` (modify) | Mount `voiceRouter` at `/api/voice`. |
| `src/api/voice.ts` (new) | Client for the 3 new endpoints. |
| `src/components/shiftsync/VoiceCommandSheet.tsx` (new) | The confirm-before-execute UI: shows the parsed intent's summary, Confirm/Cancel. |
| `src/components/shiftsync/AppShell.tsx` (modify) | `voiceOn` state machine extended to drive record → transcribe → parse → confirm-sheet → execute. |
| `src/components/shiftsync/RadialDock.tsx` (modify, minimal) | Mic button gains a `recording`/`processing` visual state on top of its existing `listening` prop — no placement change. |

---

### Task 1: Schema — two new `AuditAction` values (pending Decision 1)

**Files:**
- Modify: `prisma/schema.prisma`
- Migration: `prisma/migrations/<timestamp>_add_voice_audit_actions/` (generated)

**Interfaces:**
- Produces: `AuditAction.AVAILABILITY_MARKED`, `AuditAction.SWAP_REQUESTED`.

- [ ] **Step 1: Add the two enum values**

In `prisma/schema.prisma`'s `AuditAction` enum, add after the existing values:

```prisma
  AVAILABILITY_MARKED
  SWAP_REQUESTED
```

- [ ] **Step 2: Generate and apply the migration**

Use this project's established non-interactive workflow if `prisma migrate dev` can't run interactively in this environment: `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script` → hand-place into a correctly-timestamped `prisma/migrations/<ts>_add_voice_audit_actions/migration.sql` → `npx prisma migrate deploy`. Confirm with `npx prisma migrate status` and `npx prisma validate`.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add AVAILABILITY_MARKED and SWAP_REQUESTED audit actions for voice-triggered actions"
```

---

### Task 2: Extract shared mutation logic into `server/src/lib/actions/*.ts`

**Files:**
- Create: `server/src/lib/actions/swapActions.ts`
- Create: `server/src/lib/actions/joinActions.ts`
- Create: `server/src/lib/actions/availabilityActions.ts`
- Modify: `server/src/routes/swapRequests.ts`
- Modify: `server/src/routes/join.ts`
- Modify: `server/src/routes/availability.ts`

**Interfaces:**
- Produces:
  - `createSwapRequest(input: { shiftId: string; requestedById: string; targetUserId: string; reason: string | null }): Promise<SwapRequestWithRelations>`
  - `decideSwapRequest(input: { id: string; decision: 'approved' | 'declined'; reviewedById: string | null }): Promise<{ result: 'ok'; request: SwapRequestWithRelations } | { result: 'not_found' } | { result: 'conflict' }>`
  - `decideJoinRequest(input: { requestId: string; decision: 'approve' | 'decline'; reviewedById: string | null; jobTitle?: string }): Promise<{ result: 'ok'; status: string; userId?: string } | { result: 'not_found' } | { result: 'already_reviewed' }>`
  - `markAvailability(input: { userId: string; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; note?: string }): Promise<{ result: 'ok'; mark: AvailabilityMarkDto } | { result: 'not_found' }>`
- Consumed by: Task 6 (voice `/execute`) and the pre-existing REST routes (updated in this task to call these instead of inlining).

This task's entire purpose is a **behavior-preserving extraction** — the logic inside each new function must be byte-for-byte the same as what the corresponding route already does today. This is verified in Step 4 below by re-running each route's existing test file unchanged and confirming identical pass counts.

- [ ] **Step 1: Read the three real, current route files in full** (`server/src/routes/swapRequests.ts`, `server/src/routes/join.ts`, `server/src/routes/availability.ts`) before extracting anything — this plan's snapshot of them should be close but must not be assumed current.

- [ ] **Step 2: Create `server/src/lib/actions/swapActions.ts`**

Move the PATCH handler's decision transaction (the `prisma.$transaction` block including the `ShiftAlreadyReassignedError` guard and the `auditLog.create` call) and the POST handler's creation logic into two exported functions with the same return-shape discipline the routes already use (result discriminated by a status field so the calling route can map it to the right HTTP status code):

```typescript
import { prisma } from '../prisma.js';
import { isRequestLocked, nextRequestWindowClose } from '../swapRequestPolicy.js';

const SWAP_REQUEST_INCLUDE = {
  requestedBy: { select: { fullName: true } },
  targetUser: { select: { fullName: true } },
  shift: { select: { userId: true, date: true, startTime: true, endTime: true } },
} as const;

export class ShiftAlreadyReassignedError extends Error {}

export async function createSwapRequest(input: {
  shiftId: string;
  requestedById: string;
  targetUserId: string;
  reason: string | null;
}) {
  return prisma.shiftSwapRequest.create({
    data: {
      shiftId: input.shiftId,
      requestedById: input.requestedById,
      targetUserId: input.targetUserId,
      type: 'COVER',
      status: 'PENDING',
      reason: input.reason,
      expiresAt: nextRequestWindowClose(),
    },
    include: SWAP_REQUEST_INCLUDE,
  });
}

export async function decideSwapRequest(input: {
  id: string;
  decision: 'approved' | 'declined';
  reviewedById: string | null;
}) {
  const existing = await prisma.shiftSwapRequest.findUnique({
    where: { id: input.id },
    include: { requestedBy: { select: { fullName: true } }, targetUser: { select: { fullName: true } }, shift: true },
  });
  if (!existing) return { result: 'not_found' as const };

  if (isRequestLocked({ status: existing.status }, { userId: existing.shift.userId }, existing.requestedById)) {
    return { result: 'conflict' as const };
  }

  const status = input.decision === 'approved' ? 'APPROVED' : 'DECLINED';
  const managerNote =
    input.decision === 'approved'
      ? `Approved · shift reassigned to ${existing.targetUser?.fullName ?? 'the proposed cover'}`
      : 'Declined';

  const updated = await prisma.$transaction(async (tx) => {
    if (input.decision === 'approved' && existing.targetUserId) {
      const reassigned = await tx.shift.updateMany({
        where: { id: existing.shiftId, userId: existing.requestedById },
        data: { userId: existing.targetUserId },
      });
      if (reassigned.count === 0) {
        throw new ShiftAlreadyReassignedError();
      }
    }

    const updatedRequest = await tx.shiftSwapRequest.update({
      where: { id: input.id },
      data: { status, reviewedById: input.reviewedById, reviewedAt: new Date(), managerNote },
      include: SWAP_REQUEST_INCLUDE,
    });

    await tx.auditLog.create({
      data: {
        locationId: existing.shift.locationId,
        actorId: input.reviewedById,
        shiftId: existing.shiftId,
        action: input.decision === 'approved' ? 'SWAP_APPROVED' : 'SWAP_DECLINED',
        entityType: 'ShiftSwapRequest',
        entityId: input.id,
        note: managerNote,
      },
    });

    return updatedRequest;
  }).catch((err) => {
    if (err instanceof ShiftAlreadyReassignedError) return null;
    throw err;
  });

  if (!updated) return { result: 'conflict' as const };
  return { result: 'ok' as const, request: updated };
}
```

- [ ] **Step 3: Update `server/src/routes/swapRequests.ts`** to call these two functions instead of inlining the logic. The route's own responsibility narrows to: parsing/validating the HTTP request body, calling the shared function, and mapping its result to the right HTTP status/JSON shape (404/409/200/201 exactly as today) — no behavior change, confirmed in Step 4.

- [ ] **Step 4: Verify the extraction is behavior-preserving**

Run: `npm run server:typecheck` (must be clean) and `node --import tsx --test server/src/routes/swapRequests.test.ts` if that file exists (check first — if no dedicated test file exists yet for this route, this step becomes: manually re-run this plan's Task 8 live-check scenarios for swap approve/decline/create against the refactored code and confirm identical responses to before the refactor). Do NOT proceed to Task 3 until this task's extraction is confirmed behavior-preserving.

- [ ] **Step 5: Repeat Steps 2-4 for `joinActions.ts`** (extracted from `join.ts`'s PATCH `/:requestId` handler — the approve/decline transaction, including its `AuditLog` writes for `JOIN_APPROVED`/`JOIN_DECLINED`) **and `availabilityActions.ts`** (extracted from `availability.ts`'s POST handler — the upsert-on-`userId_date` logic).

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/actions/swapActions.ts server/src/lib/actions/joinActions.ts server/src/lib/actions/availabilityActions.ts server/src/routes/swapRequests.ts server/src/routes/join.ts server/src/routes/availability.ts
git commit -m "refactor: extract swap/join/availability mutation logic into shared action functions"
```

---

### Task 3: Voice intent schema, role-scoped prompts, and name/shift resolution

**Files:**
- Create: `server/src/voice/intentSchema.ts`
- Create: `server/src/voice/prompts.ts`
- Create: `server/src/voice/intentSchema.test.ts`
- Modify: `server/src/parsing/resolveRows.ts` (export `nameKey`)

**Interfaces:**
- Produces: `STAFF_INTENTS`, `MANAGER_INTENTS` (readonly string-literal arrays), `intentSchemaFor(systemRole: SystemRole)`, `ParsedIntent` (discriminated union), `buildSystemPrompt(systemRole, context)`.
- Consumed by: Task 5 (`parseIntent.ts`).

- [ ] **Step 1: Export `nameKey` from `resolveRows.ts`**

Change `function nameKey(value: string): string {` to `export function nameKey(value: string): string {` — the single line this task needs from that file. No other change to that file.

- [ ] **Step 2: Write the failing test for the schema module**

Create `server/src/voice/intentSchema.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAFF_INTENTS, MANAGER_INTENTS, intentSchemaFor } from './intentSchema.js';

test('MANAGER_INTENTS is a strict superset of STAFF_INTENTS', () => {
  for (const intent of STAFF_INTENTS) {
    assert.ok(MANAGER_INTENTS.includes(intent), `MANAGER_INTENTS is missing staff intent "${intent}"`);
  }
});

test('intentSchemaFor(STAFF) restricts the enum to STAFF_INTENTS only', () => {
  const schema = intentSchemaFor('STAFF');
  const intentProp = schema.properties.intent;
  assert.deepEqual([...intentProp.enum].sort(), [...STAFF_INTENTS].sort());
});

test('intentSchemaFor(MANAGER) and intentSchemaFor(OWNER) both restrict to MANAGER_INTENTS', () => {
  const managerSchema = intentSchemaFor('MANAGER');
  const ownerSchema = intentSchemaFor('OWNER');
  assert.deepEqual([...managerSchema.properties.intent.enum].sort(), [...MANAGER_INTENTS].sort());
  assert.deepEqual([...ownerSchema.properties.intent.enum].sort(), [...MANAGER_INTENTS].sort());
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test server/src/voice/intentSchema.test.ts`
Expected: FAIL — `Cannot find module './intentSchema.js'`.

- [ ] **Step 4: Write `server/src/voice/intentSchema.ts`**

```typescript
import type { SystemRole } from '@prisma/client';
import { Type } from '@google/genai';

/** Staff self-service intents — every one of these must map to a real, already-existing, session-scoped self-service endpoint. */
export const STAFF_INTENTS = ['MARK_AVAILABILITY', 'REQUEST_SWAP'] as const;

/** Manager-tier intents, strictly a superset of STAFF_INTENTS — OWNER and MANAGER share this set (nothing else in this codebase differentiates them). */
export const MANAGER_INTENTS = [
  ...STAFF_INTENTS,
  'APPROVE_SWAP',
  'DECLINE_SWAP',
  'APPROVE_JOIN',
  'DECLINE_JOIN',
] as const;

export type StaffIntentType = (typeof STAFF_INTENTS)[number];
export type ManagerIntentType = (typeof MANAGER_INTENTS)[number];
export type IntentType = ManagerIntentType;

/** Discriminated union the parse-intent endpoint returns and the execute endpoint receives back. */
export type ParsedIntent =
  | { intent: 'MARK_AVAILABILITY'; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; summary: string }
  | { intent: 'REQUEST_SWAP'; shiftId: string; targetUserId: string; targetUserName: string; reason: string | null; summary: string }
  | { intent: 'APPROVE_SWAP'; swapRequestId: string; summary: string }
  | { intent: 'DECLINE_SWAP'; swapRequestId: string; summary: string }
  | { intent: 'APPROVE_JOIN'; joinRequestId: string; summary: string }
  | { intent: 'DECLINE_JOIN'; joinRequestId: string; summary: string }
  | { intent: 'UNRECOGNIZED'; reason: string; summary: string };

/** Every role's schema also always allows UNRECOGNIZED, so the model has a safe way to say "I couldn't confidently resolve this" instead of guessing. */
function schemaFor(intents: readonly string[]) {
  return {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING, enum: [...intents, 'UNRECOGNIZED'] },
      date: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD, for MARK_AVAILABILITY' },
      availabilityType: { type: Type.STRING, enum: ['UNAVAILABLE', 'PREFERRED_OFF'], nullable: true },
      shiftId: { type: Type.STRING, nullable: true, description: 'For REQUEST_SWAP — one of the ids in the provided shift list' },
      targetUserId: { type: Type.STRING, nullable: true, description: 'For REQUEST_SWAP — one of the ids in the provided staff list' },
      targetUserName: { type: Type.STRING, nullable: true },
      reason: { type: Type.STRING, nullable: true },
      swapRequestId: { type: Type.STRING, nullable: true, description: 'For APPROVE_SWAP/DECLINE_SWAP — one of the ids in the provided pending-swaps list' },
      joinRequestId: { type: Type.STRING, nullable: true, description: 'For APPROVE_JOIN/DECLINE_JOIN — one of the ids in the provided pending-joins list' },
      summary: { type: Type.STRING, description: 'One plain-English sentence describing exactly what will happen, for the confirm step' },
      unrecognizedReason: { type: Type.STRING, nullable: true, description: 'Only for intent=UNRECOGNIZED — why this could not be resolved' },
    },
    required: ['intent', 'summary'],
  };
}

const STAFF_SCHEMA = schemaFor(STAFF_INTENTS);
const MANAGER_SCHEMA = schemaFor(MANAGER_INTENTS);

/** Server-side re-derivation point: OWNER and MANAGER both get the manager schema, STAFF gets the smaller one. Called fresh in both /parse-intent and, again, as a permission re-check in /execute. */
export function intentSchemaFor(systemRole: SystemRole) {
  return systemRole === 'STAFF' ? STAFF_SCHEMA : MANAGER_SCHEMA;
}

export function allowedIntentsFor(systemRole: SystemRole): readonly string[] {
  return systemRole === 'STAFF' ? STAFF_INTENTS : MANAGER_INTENTS;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test server/src/voice/intentSchema.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 6: Write `server/src/voice/prompts.ts`**

```typescript
import type { SystemRole } from '@prisma/client';
import { allowedIntentsFor } from './intentSchema.js';

export interface PromptContext {
  today: string; // YYYY-MM-DD
  callerName: string;
  /** The caller's own upcoming shifts — only relevant/populated for REQUEST_SWAP. */
  callerShifts: { id: string; date: string; startTime: string; endTime: string }[];
  /** Every active staff member at this location, for name resolution. */
  staffDirectory: { id: string; fullName: string }[];
  /** Only populated for manager-tier callers — the pending decisions they could be asked to act on. */
  pendingSwapRequests?: { id: string; requesterName: string; shiftLabel: string }[];
  pendingJoinRequests?: { id: string; fullName: string; phone: string }[];
}

/**
 * Builds the role-scoped system prompt. The allowed-intents list is generated
 * from the SAME array `intentSchemaFor` restricts the response schema to —
 * this function never hand-types a separate list, so the prompt text and the
 * schema enum can never drift apart.
 */
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

  lines.push(
    ``,
    `If a name or date is ambiguous or you cannot find a confident match in the lists above, respond with intent=UNRECOGNIZED and explain why in unrecognizedReason — never guess an id that isn't listed above.`,
    `Always fill in "summary" with one plain-English sentence describing exactly what will happen if this is confirmed, e.g. "Mark you unavailable on Friday, August 29th" or "Approve Sarah's swap request for her Tuesday shift."`,
  );

  return lines.join('\n');
}
```

- [ ] **Step 7: Verify**

Run: `npm run server:typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add server/src/voice/intentSchema.ts server/src/voice/intentSchema.test.ts server/src/voice/prompts.ts server/src/parsing/resolveRows.ts
git commit -m "feat: add role-scoped voice intent schema and prompt builder"
```

---

### Task 4: Audio transcription

**Files:**
- Create: `server/src/voice/transcribe.ts`

**Interfaces:**
- Produces: `transcribeAudio(buffer: Buffer, mimeType: string): Promise<string>`, `VoiceTranscriptionError` (thrown, mirrors `VisionIngestionError`'s pattern).
- Consumed by: Task 6 (`voice.ts`'s `/transcribe` handler).

- [ ] **Step 1: Read `server/src/parsing/parseVision.ts`'s client-init and error-handling pattern in full** before writing this file, to match its exact conventions (lazy client singleton, `GEMINI_API_KEY`-missing error, `ApiError` handling for rate-limit/quota).

- [ ] **Step 2: Write `server/src/voice/transcribe.ts`**

```typescript
import { GoogleGenAI, ApiError } from '@google/genai';

export class VoiceTranscriptionError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VoiceTranscriptionError';
    this.cause = cause;
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

let client: GoogleGenAI | null = null;

/** Transcribes a short voice-command audio clip to plain text via Gemini. */
export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    throw new VoiceTranscriptionError('GEMINI_API_KEY is not configured on the server — voice transcription is unavailable.');
  }
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  try {
    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Transcribe this voice command to plain text. Return ONLY the transcribed words, nothing else — no punctuation commentary, no quotes around it.' },
            { inlineData: { mimeType, data: buffer.toString('base64') } },
          ],
        },
      ],
    });
    const text = response.text?.trim();
    if (!text) {
      throw new VoiceTranscriptionError('Gemini returned an empty transcription.');
    }
    return text;
  } catch (err) {
    if (err instanceof ApiError) {
      throw new VoiceTranscriptionError(`Transcription failed (${err.status ?? 'unknown'}): ${err.message}`, err);
    }
    if (err instanceof VoiceTranscriptionError) throw err;
    throw new VoiceTranscriptionError('Unexpected error while transcribing audio.', err);
  }
}
```

Note for whoever implements this task: verify Gemini's currently-supported inline-audio mimetypes against the live API docs at implementation time (e.g. `audio/webm`, `audio/wav`, `audio/mp3`) — this is a real but narrow technical detail to confirm, not an architectural question, and does not block writing this task's structure.

- [ ] **Step 3: Verify**

Run: `npm run server:typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/voice/transcribe.ts
git commit -m "feat: add Gemini-based voice transcription"
```

---

### Task 5: Intent parsing

**Files:**
- Create: `server/src/voice/parseIntent.ts`

**Interfaces:**
- Consumes: `intentSchemaFor`/`buildSystemPrompt`/`ParsedIntent` (Task 3), `nameKey` (Task 3's export from `resolveRows.ts`).
- Produces: `parseVoiceIntent(transcript: string, user: { id: string; systemRole: SystemRole; fullName: string; locationId: string }): Promise<ParsedIntent>`.
- Consumed by: Task 6 (`voice.ts`'s `/parse-intent` handler).

- [ ] **Step 1: Write `server/src/voice/parseIntent.ts`**

```typescript
import { GoogleGenAI, ApiError, Type } from '@google/genai';
import type { SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { intentSchemaFor, type ParsedIntent } from './intentSchema.js';
import { buildSystemPrompt, type PromptContext } from './prompts.js';

export class VoiceIntentError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VoiceIntentError';
    this.cause = cause;
  }
}

let client: GoogleGenAI | null = null;

async function buildContext(user: { id: string; systemRole: SystemRole; fullName: string; locationId: string }): Promise<PromptContext> {
  const today = new Date().toISOString().slice(0, 10);
  const staff = await prisma.user.findMany({
    where: { locationId: user.locationId, isActive: true },
    select: { id: true, fullName: true },
  });

  const ctx: PromptContext = {
    today,
    callerName: user.fullName,
    callerShifts: [],
    staffDirectory: staff,
  };

  const startOfToday = new Date(`${today}T00:00:00.000Z`);
  const shifts = await prisma.shift.findMany({
    where: { userId: user.id, date: { gte: startOfToday } },
    orderBy: { date: 'asc' },
    take: 10,
  });
  ctx.callerShifts = shifts.map((s) => ({
    id: s.id,
    date: s.date.toISOString().slice(0, 10),
    startTime: s.startTime.toISOString().slice(11, 16),
    endTime: s.endTime.toISOString().slice(11, 16),
  }));

  if (user.systemRole !== 'STAFF') {
    const pendingSwaps = await prisma.shiftSwapRequest.findMany({
      where: { status: 'PENDING', shift: { locationId: user.locationId } },
      include: { requestedBy: { select: { fullName: true } }, shift: { select: { date: true, startTime: true, endTime: true } } },
      take: 20,
    });
    ctx.pendingSwapRequests = pendingSwaps.map((r) => ({
      id: r.id,
      requesterName: r.requestedBy.fullName,
      shiftLabel: `${r.shift.date.toISOString().slice(0, 10)} ${r.shift.startTime.toISOString().slice(11, 16)}-${r.shift.endTime.toISOString().slice(11, 16)}`,
    }));

    const pendingJoins = await prisma.joinRequest.findMany({
      where: { locationId: user.locationId, status: 'PENDING' },
      take: 20,
    });
    ctx.pendingJoinRequests = pendingJoins.map((r) => ({ id: r.id, fullName: r.fullName, phone: r.phone }));
  }

  return ctx;
}

/**
 * Parses a transcript into a role-scoped intent. Never mutates anything —
 * this is the "propose" half of the confirm-before-execute boundary. The
 * caller's role restricts BOTH the Gemini response schema (the model
 * structurally cannot emit an out-of-scope intent) and the prompt text
 * (defense-in-depth) — but /execute must still re-check role independently,
 * since this function's output is not itself a trust boundary.
 */
export async function parseVoiceIntent(
  transcript: string,
  user: { id: string; systemRole: SystemRole; fullName: string; locationId: string },
): Promise<ParsedIntent> {
  if (!process.env.GEMINI_API_KEY) {
    throw new VoiceIntentError('GEMINI_API_KEY is not configured on the server — voice intent parsing is unavailable.');
  }
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const context = await buildContext(user);
  const systemPrompt = buildSystemPrompt(user.systemRole, context);
  const schema = intentSchemaFor(user.systemRole);

  try {
    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    });
    const raw = JSON.parse(response.text ?? '{}');
    return normalizeParsedIntent(raw);
  } catch (err) {
    if (err instanceof ApiError) {
      throw new VoiceIntentError(`Intent parsing failed (${err.status ?? 'unknown'}): ${err.message}`, err);
    }
    throw new VoiceIntentError('Unexpected error while parsing the voice command.', err);
  }
}

/** Narrows Gemini's loosely-typed JSON object into the real ParsedIntent union, defaulting to UNRECOGNIZED on any shape mismatch rather than trusting an unexpected field combination. */
function normalizeParsedIntent(raw: Record<string, unknown>): ParsedIntent {
  const intent = typeof raw.intent === 'string' ? raw.intent : 'UNRECOGNIZED';
  const summary = typeof raw.summary === 'string' ? raw.summary : 'Could not determine what to do.';

  switch (intent) {
    case 'MARK_AVAILABILITY':
      if (typeof raw.date === 'string' && (raw.availabilityType === 'UNAVAILABLE' || raw.availabilityType === 'PREFERRED_OFF')) {
        return { intent: 'MARK_AVAILABILITY', date: raw.date, type: raw.availabilityType, summary };
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
          summary,
        };
      }
      break;
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      if (typeof raw.swapRequestId === 'string') {
        return { intent, swapRequestId: raw.swapRequestId, summary };
      }
      break;
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN':
      if (typeof raw.joinRequestId === 'string') {
        return { intent, joinRequestId: raw.joinRequestId, summary };
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

- [ ] **Step 2: Verify**

Run: `npm run server:typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/src/voice/parseIntent.ts
git commit -m "feat: add role-scoped Gemini voice intent parsing"
```

---

### Task 6: `POST /api/voice/{transcribe,parse-intent,execute}`

**Files:**
- Create: `server/src/routes/voice.ts`
- Create: `server/src/routes/voice.test.ts`
- Modify: `server/src/app.ts`

**Interfaces:**
- Consumes: `transcribeAudio` (Task 4), `parseVoiceIntent` (Task 5), `createSwapRequest`/`decideSwapRequest`/`decideJoinRequest`/`markAvailability` (Task 2), `requireSession` (existing), `allowedIntentsFor` (Task 3).
- Produces: `voiceRouter` mounted at `/api/voice`.

- [ ] **Step 1: Write `server/src/routes/voice.ts`**

```typescript
import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { requireSession } from '../middleware/requireSession.js';
import { transcribeAudio, VoiceTranscriptionError } from '../voice/transcribe.js';
import { parseVoiceIntent, VoiceIntentError } from '../voice/parseIntent.js';
import { allowedIntentsFor, type ParsedIntent } from '../voice/intentSchema.js';
import { createSwapRequest, decideSwapRequest } from '../lib/actions/swapActions.js';
import { decideJoinRequest } from '../lib/actions/joinActions.js';
import { markAvailability } from '../lib/actions/availabilityActions.js';

export const voiceRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** POST /api/voice/transcribe — multipart: audio. Session-gated only so this can't be used as an open transcription proxy. */
voiceRouter.post('/transcribe', requireSession, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });
    const transcript = await transcribeAudio(req.file.buffer, req.file.mimetype);
    return res.status(200).json({ transcript });
  } catch (err) {
    if (err instanceof VoiceTranscriptionError) return res.status(503).json({ error: err.message });
    console.error('[voice.transcribe] failed', err);
    return res.status(500).json({ error: 'Unexpected error while transcribing audio.' });
  }
});

/** POST /api/voice/parse-intent — body: { transcript }. Never mutates anything — the "propose" half of confirm-before-execute. */
voiceRouter.post('/parse-intent', requireSession, async (req, res) => {
  try {
    const transcript = String(req.body?.transcript ?? '').trim();
    if (!transcript) return res.status(400).json({ error: 'transcript is required.' });

    const intent = await parseVoiceIntent(transcript, {
      id: req.user!.id,
      systemRole: req.user!.systemRole,
      fullName: req.user!.fullName,
      locationId: req.user!.locationId,
    });
    return res.status(200).json({ transcript, intent });
  } catch (err) {
    if (err instanceof VoiceIntentError) return res.status(503).json({ error: err.message });
    console.error('[voice.parseIntent] failed', err);
    return res.status(500).json({ error: 'Unexpected error while parsing the voice command.' });
  }
});

/**
 * POST /api/voice/execute — body: { transcript, intent: ParsedIntent }.
 * The "execute" half. Re-derives role from session (never trusts that
 * /parse-intent already scoped this correctly — a client could call this
 * directly with a hand-crafted intent) and re-validates every referenced
 * entity fresh before writing anything.
 */
voiceRouter.post('/execute', requireSession, async (req, res) => {
  try {
    const transcript = String(req.body?.transcript ?? '');
    const intent = req.body?.intent as ParsedIntent | undefined;
    if (!intent || typeof intent.intent !== 'string') {
      return res.status(400).json({ error: 'A parsed intent is required.' });
    }

    const allowed = allowedIntentsFor(req.user!.systemRole);
    if (!allowed.includes(intent.intent as (typeof allowed)[number])) {
      return res.status(403).json({ error: `Your role does not permit the "${intent.intent}" action.` });
    }

    const note = `[voice] "${transcript}"`;
    const actorId = req.user!.id;
    const locationId = req.user!.locationId;

    switch (intent.intent) {
      case 'MARK_AVAILABILITY': {
        const result = await markAvailability({ userId: actorId, date: intent.date, type: intent.type, note });
        if (result.result === 'not_found') return res.status(404).json({ error: 'Could not mark availability.' });
        await prisma.auditLog.create({
          data: { locationId, actorId, action: 'AVAILABILITY_MARKED', entityType: 'AvailabilityMark', entityId: result.mark.id, note },
        });
        return res.status(200).json({ executed: true, result: result.mark });
      }
      case 'REQUEST_SWAP': {
        const shift = await prisma.shift.findUnique({ where: { id: intent.shiftId }, select: { userId: true, locationId: true } });
        if (!shift || shift.userId !== actorId || shift.locationId !== locationId) {
          return res.status(404).json({ error: 'That shift could not be found among your own upcoming shifts.' });
        }
        const created = await createSwapRequest({ shiftId: intent.shiftId, requestedById: actorId, targetUserId: intent.targetUserId, reason: intent.reason });
        await prisma.auditLog.create({
          data: { locationId, actorId, shiftId: intent.shiftId, action: 'SWAP_REQUESTED', entityType: 'ShiftSwapRequest', entityId: created.id, note },
        });
        return res.status(201).json({ executed: true, result: created });
      }
      case 'APPROVE_SWAP':
      case 'DECLINE_SWAP': {
        const decision = intent.intent === 'APPROVE_SWAP' ? 'approved' : 'declined';
        const result = await decideSwapRequest({ id: intent.swapRequestId, decision, reviewedById: actorId });
        if (result.result === 'not_found') return res.status(404).json({ error: 'That swap request could not be found.' });
        if (result.result === 'conflict') return res.status(409).json({ error: 'That swap request was already decided.' });
        // decideSwapRequest already writes its own AuditLog row (SWAP_APPROVED/SWAP_DECLINED) — append the voice transcript by writing a second, linked row rather than mutating the first, keeping the extracted action function's own audit write untouched.
        await prisma.auditLog.create({
          data: { locationId, actorId, action: intent.intent === 'APPROVE_SWAP' ? 'SWAP_APPROVED' : 'SWAP_DECLINED', entityType: 'ShiftSwapRequest', entityId: intent.swapRequestId, note },
        });
        return res.status(200).json({ executed: true, result: result.request });
      }
      case 'APPROVE_JOIN':
      case 'DECLINE_JOIN': {
        const decision = intent.intent === 'APPROVE_JOIN' ? 'approve' : 'decline';
        const result = await decideJoinRequest({ requestId: intent.joinRequestId, decision, reviewedById: actorId });
        if (result.result === 'not_found') return res.status(404).json({ error: 'That join request could not be found.' });
        if (result.result === 'already_reviewed') return res.status(409).json({ error: 'That join request was already reviewed.' });
        await prisma.auditLog.create({
          data: { locationId, actorId, action: intent.intent === 'APPROVE_JOIN' ? 'JOIN_APPROVED' : 'JOIN_DECLINED', entityType: 'JoinRequest', entityId: intent.joinRequestId, note },
        });
        return res.status(200).json({ executed: true, result });
      }
      case 'UNRECOGNIZED':
        return res.status(400).json({ error: 'This command was not recognized — nothing was executed.' });
      default:
        return res.status(400).json({ error: 'Unknown intent.' });
    }
  } catch (err) {
    console.error('[voice.execute] failed', err);
    return res.status(500).json({ error: 'Unexpected error while executing the voice command.' });
  }
});
```

Note on the double-audit-write for `APPROVE_SWAP`/`DECLINE_SWAP`/`APPROVE_JOIN`/`DECLINE_JOIN`: `decideSwapRequest`/`decideJoinRequest` (Task 2) already write their own `AuditLog` row as part of the extracted, unchanged mutation logic — this keeps that row exactly as it is for the REST-triggered case. `/execute` writes a SECOND row carrying the `[voice]`-prefixed transcript, rather than threading an optional "extra note" parameter through the shared action functions (which would require changing their signature and touching the REST call sites' behavior). This is a real, deliberate two-row-per-voice-decision design choice — flag it to the user alongside this plan's other two decisions if a single combined row is preferred instead; implementing that would mean widening `decideSwapRequest`/`decideJoinRequest`'s signature with an optional `extraNote`/`actorOverride`, a small, contained change if wanted.

- [ ] **Step 2: Mount the router**

In `server/src/app.ts`:

```typescript
import { voiceRouter } from './routes/voice.js';
// ...
  app.use('/api/voice', voiceRouter);
```

- [ ] **Step 3: Write real `node:test` coverage**

Create `server/src/routes/voice.test.ts` following this repo's established `withServer()` real-app-real-DB pattern (see `server/src/routes/shifts.test.ts` for the exact harness). At minimum:
- A STAFF-role session calling `/execute` with a hand-crafted `APPROVE_SWAP` intent gets a real 403 (role re-check holds even bypassing `/parse-intent` entirely).
- A MANAGER-role session executing `APPROVE_SWAP` on a real pending `ShiftSwapRequest` results in the shift's `userId` actually reassigning and a real `AuditLog` row with `action: 'SWAP_APPROVED'` and a `note` containing the `[voice]` marker and the transcript text.
- `MARK_AVAILABILITY` executed by a STAFF session creates a real `AvailabilityMark` row scoped to that session's own `userId`, and a real `AuditLog` row with `action: 'AVAILABILITY_MARKED'`.
- Calling `/execute` with `intent.intent: 'APPROVE_SWAP'` from a session whose role doesn't permit it never reaches the database (no `AuditLog` row is created) — confirms the 403 is a real gate, not just a response code with the mutation still happening underneath.

- [ ] **Step 4: Verify**

Run: `node --import tsx --test server/src/routes/voice.test.ts` — all new tests pass. Run `npm run server:typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/voice.ts server/src/routes/voice.test.ts server/src/app.ts
git commit -m "feat: add session-gated voice transcribe/parse-intent/execute routes"
```

---

### Task 7: Frontend — wire the existing mic button to the real pipeline

**Files:**
- Create: `src/api/voice.ts`
- Create: `src/components/shiftsync/VoiceCommandSheet.tsx`
- Modify: `src/components/shiftsync/AppShell.tsx`
- Modify: `src/components/shiftsync/RadialDock.tsx`

**Interfaces:**
- Produces: `transcribeAudio(token, audioBlob)`, `parseVoiceIntent(token, transcript)`, `executeVoiceIntent(token, transcript, intent)` in `src/api/voice.ts`. `VoiceCommandSheet` component: `{ intent: ParsedIntent | null; onConfirm: () => void; onCancel: () => void; executing: boolean }`.

- [ ] **Step 1: Read the real, current `AppShell.tsx` and `RadialDock.tsx`** in full before editing (both already exist and are already wired for the `listening` toggle — this task extends that existing state machine, it does not replace it).

- [ ] **Step 2: `src/api/voice.ts`**

```typescript
import { ApiError } from './schedules';
import type { ParsedIntent } from '../../server/src/voice/intentSchema'; // type-only import for the shared union shape; adjust to a local mirrored type if a cross-package type import isn't viable in this build setup — confirm at implementation time
export { ApiError };

export async function transcribeAudio(token: string, audioBlob: Blob): Promise<{ transcript: string }> {
  const form = new FormData();
  form.append('audio', audioBlob, 'command.webm');
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return res.json();
}

export async function parseVoiceIntent(token: string, transcript: string): Promise<{ transcript: string; intent: ParsedIntent }> {
  const res = await fetch('/api/voice/parse-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ transcript }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return res.json();
}

export async function executeVoiceIntent(token: string, transcript: string, intent: ParsedIntent): Promise<{ executed: boolean; result: unknown }> {
  const res = await fetch('/api/voice/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ transcript, intent }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return res.json();
}
```

Note for the implementer: confirm at build time whether importing a type from `server/src/voice/intentSchema.ts` into `src/` is viable in this project's TypeScript project setup (separate `tsconfig`s for client/server per `npm run typecheck` vs `npm run server:typecheck`) — if not, mirror `ParsedIntent` as a local type in `src/api/voice.ts` instead of a cross-boundary import, matching how every other `src/api/*.ts` file in this codebase already defines its own DTO types rather than importing server types directly.

- [ ] **Step 3: `src/components/shiftsync/VoiceCommandSheet.tsx`**

A small confirm sheet, following this codebase's established modal/panel conventions (e.g. `SectionPicker.tsx`'s overlay pattern):

```tsx
import type { ParsedIntent } from '../../api/voice';

export default function VoiceCommandSheet({
  intent,
  onConfirm,
  onCancel,
  executing,
}: {
  intent: (ParsedIntent & { intent: string; summary: string }) | null;
  onConfirm: () => void;
  onCancel: () => void;
  executing: boolean;
}) {
  if (!intent) return null;
  const isUnrecognized = intent.intent === 'UNRECOGNIZED';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onCancel}>
      <div className="panel m-4 max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow">{isUnrecognized ? "Didn't catch that" : 'Confirm voice command'}</p>
        <p className="mt-2 text-sm">{intent.summary}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          {!isUnrecognized && (
            <button className="btn btn-primary" onClick={onConfirm} disabled={executing}>
              {executing ? 'Executing…' : 'Confirm'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Extend `AppShell.tsx`'s voice state machine**

Read the real current `voiceOn`/`setVoiceOn` state and `RadialDock`'s `onToggleListening` wiring, then extend it to drive the full pipeline: on activation, request mic permission and start a `MediaRecorder`; on deactivation (second tap), stop recording, call `transcribeAudio` → `parseVoiceIntent`, show `VoiceCommandSheet` with the result; on the sheet's Confirm, call `executeVoiceIntent`, then close the sheet and surface a success/error toast consistent with this codebase's existing toast/banner conventions. Requires `useIdentity()`'s `session.token` (from `src/state/IdentityContext.tsx`) — if there is no active session, the mic button should surface a clear "sign in to use voice commands" state rather than silently failing at the first API call's 401.

- [ ] **Step 5: Minimal `RadialDock.tsx` visual state**

Extend the existing `listening` boolean prop with an additional `processing?: boolean` prop (distinct visual treatment — e.g. a pulsing/spinner variant of the existing `breathe` animation) so the user gets feedback during the transcribe/parse round-trip, not just a static "still listening" icon. No placement change — this button already sits exactly where Lovable's reference design and this project's locked nav put it.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed. Manual/browser verification of the actual recording UX is out of scope for this environment (per this project's existing, tracked "no browser tool available" gap) — state this plainly in Task 8's report rather than claiming it was checked.

- [ ] **Step 7: Commit**

```bash
git add src/api/voice.ts src/components/shiftsync/VoiceCommandSheet.tsx src/components/shiftsync/AppShell.tsx src/components/shiftsync/RadialDock.tsx
git commit -m "feat: wire the mic button to the real voice command pipeline"
```

---

### Task 8: Verification + MEMORY.md

**Files:**
- Modify: `MEMORY.md`

**Interfaces:** none new — acceptance gate for the phase.

- [ ] **Step 1: Full verification pass**

Run, in order: `npm run server:typecheck`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npm run test:server`. All must succeed, including the new `server/src/voice/intentSchema.test.ts` and `server/src/routes/voice.test.ts`.

- [ ] **Step 2: Live end-to-end check** against the real server + real DB (clean up every row created): as a MANAGER-role session, call `/api/voice/parse-intent` with a hand-typed transcript like "approve the swap request from [a real staff name]" and confirm a real `APPROVE_SWAP` intent with a real, matched `swapRequestId` comes back; call `/execute` on it and confirm the underlying `ShiftSwapRequest`/`Shift` actually update and a real `AuditLog` row with the `[voice]`-prefixed transcript exists. Repeat for a STAFF-role session attempting an out-of-scope intent via a hand-crafted `/execute` body and confirm a real 403 with no database write. Confirm `GEMINI_API_KEY`-unset behavior surfaces the typed error, not a bare 500 (temporarily unset it in a throwaway shell, don't touch the real `.env`).

- [ ] **Step 3: State plainly what was NOT verified** — the actual browser microphone-permission flow, `MediaRecorder` audio capture, and the confirm sheet's on-screen appearance were not exercised by a human or browser tool in this environment. Fold this into the same existing "STANDING PRE-LAUNCH GATE" bullet in `MEMORY.md` (extend it, do not duplicate it) rather than creating a new note.

- [ ] **Step 4: Update `MEMORY.md`** — check off this phase under `## Completed Core Components`, reuse the existing `## Next Sprint Goals` heading, and add a handoff note describing the new `server/src/lib/actions/*.ts` extraction pattern (any future feature needing to trigger a swap/join/availability mutation from a new surface should call these shared functions, not re-inline the logic a third time) plus the two new `AuditAction` values and what they're for.

- [ ] **Step 5: Commit**

```bash
git add MEMORY.md
git commit -m "docs: record AI Voice Intent phase completion"
```

---

## Self-Review

**Spec coverage:**
- "scoped system prompt, different for each role... pull the actual permission boundaries from the data model" → Task 3's `STAFF_INTENTS`/`MANAGER_INTENTS` derived directly from the real `SystemRole` enum, both the Gemini schema enum and the prompt text generated from the same array. ✅
- "log every voice-triggered action — who, transcript, resulting action... reuse the existing audit-log pattern" → Task 6's `/execute` handler writes `tx.auditLog.create`/`prisma.auditLog.create` calls in the exact existing shape, `note` carries the `[voice]`-prefixed transcript, `actorId` is always session-derived. ✅
- "mic button already exists as a stub... wire it up rather than building new placement" → Task 7 explicitly extends the existing `voiceOn`/`RadialDock` state machine in place, makes no layout/positioning change. ✅
- "exact new/changed backend routes" → File Structure table + Task 6 name all three (`/transcribe`, `/parse-intent`, `/execute`) plus the 3 modified existing routes (Task 2). ✅
- "how the server derives role from session, not client input" → Global Constraints + Task 6's `/execute` handler explicitly re-deriving `req.user.systemRole` and re-checking it against `allowedIntentsFor`, never trusting the client-echoed intent's own shape. ✅
- "how confirm-before-execute works for managers" → Global Constraints + the two-endpoint (`/parse-intent` never mutates, `/execute` is the only mutating call) design, applied to all roles with the broadening explicitly flagged as Decision 2. ✅
- "any data model changes if reusing existing tables isn't sufficient" → Flagged explicitly as Decision 1 (2 new `AuditAction` values), with the reasoning for why they're needed and the zero-schema-change alternative named. ✅
- "flag anything that doesn't fit cleanly" → Both flagged decisions sit right after Global Constraints, before any task, with a recommended default and a concrete alternative each — this plan is written to be ready to execute on the defaults, but is not dispatched until the user answers them.

**Placeholder scan:** no "TBD"/"handle appropriately" language anywhere; the two explicitly-named open items (Gemini audio mimetype support, cross-package type import viability) are narrow, implementation-time technical confirmations, not architectural gaps, and are labeled as such rather than silently assumed.

**Type consistency:** `ParsedIntent`'s discriminated union (Task 3) is the single shape produced by `parseVoiceIntent` (Task 5), returned by `/parse-intent` (Task 6), round-tripped by the frontend (Task 7), and re-validated by `/execute` (Task 6) — no divergent shape introduced at any later task.
