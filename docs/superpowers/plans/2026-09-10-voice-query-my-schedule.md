# AI Voice: QUERY_MY_SCHEDULE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `QUERY_MY_SCHEDULE`, the first read-only voice intent in ShiftSync — terminates entirely inside `/parse-intent`, no `/execute` call, no confirm step.

**Architecture:** One new intent added to `STAFF_INTENTS` (flows into `MANAGER_INTENTS`/`ALL_INTENTS` automatically, same mechanism every existing intent uses). The model answers directly from context already fetched (`callerShifts`, staff-own-shifts-only — structurally, not just by prompt instruction). `summary` is repurposed as the literal answer text for this one intent. A new `VoiceInteractionOutcome` value (`ANSWERED`) replaces the otherwise-misleading `PENDING_CONFIRMATION` this intent would log. `/execute` needs zero new code — the intent structurally can never reach it through the real UI (no Confirm button rendered for it), and a hand-crafted request falls to `/execute`'s existing `default: 400` branch.

**Tech Stack:** Express, Prisma/PostgreSQL, `@google/genai` (Gemini structured output), `node:test` + `node:assert/strict`, React 19, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-09-10-voice-query-my-schedule-design.md`

## Global Constraints

- `QUERY_MY_SCHEDULE` goes into `STAFF_INTENTS` only — never hand-added to `MANAGER_INTENTS` separately (it flows in automatically since `MANAGER_INTENTS = [...STAFF_INTENTS, ...]`).
- No new fields on this intent's `ParsedIntent` variant beyond `intent`/`confidence`/`summary` — no new Gemini schema properties needed.
- `/execute` gets NO new code for this intent — not in `validateIntentShape`, not in the main switch. Both existing `default` branches already produce the correct fail-closed behavior.
- `AppShell.tsx` gets NO changes — `handleVoiceCancel`/`handleVoiceConfirm` are already fully generic; hiding the Confirm button in `VoiceCommandSheet.tsx` is sufficient to make `executeVoiceIntent` structurally unreachable for this intent via the real UI.
- The "never another person's schedule" guarantee must be verified as a `buildContext` property (test it directly), not asserted only via prompt wording.
- Migration is additive-only (one new enum value) — no backfill.

---

## File Structure

**New files:**
- `server/src/voice/parseIntent.test.ts` — tests `buildContext`'s cross-caller scoping.
- `server/src/voice/interactionLog.test.ts` — unit tests for `outcomeAtParseTime`'s 4 branches.

**Modified files:**
- `prisma/schema.prisma` — add `ANSWERED` to `VoiceInteractionOutcome`.
- `server/src/voice/intentSchema.ts` — add `QUERY_MY_SCHEDULE` to `STAFF_INTENTS`, add its `ParsedIntent` variant.
- `src/api/voice.ts` — mirror the same `ParsedIntent` variant.
- `server/src/voice/prompts.ts` — add the `QUERY_MY_SCHEDULE`-specific instruction block.
- `server/src/voice/parseIntent.ts` — add the `normalizeParsedIntent` case; export `buildContext` for testability.
- `server/src/voice/interactionLog.ts` — add the `outcomeAtParseTime` branch; export `outcomeAtParseTime` for testability.
- `src/components/shiftsync/VoiceCommandSheet.tsx` — add the "answer only, no Confirm" rendering branch.
- `server/src/routes/voice.test.ts` — add 3 new integration tests (2 live-Gemini, 1 fail-closed `/execute` test).

---

### Task 1: `ANSWERED` outcome value + migration

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `VoiceInteractionOutcome` enum gains `ANSWERED` as an 8th value. Consumed by Task 5.

- [ ] **Step 1: Add the enum value**

In `prisma/schema.prisma`, find the `VoiceInteractionOutcome` enum:

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
```

Add `ANSWERED` as the 8th value:

```prisma
enum VoiceInteractionOutcome {
  PENDING_CONFIRMATION
  LOW_CONFIDENCE
  UNRECOGNIZED
  EXECUTED
  REJECTED_VALIDATION
  REJECTED_PERMISSION
  ERROR
  ANSWERED
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npm run prisma:migrate -- --name add_answered_outcome`
Expected: a new folder under `prisma/migrations/` containing `ALTER TYPE "VoiceInteractionOutcome" ADD VALUE 'ANSWERED'`, applied cleanly, `npm run prisma:generate` runs automatically as part of `migrate dev`.

- [ ] **Step 3: Verify the Prisma client picked up the new value**

Run: `npm run server:typecheck`
Expected: no errors (confirms the generated `VoiceInteractionOutcome` type now includes `'ANSWERED'`, even though nothing references it yet).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add ANSWERED to VoiceInteractionOutcome for read-only voice intents"
```

---

### Task 2: Add `QUERY_MY_SCHEDULE` to the intent schema

**Files:**
- Modify: `server/src/voice/intentSchema.ts`
- Modify: `src/api/voice.ts`

**Interfaces:**
- Produces: `STAFF_INTENTS` includes `'QUERY_MY_SCHEDULE'`; `ParsedIntent` union gains `{ intent: 'QUERY_MY_SCHEDULE'; confidence: number; summary: string }` in both files. Consumed by Task 3 (prompts), Task 4 (normalization), Task 5 (outcome classification), Task 6 (UI).

- [ ] **Step 1: Update `server/src/voice/intentSchema.ts`**

Change `STAFF_INTENTS`:

```ts
export const STAFF_INTENTS = ['MARK_AVAILABILITY', 'REQUEST_SWAP', 'QUERY_MY_SCHEDULE'] as const;
```

Add the new variant to the `ParsedIntent` union, right before `UNRECOGNIZED`:

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
  | { intent: 'QUERY_MY_SCHEDULE'; confidence: number; summary: string }
  | { intent: 'UNRECOGNIZED'; reason: string; summary: string };
```

Do NOT change `schemaFor()` — `intent`, `confidence`, and `summary` are already properties on the Gemini response schema; this intent needs no new ones.

- [ ] **Step 2: Mirror the same union in `src/api/voice.ts`**

Replace the `ParsedIntent` union (lines 22-32) with the identical union shown above (same insertion point, right before `UNRECOGNIZED`).

- [ ] **Step 3: Typecheck both halves**

Run: `npm run server:typecheck && npm run typecheck`
Expected: no errors. `QUERY_MY_SCHEDULE` is now a valid intent everywhere it's referenced by type, but nothing yet produces or specially handles it — that's Tasks 3-6.

- [ ] **Step 4: Commit**

```bash
git add server/src/voice/intentSchema.ts src/api/voice.ts
git commit -m "feat(voice): add QUERY_MY_SCHEDULE to STAFF_INTENTS and the intent schema"
```

---

### Task 3: Prompt instruction for `QUERY_MY_SCHEDULE`

**Files:**
- Modify: `server/src/voice/prompts.ts`

**Interfaces:**
- Consumes: `allowedIntentsFor` (existing), no new `PromptContext` fields needed.
- Produces: `buildSystemPrompt` instructs the model on how to answer this intent. Consumed by Task 4 indirectly (the model's raw output is what `normalizeParsedIntent` narrows).

- [ ] **Step 1: Add the instruction block**

In `server/src/voice/prompts.ts`, after the existing `if (ctx.floorSections?.length) { ... }` block and before the final unconditional `lines.push(...)` call, add:

```ts
  if (allowed.includes('QUERY_MY_SCHEDULE')) {
    lines.push(
      ``,
      `For QUERY_MY_SCHEDULE specifically: answer using ONLY the caller's own upcoming shifts already listed above — you have no visibility into anyone else's schedule, so never claim to. Put the direct, final answer to their question directly in "summary" (e.g. "You're working Friday 6pm-close and Saturday 2pm-10pm this weekend", or "You have no shifts scheduled this week") — do NOT describe a pending action, since nothing will be written. If the question's date range is genuinely ambiguous (e.g. "next week" without clear bounds you can resolve against today's date), respond with UNRECOGNIZED instead of guessing.`,
    );
  }
```

- [ ] **Step 2: Typecheck**

Run: `npm run server:typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/voice/prompts.ts
git commit -m "feat(voice): instruct the model on how to answer QUERY_MY_SCHEDULE"
```

---

### Task 4: `normalizeParsedIntent` case + export `buildContext`

**Files:**
- Modify: `server/src/voice/parseIntent.ts`

**Interfaces:**
- Produces: `normalizeParsedIntent` returns a valid `QUERY_MY_SCHEDULE` variant when the model emits that intent; `buildContext` becomes an exported function (was module-private). Consumed by Task 7's `parseIntent.test.ts` (calls `buildContext` directly).

- [ ] **Step 1: Add the `normalizeParsedIntent` case**

In `server/src/voice/parseIntent.ts`'s `normalizeParsedIntent` function, add a new case right before the `case 'ASSIGN_SECTION':` block (or anywhere among the other cases — order doesn't matter functionally, but keep it grouped with the other simple cases for readability). Unlike every other case, this one has no extra fields to validate, so it returns unconditionally with no `if` guard:

```ts
    case 'QUERY_MY_SCHEDULE':
      return { intent: 'QUERY_MY_SCHEDULE', confidence, summary };
```

Do not add a `break;` after this `return` — matching every other case's style (`break` is only used when the `if` guard's condition can fail and fall through to the final `UNRECOGNIZED` return; this case has no guard, so it always returns).

- [ ] **Step 2: Export `buildContext`**

Change:

```ts
async function buildContext(user: { id: string; systemRole: SystemRole; fullName: string; locationId: string }): Promise<PromptContext> {
```

to:

```ts
export async function buildContext(user: { id: string; systemRole: SystemRole; fullName: string; locationId: string }): Promise<PromptContext> {
```

No other change to the function body — this is a pure visibility change so Task 7's test can call it directly instead of only reachable through a live Gemini call.

- [ ] **Step 3: Typecheck**

Run: `npm run server:typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/voice/parseIntent.ts
git commit -m "feat(voice): normalize QUERY_MY_SCHEDULE, export buildContext for testing"
```

---

### Task 5: `outcomeAtParseTime` — `ANSWERED` branch + export

**Files:**
- Modify: `server/src/voice/interactionLog.ts`

**Interfaces:**
- Consumes: `VoiceIntentResolution` (existing), `'ANSWERED'` (Task 1's new enum value, already in the generated Prisma client).
- Produces: `outcomeAtParseTime` becomes exported (was module-private) and classifies a genuinely-resolved `QUERY_MY_SCHEDULE` as `ANSWERED`. Consumed by Task 7's `interactionLog.test.ts`.

- [ ] **Step 1: Update `outcomeAtParseTime`**

Replace:

```ts
function outcomeAtParseTime(resolution: VoiceIntentResolution): VoiceInteractionOutcome {
  if (resolution.attempted.intent === 'UNRECOGNIZED') return 'UNRECOGNIZED';
  if (resolution.response.intent === 'UNRECOGNIZED') return 'LOW_CONFIDENCE';
  return 'PENDING_CONFIRMATION';
}
```

with:

```ts
export function outcomeAtParseTime(resolution: VoiceIntentResolution): VoiceInteractionOutcome {
  if (resolution.attempted.intent === 'UNRECOGNIZED') return 'UNRECOGNIZED';
  if (resolution.response.intent === 'UNRECOGNIZED') return 'LOW_CONFIDENCE';
  if (resolution.response.intent === 'QUERY_MY_SCHEDULE') return 'ANSWERED';
  return 'PENDING_CONFIRMATION';
}
```

The new branch checks `resolution.response.intent` (the post-confidence-gate value), not `resolution.attempted.intent` — a `QUERY_MY_SCHEDULE` attempt that the confidence gate coerced to an `UNRECOGNIZED` response must log as `LOW_CONFIDENCE` (caught by the branch above it), not `ANSWERED`, since nothing was actually answered in that case.

- [ ] **Step 2: Typecheck**

Run: `npm run server:typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/voice/interactionLog.ts
git commit -m "feat(voice): log QUERY_MY_SCHEDULE as ANSWERED, export outcomeAtParseTime for testing"
```

---

### Task 6: `VoiceCommandSheet.tsx` — answer-only rendering

**Files:**
- Modify: `src/components/shiftsync/VoiceCommandSheet.tsx`

**Interfaces:**
- Consumes: `ParsedIntent` (Task 2's new variant already included via the type import).
- Produces: no Confirm button and a "Got it" dismiss label when `intent.intent === 'QUERY_MY_SCHEDULE'`.

- [ ] **Step 1: Replace the component body**

Replace the full file content with:

```tsx
import type { ParsedIntent } from '@/api/voice';

/**
 * Confirm-before-execute sheet for the voice command pipeline. Mirrors the
 * overlay conventions already used by RotaBuilder.tsx's `SheetShell` and
 * ScheduleEditorRoute.tsx's confirm dialog (fixed inset-0, bg-background/70
 * + backdrop-blur-sm, a `panel` card) rather than inventing a new modal
 * style for this one feature.
 */
export function VoiceCommandSheet({
  intent,
  transcript,
  onConfirm,
  onCancel,
  executing,
}: {
  intent: ParsedIntent | null;
  /** What was actually heard. The whole point of confirm-before-execute is catching a mishearing, which is invisible if only the model's paraphrase is shown. */
  transcript: string;
  onConfirm: () => void;
  onCancel: () => void;
  executing: boolean;
}) {
  if (!intent) return null;
  const isUnrecognized = intent.intent === 'UNRECOGNIZED';
  // QUERY_MY_SCHEDULE is read-only — it never reaches /execute at all (see
  // parseIntent.ts's normalizeParsedIntent and routes/voice.ts's /execute,
  // which deliberately has no case for it), so there is nothing to confirm.
  // `intent.summary` already carries the direct answer for this one intent
  // (see prompts.ts), not a description of a pending action.
  const isAnswerOnly = intent.intent === 'QUERY_MY_SCHEDULE';
  // UNRECOGNIZED's `summary` is typically a generic fallback ("Could not
  // determine what to do."); `reason` is the model's actual explanation of
  // WHY it couldn't resolve the command, and is the only part that teaches
  // the user how to rephrase.
  const reason = isUnrecognized && intent.reason.trim() ? intent.reason : null;

  const eyebrow = isUnrecognized ? "Didn't catch that" : isAnswerOnly ? 'Your schedule' : 'Confirm voice command';
  const dismissLabel = isAnswerOnly ? 'Got it' : 'Cancel';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      // Once execution is in flight the mutation lands regardless — offering a
      // backdrop dismiss here would be a cancel button that cancels nothing.
      onClick={executing ? undefined : onCancel}
    >
      <div className="panel w-full max-w-sm shadow-lux" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <p className="eyebrow">{eyebrow}</p>
          {transcript.trim() && <p className="mt-2 text-xs text-foreground/60">You said: “{transcript.trim()}”</p>}
          <p className="mt-2 text-sm">{intent.summary}</p>
          {reason && <p className="mt-2 text-xs text-foreground/60">{reason}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={onCancel} disabled={executing}>
              {dismissLabel}
            </button>
            {!isUnrecognized && !isAnswerOnly && (
              <button className="btn btn-primary" onClick={onConfirm} disabled={executing}>
                {executing ? 'Executing…' : 'Confirm'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Run: `npm run dev:all`
In the browser: sign in as any staff or manager session, tap the mic, say "what's my next shift". Confirm the sheet shows the eyebrow "Your schedule", the answer text, and only a "Got it" button (no "Confirm"). Confirm tapping "Got it" dismisses the sheet with no network call to `/execute` (check the browser's network tab).

- [ ] **Step 4: Commit**

```bash
git add src/components/shiftsync/VoiceCommandSheet.tsx
git commit -m "feat(voice): render QUERY_MY_SCHEDULE as an answer-only sheet, no Confirm button"
```

---

### Task 7: Tests

**Files:**
- Create: `server/src/voice/parseIntent.test.ts`
- Create: `server/src/voice/interactionLog.test.ts`
- Modify: `server/src/routes/voice.test.ts`

**Interfaces:**
- Consumes: `buildContext` (Task 4's export), `outcomeAtParseTime` (Task 5's export), everything else already in place.

- [ ] **Step 1: Write `server/src/voice/parseIntent.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { buildContext } from './parseIntent.js';

const prisma = new PrismaClient();

test("buildContext never includes another caller's shifts in callerShifts", async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const callerA = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule caller A', systemRole: 'STAFF' },
  });
  const callerB = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule caller B', systemRole: 'STAFF' },
  });

  const shiftDate = new Date('2026-09-25T00:00:00.000Z');
  const shiftA = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: callerA.id,
      date: shiftDate, startTime: new Date('2026-09-25T09:00:00.000Z'), endTime: new Date('2026-09-25T17:00:00.000Z'), status: 'PUBLISHED',
    },
  });
  const shiftB = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: callerB.id,
      date: shiftDate, startTime: new Date('2026-09-25T10:00:00.000Z'), endTime: new Date('2026-09-25T18:00:00.000Z'), status: 'PUBLISHED',
    },
  });

  try {
    const contextForA = await buildContext({ id: callerA.id, systemRole: 'STAFF', fullName: callerA.fullName, locationId: location!.id });
    const idsForA = contextForA.callerShifts.map((s) => s.id);
    assert.ok(idsForA.includes(shiftA.id), "caller A's context must include their own shift");
    assert.ok(!idsForA.includes(shiftB.id), "caller A's context must NOT include caller B's shift");

    const contextForB = await buildContext({ id: callerB.id, systemRole: 'STAFF', fullName: callerB.fullName, locationId: location!.id });
    const idsForB = contextForB.callerShifts.map((s) => s.id);
    assert.ok(idsForB.includes(shiftB.id), "caller B's context must include their own shift");
    assert.ok(!idsForB.includes(shiftA.id), "caller B's context must NOT include caller A's shift");
  } finally {
    await prisma.shift.delete({ where: { id: shiftA.id } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shiftB.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: callerA.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: callerB.id } }).catch(() => {});
  }
});
```

- [ ] **Step 2: Run it**

Run: `node --import tsx --test server/src/voice/parseIntent.test.ts`
Expected: PASS.

- [ ] **Step 3: Write `server/src/voice/interactionLog.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeAtParseTime } from './interactionLog.js';
import type { VoiceIntentResolution } from './parseIntent.js';
import type { ParsedIntent } from './intentSchema.js';

function resolution(attempted: ParsedIntent, response: ParsedIntent): VoiceIntentResolution {
  return { attempted, response };
}

test('outcomeAtParseTime: an attempted UNRECOGNIZED always logs UNRECOGNIZED', () => {
  const unrecognized: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'no match', summary: 'x' };
  assert.equal(outcomeAtParseTime(resolution(unrecognized, unrecognized)), 'UNRECOGNIZED');
});

test('outcomeAtParseTime: a QUERY_MY_SCHEDULE coerced to UNRECOGNIZED by the confidence gate logs LOW_CONFIDENCE, not ANSWERED', () => {
  const attempted: ParsedIntent = { intent: 'QUERY_MY_SCHEDULE', confidence: 0.2, summary: 'You are working Friday.' };
  const coercedResponse: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'not confident enough', summary: 'x' };
  assert.equal(outcomeAtParseTime(resolution(attempted, coercedResponse)), 'LOW_CONFIDENCE');
});

test('outcomeAtParseTime: a genuine above-threshold QUERY_MY_SCHEDULE logs ANSWERED', () => {
  const intent: ParsedIntent = { intent: 'QUERY_MY_SCHEDULE', confidence: 0.95, summary: 'You are working Friday 6pm-close.' };
  assert.equal(outcomeAtParseTime(resolution(intent, intent)), 'ANSWERED');
});

test('outcomeAtParseTime: any other genuine intent logs PENDING_CONFIRMATION', () => {
  const intent: ParsedIntent = { intent: 'MARK_AVAILABILITY', date: '2026-09-25', type: 'UNAVAILABLE', confidence: 0.9, summary: 'Mark you unavailable.' };
  assert.equal(outcomeAtParseTime(resolution(intent, intent)), 'PENDING_CONFIRMATION');
});
```

- [ ] **Step 4: Run it**

Run: `node --import tsx --test server/src/voice/interactionLog.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Append 3 tests to `server/src/routes/voice.test.ts`**

Append at the end of the file (following its existing `withServer`/`sessionFor`/`prisma` conventions exactly):

```ts
test('POST /api/voice/parse-intent: QUERY_MY_SCHEDULE from a STAFF session resolves and logs ANSWERED', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    // This test needs a real Gemini call; skip cleanly in environments with no key configured, same policy as the rest of this file's implicit dependency on GEMINI_API_KEY for /parse-intent coverage.
    return;
  }

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule staff', systemRole: 'STAFF' },
  });
  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: staffCaller.id,
      date: new Date('2026-09-18T00:00:00.000Z'), startTime: new Date('2026-09-18T18:00:00.000Z'), endTime: new Date('2026-09-19T02:00:00.000Z'), status: 'PUBLISHED',
    },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: "what's my next shift" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { intent: { intent: string; summary: string }; voiceLogId: string };
      assert.equal(body.intent.intent, 'QUERY_MY_SCHEDULE', `expected QUERY_MY_SCHEDULE, got ${body.intent.intent}`);
      assert.ok(body.intent.summary.trim().length > 0, 'summary must be a non-empty answer');
      assert.ok(body.voiceLogId);
      voiceLogId = body.voiceLogId;
    });

    const row = await prisma.voiceInteractionLog.findUnique({ where: { id: voiceLogId } });
    assert.ok(row, 'a real VoiceInteractionLog row must exist');
    assert.equal(row!.outcome, 'ANSWERED', 'a resolved QUERY_MY_SCHEDULE must log ANSWERED, not PENDING_CONFIRMATION');
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});

test('POST /api/voice/parse-intent: QUERY_MY_SCHEDULE from a MANAGER session also resolves (STAFF_INTENTS inheritance)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    return;
  }

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule manager', systemRole: 'MANAGER' },
  });
  const shift = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: manager.id,
      date: new Date('2026-09-19T00:00:00.000Z'), startTime: new Date('2026-09-19T09:00:00.000Z'), endTime: new Date('2026-09-19T17:00:00.000Z'), status: 'PUBLISHED',
    },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: "what's my schedule this week" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { intent: { intent: string }; voiceLogId: string };
      assert.equal(body.intent.intent, 'QUERY_MY_SCHEDULE', 'a MANAGER session must also be able to resolve this staff-tier intent');
      voiceLogId = body.voiceLogId;
    });
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/execute: QUERY_MY_SCHEDULE gets a real 400 (fail-closed — this intent never has an execute path)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const staffCaller = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule execute-reject staff', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(staffCaller.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: "what's my next shift",
          intent: { intent: 'QUERY_MY_SCHEDULE', confidence: 0.95, summary: 'You are working Friday.' },
        }),
      });
      // QUERY_MY_SCHEDULE passes ALL_INTENTS/allowedIntentsFor (it's a real,
      // permitted STAFF intent) but has no case in /execute's switch, so it
      // falls to that switch's own `default: 400 'Unknown intent.'` branch —
      // not a 403 (proves this isn't a permission rejection) and not a 500.
      assert.equal(res.status, 400, 'QUERY_MY_SCHEDULE must never execute — it has no mutator to call');
      const body = (await res.json()) as { error: string };
      assert.doesNotMatch(body.error, /does not permit/i, 'must not be misreported as a permission error');
    });
  } finally {
    await prisma.user.delete({ where: { id: staffCaller.id } }).catch(() => {});
  }
});
```

- [ ] **Step 6: Run the full voice test suite**

Run: `node --import tsx --test server/src/routes/voice.test.ts`
Expected: all tests PASS, including the 3 new ones (the 2 Gemini-dependent ones skip cleanly if `GEMINI_API_KEY` isn't set).

- [ ] **Step 7: Run the full server test suite as a final regression check**

Run: `node --import tsx --test --test-concurrency=1 "server/src/**/*.test.ts"`
Expected: PASS (use `--test-concurrency=1` — this repo's default parallel `npm run test:server` has a known, pre-existing, unrelated DB-connection-pool-exhaustion flake under load; serial execution gives an honest signal).

- [ ] **Step 8: Commit**

```bash
git add server/src/voice/parseIntent.test.ts server/src/voice/interactionLog.test.ts server/src/routes/voice.test.ts
git commit -m "test(voice): cover QUERY_MY_SCHEDULE resolution, ANSWERED logging, context scoping, and /execute fail-closed behavior"
```
