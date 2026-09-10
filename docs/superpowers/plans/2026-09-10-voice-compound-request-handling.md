# AI Voice: Compound Request Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when a single voice command contains more than one distinct request, resolve and act on the primary one exactly as today, and prompt the caller to speak any additional request as a separate, later command — never executing, queuing, or guessing at the second request's content.

**Architecture:** A model-self-reported boolean, `hasAdditionalRequest`, is added to the Gemini response schema alongside the existing `intent`/`confidence`/`summary` shape (`server/src/voice/intentSchema.ts`), threaded through `parseVoiceIntent` (`parseIntent.ts`) as a new field on `VoiceIntentResolution` — completely independent of the confidence gate — logged unconditionally to `VoiceInteractionLog` for telemetry (`interactionLog.ts`), and surfaced to the client only when the primary intent's own response did not end up `UNRECOGNIZED` (`shouldPromptForAdditionalRequest`). `VoiceCommandSheet.tsx` gains a new terminal "there's more, go again" state, reached only after the primary intent has actually executed (mutating) or been shown (read-only `QUERY_MY_SCHEDULE`).

**Tech Stack:** Express, Prisma/PostgreSQL, `@google/genai` (Gemini structured output), `node:test` + `node:assert/strict`, React 19, TypeScript strict, Tailwind v4 (`@theme inline` tokens in `src/styles/tailwind.css`).

**Spec:** `docs/superpowers/specs/2026-09-10-voice-compound-request-handling-design.md`

## Global Constraints

- `hasAdditionalRequest` is judged by the model independently of `confidence`/`intent` resolution — nothing in this feature may make the confidence-threshold gate (`CONFIDENCE_THRESHOLD` in `parseIntent.ts`) read or branch on it (spec §5.2, §8).
- `hasAdditionalRequest` is a top-level sibling field alongside `intent`/`voiceLogId` in `/parse-intent`'s response and `parseVoiceIntent`'s client type — it is never added to the `ParsedIntent` union or any of its ten variants (spec §5.1, §7.1).
- The raw, model-reported `hasAdditionalRequest` is always what gets written to `VoiceInteractionLog` — never the display-suppressed value. Suppression (when the primary response is `UNRECOGNIZED`) only ever affects what the client sees, not what gets logged (spec §6.2, §8).
- No new intents, no change to `/execute`, no parsing or reuse of any part of the transcript for a "second request" — the caller must always speak it again as a new, separate command (spec §3).
- No feature flag — matches how every prior voice-pipeline change has shipped (spec §11).
- Existing tests (`intentSchema.test.ts`, `parseIntent.test.ts`, `interactionLog.test.ts`'s existing cases, `voice.test.ts`'s existing cases) must keep passing unmodified throughout, except where a task explicitly updates a shared test helper (Task 4).
- This branches on top of `feat/voice-query-my-schedule` (the latest voice feature branch) — every file/line reference below is against that branch's current state.

---

## File Structure

**New files:** none — every change is additive to an existing voice-pipeline file.

**Modified files:**
- `prisma/schema.prisma` — add `hasAdditionalRequest` column to `VoiceInteractionLog`.
- `server/src/voice/intentSchema.ts` — add `hasAdditionalRequest` to `schemaFor()`'s properties.
- `server/src/voice/prompts.ts` — add the model instruction for setting `hasAdditionalRequest`.
- `server/src/voice/parseIntent.ts` — extend `VoiceIntentResolution`, compute the flag in `parseVoiceIntent`.
- `server/src/voice/interactionLog.ts` — persist the column, add `shouldPromptForAdditionalRequest`.
- `server/src/voice/interactionLog.test.ts` — extend the `resolution()` helper, add unit tests for the new helper.
- `server/src/routes/voice.ts` — thread the (suppressed) flag into `/parse-intent`'s response.
- `server/src/routes/voice.test.ts` — new live-Gemini integration cases.
- `src/api/voice.ts` — mirror the new field on `parseVoiceIntent`'s return type.
- `src/components/shiftsync/AppShell.tsx` — `voiceResult` state, `handleVoiceConfirm` branch, sheet props.
- `src/components/shiftsync/VoiceCommandSheet.tsx` — new follow-up state/copy.

---

### Task 1: `VoiceInteractionLog.hasAdditionalRequest` column + migration

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `VoiceInteractionLog.hasAdditionalRequest: boolean` (Prisma-generated field, defaults to `false`). Consumed by Task 5 (write) and Task 9 (test assertions).

- [ ] **Step 1: Add the column to the `VoiceInteractionLog` model**

Find the model (search for `model VoiceInteractionLog`) and add `hasAdditionalRequest` between `confidence` and `outcome`:

```prisma
model VoiceInteractionLog {
  id                   String                  @id @default(cuid())
  locationId           String                  @map("location_id")
  actorId              String                  @map("actor_id")
  transcript           String                  @db.Text
  resolvedIntent       String                  @map("resolved_intent")
  confidence           Float?
  hasAdditionalRequest Boolean                 @default(false) @map("has_additional_request")
  outcome              VoiceInteractionOutcome
  declineReason        String?                 @map("decline_reason") @db.Text
  createdAt            DateTime                @default(now()) @map("created_at")
  updatedAt            DateTime                @updatedAt @map("updated_at")

  location Location @relation(fields: [locationId], references: [id], onDelete: Cascade)
  actor    User     @relation(fields: [actorId], references: [id], onDelete: Cascade)

  @@index([locationId, createdAt])
  @@map("voice_interaction_logs")
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npm run prisma:migrate -- --name add_voice_interaction_log_has_additional_request`
Expected: a new folder under `prisma/migrations/` containing `ALTER TABLE "voice_interaction_logs" ADD COLUMN "has_additional_request" BOOLEAN NOT NULL DEFAULT false;`, applied with no errors; `prisma generate` runs automatically as part of `migrate dev`.

- [ ] **Step 3: Verify the Prisma client picked up the new field**

Run: `npm run server:typecheck`
Expected: no errors (confirms `@prisma/client`'s generated `VoiceInteractionLog` type now includes `hasAdditionalRequest: boolean`, even though nothing writes it yet).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add hasAdditionalRequest column to VoiceInteractionLog"
```

---

### Task 2: Detect the flag — `intentSchema.ts` + `prompts.ts`

**Files:**
- Modify: `server/src/voice/intentSchema.ts:33-61`
- Modify: `server/src/voice/prompts.ts:79-84`

**Interfaces:**
- Produces: every Gemini response for `/parse-intent` may now include a top-level `hasAdditionalRequest: boolean` field in its raw JSON (in addition to `intent`/`confidence`/`summary`/etc.). Consumed by Task 3 (`parseIntent.ts` reads `raw.hasAdditionalRequest`).

- [ ] **Step 1: Add the property to `schemaFor()` in `intentSchema.ts`**

Replace lines 33-61 (the whole `schemaFor` function body) with:

```ts
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
      hasAdditionalRequest: {
        type: Type.BOOLEAN,
        nullable: true,
        description:
          'True if the transcript contains more than one distinct actionable request beyond the one captured in `intent` — set this independently of how confident you are about `intent`/`confidence`. Examples of two requests in one utterance: "move Ahmed to bar and create a shift for Layla Saturday", "what is my schedule and also move Ahmed to the bar Friday PM". A single request with extra detail (a reason, a time range) is NOT two requests.',
      },
      summary: { type: Type.STRING, description: "One plain-English sentence describing exactly what will happen, for the confirm step — except for QUERY_MY_SCHEDULE, where this is the direct answer to the caller's question instead." },
      unrecognizedReason: { type: Type.STRING, nullable: true, description: 'Only for intent=UNRECOGNIZED — why this could not be resolved' },
    },
    required: ['intent', 'summary'],
  };
}
```

Note: `hasAdditionalRequest` stays `nullable: true` and out of `required`, exactly like `confidence` — Task 3's normalizer fails closed to `false` on an absent/malformed value, the same pattern `confidence` already uses (fails closed to `0`).

- [ ] **Step 2: Add the prompt instruction in `prompts.ts`**

Replace lines 79-84 (the final `lines.push(...)` call) with:

```ts
  lines.push(
    ``,
    `If a name, date, time, role, shift, or section is ambiguous or you cannot find a confident match in the lists above, respond with intent=UNRECOGNIZED and explain why in unrecognizedReason — never guess an id that isn't listed above, and never invent a date or time.`,
    `Always fill in "summary" with one plain-English sentence describing exactly what will happen if this is confirmed (except for QUERY_MY_SCHEDULE, where summary is the direct answer itself, as described above) — e.g. "Mark you unavailable on Friday, August 29th", "Approve Sarah's swap request for her Tuesday shift", "Create a Bartender shift for Ahmed, Friday 6pm-2am", or "Move Ahmed to the Bar section, Friday PM."`,
    `Always fill in "confidence" (0 to 1) with how certain you are that this exactly matches what the caller asked for and that every id/date/time you filled in is correct — lower it whenever a name, date, or time was even slightly ambiguous before you resolved it.`,
    `Always fill in "hasAdditionalRequest" (true/false): set it to true if the transcript contains more than one distinct actionable request — even if you can only confidently resolve one of them into "intent". Judge this independently of "confidence": being unsure whether there's a second request must never lower your confidence in the one you did resolve, and being very confident in "intent" must never stop you from flagging a second request if one is genuinely there. Do not try to describe or resolve the second request anywhere in your response — the caller will be asked to state it again separately.`,
  );
```

- [ ] **Step 3: Typecheck**

Run: `npm run server:typecheck`
Expected: no errors — this task only adds an optional schema property and a string literal, nothing downstream references `hasAdditionalRequest` yet.

- [ ] **Step 4: Commit**

```bash
git add server/src/voice/intentSchema.ts server/src/voice/prompts.ts
git commit -m "feat(voice): detect compound requests via a hasAdditionalRequest schema flag"
```

---

### Task 3: Thread the flag through `parseVoiceIntent`

**Files:**
- Modify: `server/src/voice/parseIntent.ts:131-177`

**Interfaces:**
- Consumes: `raw.hasAdditionalRequest` (Task 2's new schema property, present on the parsed JSON `raw` object at line 161).
- Produces: `VoiceIntentResolution.hasAdditionalRequest: boolean` — always the model's raw, uncoerced signal. Consumed by Task 4 (`interactionLog.ts`), Task 5 (`routes/voice.ts`).

- [ ] **Step 1: Extend the `VoiceIntentResolution` interface**

Replace lines 131-136:

```ts
export interface VoiceIntentResolution {
  /** What the client should see/act on — coerced to UNRECOGNIZED if below CONFIDENCE_THRESHOLD. */
  response: ParsedIntent;
  /** What the model actually returned, uncoerced — always logged as-is. */
  attempted: ParsedIntent;
  /** What the model reported for hasAdditionalRequest, uncoerced — always logged as-is (see interactionLog.ts), regardless of what outcome/response the caller ends up seeing. */
  hasAdditionalRequest: boolean;
}
```

- [ ] **Step 2: Compute the flag and thread it through both return branches**

Replace lines 151-169 (from `try {` through the end of the `if`/`return` block, i.e. everything up to but not including the `} catch (err) {` line):

```ts
  try {
    const response = await client.models.generateContent({
      model: voiceModel(),
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    });
    const raw = JSON.parse(response.text ?? '{}');
    const attempted = normalizeParsedIntent(raw);
    // A missing/non-boolean value fails CLOSED to false — an absent flag
    // must never fabricate a "there's more" prompt the model didn't
    // actually make. Computed independently of confidence/the gate below —
    // this line must never move inside either branch of that gate.
    const hasAdditionalRequest = typeof raw.hasAdditionalRequest === 'boolean' ? raw.hasAdditionalRequest : false;
    if (attempted.intent === 'UNRECOGNIZED' || attempted.confidence >= CONFIDENCE_THRESHOLD) {
      return { response: attempted, attempted, hasAdditionalRequest };
    }
    return {
      response: { intent: 'UNRECOGNIZED', reason: `I understood this as "${attempted.summary}" but wasn't confident enough to act on it without you rephrasing.`, summary: 'Could not confidently resolve this command.' },
      attempted,
      hasAdditionalRequest,
    };
```

- [ ] **Step 3: Typecheck**

Run: `npm run server:typecheck`
Expected: an error in `server/src/voice/interactionLog.test.ts` — the `resolution()` test helper builds `VoiceIntentResolution` literals with only `{ attempted, response }`, missing the now-required `hasAdditionalRequest` field. This is expected and fixed in Task 4. Confirm no OTHER file has a new error.

- [ ] **Step 4: Commit**

```bash
git add server/src/voice/parseIntent.ts
git commit -m "feat(voice): compute hasAdditionalRequest independently of the confidence gate"
```

---

### Task 4: Log the flag + `shouldPromptForAdditionalRequest`

**Files:**
- Modify: `server/src/voice/interactionLog.ts`
- Modify: `server/src/voice/interactionLog.test.ts`

**Interfaces:**
- Consumes: `VoiceIntentResolution.hasAdditionalRequest` (Task 3).
- Produces: `logParsedInteraction` now persists `hasAdditionalRequest` on every row. `shouldPromptForAdditionalRequest(resolution): boolean` — new exported pure function. Consumed by Task 5 (`routes/voice.ts`).

- [ ] **Step 1: Write the failing unit tests**

Replace the whole file `server/src/voice/interactionLog.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeAtParseTime, shouldPromptForAdditionalRequest } from './interactionLog.js';
import type { VoiceIntentResolution } from './parseIntent.js';
import type { ParsedIntent } from './intentSchema.js';

function resolution(attempted: ParsedIntent, response: ParsedIntent, hasAdditionalRequest = false): VoiceIntentResolution {
  return { attempted, response, hasAdditionalRequest };
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

test('shouldPromptForAdditionalRequest: true + a genuine pending-confirmation intent -> true', () => {
  const intent: ParsedIntent = { intent: 'MARK_AVAILABILITY', date: '2026-09-25', type: 'UNAVAILABLE', confidence: 0.9, summary: 'Mark you unavailable.' };
  assert.equal(shouldPromptForAdditionalRequest(resolution(intent, intent, true)), true);
});

test('shouldPromptForAdditionalRequest: true + a genuine QUERY_MY_SCHEDULE (answer-only) -> true', () => {
  const intent: ParsedIntent = { intent: 'QUERY_MY_SCHEDULE', confidence: 0.95, summary: 'You are working Friday 6pm-close.' };
  assert.equal(shouldPromptForAdditionalRequest(resolution(intent, intent, true)), true);
});

test('shouldPromptForAdditionalRequest: true + attempted genuinely UNRECOGNIZED -> false', () => {
  const unrecognized: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'no match', summary: 'x' };
  assert.equal(shouldPromptForAdditionalRequest(resolution(unrecognized, unrecognized, true)), false);
});

test('shouldPromptForAdditionalRequest: true + a real intent coerced to UNRECOGNIZED by the confidence gate -> false', () => {
  const attempted: ParsedIntent = { intent: 'ASSIGN_SECTION', sectionId: 's1', staffId: 'u1', shiftDate: '2026-09-25', period: 'PM', dutyLabel: null, confidence: 0.2, summary: 'Move Ahmed to the Bar section.' };
  const coercedResponse: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'not confident enough', summary: 'x' };
  assert.equal(shouldPromptForAdditionalRequest(resolution(attempted, coercedResponse, true)), false);
});

test('shouldPromptForAdditionalRequest: false -> false regardless of intent', () => {
  const intent: ParsedIntent = { intent: 'QUERY_MY_SCHEDULE', confidence: 0.95, summary: 'You are working Friday 6pm-close.' };
  assert.equal(shouldPromptForAdditionalRequest(resolution(intent, intent, false)), false);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm run test:server -- --test-name-pattern shouldPromptForAdditionalRequest`
Expected: FAIL — `shouldPromptForAdditionalRequest` is not exported from `./interactionLog.js` yet.

- [ ] **Step 3: Implement — replace `server/src/voice/interactionLog.ts`**

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
export function outcomeAtParseTime(resolution: VoiceIntentResolution): VoiceInteractionOutcome {
  if (resolution.attempted.intent === 'UNRECOGNIZED') return 'UNRECOGNIZED';
  if (resolution.response.intent === 'UNRECOGNIZED') return 'LOW_CONFIDENCE';
  if (resolution.response.intent === 'QUERY_MY_SCHEDULE') return 'ANSWERED';
  return 'PENDING_CONFIRMATION';
}

/**
 * Whether the client-facing response should carry the "there's more, go
 * again" signal. False whenever the primary intent's own response ended up
 * UNRECOGNIZED — whether the model genuinely didn't understand it, or the
 * confidence gate coerced it there — since compounding a "didn't catch
 * that" message with a "there's more" prompt in the same turn would read as
 * two separate problems instead of one. The raw hasAdditionalRequest signal
 * is still always logged via logParsedInteraction below, regardless of this
 * function's result — this only gates what the CALLER sees, not what gets
 * recorded.
 */
export function shouldPromptForAdditionalRequest(resolution: VoiceIntentResolution): boolean {
  return resolution.hasAdditionalRequest && resolution.response.intent !== 'UNRECOGNIZED';
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
      hasAdditionalRequest: resolution.hasAdditionalRequest,
      outcome: outcomeAtParseTime(resolution),
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Called from /execute right before its response is sent, to record the
 * final outcome of a PENDING_CONFIRMATION row. Scoped to `actorId` — a
 * client can send an arbitrary `voiceLogId` in its /execute request body,
 * and without this scope that would let any authenticated session overwrite
 * another user's (or another location's) audit-trail row. `updateMany`
 * silently no-ops when `logId` doesn't belong to `actorId`, consistent with
 * this call's already-established best-effort/non-blocking semantics (it's
 * wrapped in a `.catch()` at the call site).
 */
export async function updateInteractionOutcome(
  logId: string,
  actorId: string,
  outcome: VoiceInteractionOutcome,
  declineReason?: string,
): Promise<void> {
  await prisma.voiceInteractionLog.updateMany({
    where: { id: logId, actorId },
    data: { outcome, declineReason: declineReason ?? null },
  });
}
```

- [ ] **Step 4: Run to verify all tests pass**

Run: `npm run test:server -- --test-name-pattern "outcomeAtParseTime|shouldPromptForAdditionalRequest"`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/voice/interactionLog.ts server/src/voice/interactionLog.test.ts
git commit -m "feat(voice): log hasAdditionalRequest, add shouldPromptForAdditionalRequest"
```

---

### Task 5: Wire the flag into `/parse-intent`'s response

**Files:**
- Modify: `server/src/routes/voice.ts:176-210`

**Interfaces:**
- Consumes: `shouldPromptForAdditionalRequest` (Task 4).
- Produces: `/parse-intent`'s JSON response gains a top-level `hasAdditionalRequest: boolean` field. Consumed by Task 6 (`src/api/voice.ts`).

- [ ] **Step 1: Import `shouldPromptForAdditionalRequest`**

`server/src/routes/voice.ts` currently imports from `../voice/interactionLog.js` via two separate statements (line 8 and line 16). Replace line 8:

```ts
import { logParsedInteraction, shouldPromptForAdditionalRequest } from '../voice/interactionLog.js';
```

Leave line 16 (`import { updateInteractionOutcome } from '../voice/interactionLog.js';`) untouched.

- [ ] **Step 2: Compute and return the flag**

Replace lines 195-201:

```ts
    let voiceLogId: string | null = null;
    try {
      voiceLogId = await logParsedInteraction({ id: req.user!.id, locationId: req.user!.locationId }, transcript, resolution);
    } catch (logErr) {
      console.error('[voice.parseIntent] failed to write interaction log', logErr);
    }
    return res.status(200).json({
      transcript,
      intent: resolution.response,
      voiceLogId,
      hasAdditionalRequest: shouldPromptForAdditionalRequest(resolution),
    });
```

- [ ] **Step 3: Typecheck**

Run: `npm run server:typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/voice.ts
git commit -m "feat(voice): surface hasAdditionalRequest from /parse-intent"
```

---

### Task 6: Mirror the field in the frontend API client

**Files:**
- Modify: `src/api/voice.ts:74-81`

**Interfaces:**
- Produces: `parseVoiceIntent`'s return type gains `hasAdditionalRequest: boolean`. Consumed by Task 7 (`AppShell.tsx`).

- [ ] **Step 1: Update `parseVoiceIntent`'s return type**

Replace lines 74-81:

```ts
/** POST /api/voice/parse-intent — body: { transcript }. Never mutates anything — the "propose" half of confirm-before-execute. */
export async function parseVoiceIntent(
  token: string,
  transcript: string,
): Promise<{ transcript: string; intent: ParsedIntent; voiceLogId: string | null; hasAdditionalRequest: boolean }> {
  return request('/api/voice/parse-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ transcript }),
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors — `request<T>`'s generic return is inferred from the call site, so widening the annotated type here is enough; no runtime change.

- [ ] **Step 3: Commit**

```bash
git add src/api/voice.ts
git commit -m "feat(voice): mirror hasAdditionalRequest in the frontend voice API client"
```

---

### Task 7: `AppShell.tsx` — carry the flag through the confirm flow

**Files:**
- Modify: `src/components/shiftsync/AppShell.tsx:137, 173-197, 274-291, 360-366`

**Interfaces:**
- Consumes: `parseVoiceIntent`'s `hasAdditionalRequest` (Task 6).
- Produces: `voiceResult.hasAdditionalRequest: boolean` and `voiceResult.executed?: boolean` state; `<VoiceCommandSheet hasAdditionalRequest executed>` props. Consumed by Task 8 (`VoiceCommandSheet.tsx`).

- [ ] **Step 1: Extend the `voiceResult` state type (line 137)**

Replace:
```ts
  const [voiceResult, setVoiceResult] = useState<{ transcript: string; intent: ParsedIntent; voiceLogId: string | null } | null>(null);
```
with:
```ts
  const [voiceResult, setVoiceResult] = useState<{
    transcript: string;
    intent: ParsedIntent;
    voiceLogId: string | null;
    hasAdditionalRequest: boolean;
    /** True once the primary MUTATING intent has actually executed — the sheet stays open in its follow-up state instead of closing. Irrelevant for QUERY_MY_SCHEDULE, which has no execute step. */
    executed?: boolean;
  } | null>(null);
```

- [ ] **Step 2: Store the new field in `handleRecordingComplete` (lines 185-189)**

Replace:
```ts
      setVoiceProcessing(true);
      try {
        const { transcript } = await transcribeAudio(session.token, blob);
        const { intent, voiceLogId } = await parseVoiceIntent(session.token, transcript);
        setVoiceResult({ transcript, intent, voiceLogId });
```
with:
```ts
      setVoiceProcessing(true);
      try {
        const { transcript } = await transcribeAudio(session.token, blob);
        const { intent, voiceLogId, hasAdditionalRequest } = await parseVoiceIntent(session.token, transcript);
        setVoiceResult({ transcript, intent, voiceLogId, hasAdditionalRequest });
```

- [ ] **Step 3: Branch `handleVoiceConfirm` on the flag (lines 274-291)**

Replace the whole function:

```ts
  const handleVoiceConfirm = useCallback(async () => {
    if (!voiceResult) return;
    if (!session) {
      setVoiceBanner({ kind: 'error', message: 'Sign in to use voice commands.' });
      setVoiceResult(null);
      return;
    }
    setVoiceExecuting(true);
    try {
      await executeVoiceIntent(session.token, voiceResult.transcript, voiceResult.intent, voiceResult.voiceLogId);
      if (voiceResult.hasAdditionalRequest) {
        // Keep the sheet open, transitioned into its follow-up state
        // (VoiceCommandSheet's `executed` prop) — the sheet's own "Done: …"
        // copy plus the follow-up prompt already communicate completion, so
        // no separate success banner fires for this path.
        setVoiceResult({ ...voiceResult, executed: true });
      } else {
        setVoiceBanner({ kind: 'success', message: voiceResult.intent.summary });
        setVoiceResult(null);
      }
    } catch (err) {
      setVoiceBanner({ kind: 'error', message: err instanceof ApiError ? err.message : 'Could not execute the voice command.' });
      setVoiceResult(null);
    } finally {
      setVoiceExecuting(false);
    }
  }, [voiceResult, session]);
```

- [ ] **Step 4: Thread the new props into `<VoiceCommandSheet>` (lines 360-366)**

Replace:
```tsx
      <VoiceCommandSheet
        intent={voiceResult?.intent ?? null}
        transcript={voiceResult?.transcript ?? ''}
        onConfirm={handleVoiceConfirm}
        onCancel={handleVoiceCancel}
        executing={voiceExecuting}
      />
```
with:
```tsx
      <VoiceCommandSheet
        intent={voiceResult?.intent ?? null}
        transcript={voiceResult?.transcript ?? ''}
        hasAdditionalRequest={voiceResult?.hasAdditionalRequest ?? false}
        executed={voiceResult?.executed ?? false}
        onConfirm={handleVoiceConfirm}
        onCancel={handleVoiceCancel}
        executing={voiceExecuting}
      />
```

`handleVoiceCancel` (unchanged, `setVoiceResult(null)`) is reused as-is — it becomes the follow-up state's dismiss action once Task 8 wires it up.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: an error in `VoiceCommandSheet.tsx` — it doesn't accept `hasAdditionalRequest`/`executed` props yet. Expected; fixed in Task 8. Confirm no other file has a new error.

- [ ] **Step 6: Commit**

```bash
git add src/components/shiftsync/AppShell.tsx
git commit -m "feat(voice): thread hasAdditionalRequest through AppShell's confirm flow"
```

---

### Task 8: `VoiceCommandSheet.tsx` — the follow-up state

**Files:**
- Modify: `src/components/shiftsync/VoiceCommandSheet.tsx`

**Interfaces:**
- Consumes: `hasAdditionalRequest`/`executed` props (Task 7).

- [ ] **Step 1: Replace the whole file**

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
  hasAdditionalRequest,
  executed,
  onConfirm,
  onCancel,
  executing,
}: {
  intent: ParsedIntent | null;
  /** What was actually heard. The whole point of confirm-before-execute is catching a mishearing, which is invisible if only the model's paraphrase is shown. */
  transcript: string;
  /** Whether the model detected more than one distinct request in the transcript — only ever acted on once the primary intent has reached its own terminal state (see `showFollowUp` below). */
  hasAdditionalRequest: boolean;
  /** True once the primary MUTATING intent has actually executed. Always false for QUERY_MY_SCHEDULE, which has no execute step — its "shown" moment is this component's own render. */
  executed: boolean;
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
  // The additional-request prompt only ever appears once the primary intent
  // has reached ITS OWN terminal state — after a successful execute for a
  // mutating intent (`executed`, set by AppShell only once /execute has
  // succeeded), or immediately for an answer-only intent (which has no
  // execute step at all). An UNRECOGNIZED/low-confidence primary never
  // shows it: compounding a "didn't catch that" message with a "there's
  // more" prompt in the same turn would read as two separate problems, not
  // one (this is also enforced server-side — see interactionLog.ts's
  // shouldPromptForAdditionalRequest — so `hasAdditionalRequest` itself
  // should never even arrive true alongside isUnrecognized, but the check
  // stays here too as defense-in-depth against a stale/hand-crafted prop).
  const showFollowUp = !isUnrecognized && hasAdditionalRequest && (isAnswerOnly || executed);
  // UNRECOGNIZED's `summary` is typically a generic fallback ("Could not
  // determine what to do."); `reason` is the model's actual explanation of
  // WHY it couldn't resolve the command, and is the only part that teaches
  // the user how to rephrase.
  const reason = isUnrecognized && intent.reason.trim() ? intent.reason : null;

  const eyebrow = isUnrecognized
    ? "Didn't catch that"
    : showFollowUp
      ? 'Got it — one more thing?'
      : isAnswerOnly
        ? 'Your schedule'
        : 'Confirm voice command';
  const dismissLabel = showFollowUp || isAnswerOnly ? 'Got it' : 'Cancel';
  const showConfirmButton = !isUnrecognized && !isAnswerOnly && !showFollowUp;

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
          <p className="mt-2 text-sm">{executed && !isAnswerOnly ? `Done: ${intent.summary}` : intent.summary}</p>
          {reason && <p className="mt-2 text-xs text-foreground/60">{reason}</p>}
          {showFollowUp && (
            // Reuses global.css's .error-block-toast recipe (border/background/
            // color all var(--accent), via the --color-accent Tailwind token) —
            // this codebase's one existing precedent for "prominent, but
            // neither success nor error", which is exactly what this prompt is.
            <p className="mt-3 rounded-lg border border-accent/40 bg-accent/10 p-2 text-sm text-accent">
              I heard something else in there too — what's the next thing you'd like me to do?
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={onCancel} disabled={executing}>
              {dismissLabel}
            </button>
            {showConfirmButton && (
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

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev:all`, sign in as a MANAGER, tap the mic, and speak a compound command (e.g. "Move Ahmed to the bar section this Friday afternoon, and also create a Bartender shift for Layla Saturday 6pm to 2am"). Confirm:
- The sheet first shows the normal confirm view for whichever intent the model resolved (no follow-up copy yet, no matter what `hasAdditionalRequest` came back as — it hasn't reached `executed` yet).
- Tapping Confirm executes it, then the SAME sheet transitions in place to the gold-toned "Got it — one more thing?" state with the "Done: …" line and the follow-up prompt, no Confirm button.
- Tapping "Got it" clears the sheet with no success banner.
- A plain, non-compound command (e.g. "Mark me unavailable this Friday") still ends with the sheet closing and the existing green success banner appearing, unchanged from before this feature.
- A single-request `QUERY_MY_SCHEDULE` ("What's my schedule this week?") still shows the plain "Your schedule" sheet with just the "Got it" button, unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/components/shiftsync/VoiceCommandSheet.tsx
git commit -m "feat(voice): add the compound-request follow-up state to VoiceCommandSheet"
```

---

### Task 9: Integration tests for compound-phrasing detection

**Files:**
- Modify: `server/src/routes/voice.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5 (the full server-side pipeline).

- [ ] **Step 1: Add the new test cases**

Append to the end of `server/src/routes/voice.test.ts` (following the file's existing pattern: real Express app on an ephemeral port via `withServer`, real Prisma fixtures, cleanup in `finally`, skip cleanly when `GEMINI_API_KEY` is absent — see the file's existing `POST /api/voice/parse-intent returns voiceLogId...` test for the exact skip idiom to copy):

```ts
test('POST /api/voice/parse-intent: a mutating+mutating compound transcript resolves only the primary intent and flags hasAdditionalRequest', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    // This test needs a real Gemini call; skip cleanly in environments with no key configured, same policy as the rest of this file's implicit dependency on GEMINI_API_KEY for /parse-intent coverage.
    return;
  }

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ compound manager', systemRole: 'MANAGER' },
  });
  const ahmed = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ Ahmed', systemRole: 'STAFF' },
  });
  const layla = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ Layla', systemRole: 'STAFF' },
  });
  const section = await prisma.floorSection.create({
    data: { locationId: location!.id, label: '__task9-test__ Bar' },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'Move Ahmed to the bar section this Friday afternoon, and also create a Bartender shift for Layla Saturday 6pm to 2am',
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { intent: { intent: string }; voiceLogId: string; hasAdditionalRequest: boolean };
      assert.ok(['ASSIGN_SECTION', 'CREATE_SHIFT'].includes(body.intent.intent), `expected one of the two spoken intents, got ${body.intent.intent}`);
      assert.equal(body.hasAdditionalRequest, true, 'a genuinely compound utterance must set hasAdditionalRequest');
      assert.ok(body.voiceLogId);
      voiceLogId = body.voiceLogId;
    });

    const row = await prisma.voiceInteractionLog.findUnique({ where: { id: voiceLogId } });
    assert.equal(row?.hasAdditionalRequest, true, 'the logged row must record the raw signal regardless of what was displayed');
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.floorSection.delete({ where: { id: section.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: ahmed.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: layla.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/parse-intent: a read-only+mutating compound transcript flags hasAdditionalRequest on the QUERY_MY_SCHEDULE answer-only path', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    // This test needs a real Gemini call; skip cleanly in environments with no key configured, same policy as the rest of this file's implicit dependency on GEMINI_API_KEY for /parse-intent coverage.
    return;
  }

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ compound query manager', systemRole: 'MANAGER' },
  });
  const ahmed = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ query Ahmed', systemRole: 'STAFF' },
  });
  const section = await prisma.floorSection.create({
    data: { locationId: location!.id, label: '__task9-test__ query Bar' },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: "What's my schedule this week, and also move Ahmed to the bar Friday afternoon",
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { intent: { intent: string }; voiceLogId: string; hasAdditionalRequest: boolean };
      assert.ok(['QUERY_MY_SCHEDULE', 'ASSIGN_SECTION'].includes(body.intent.intent), `expected one of the two spoken intents, got ${body.intent.intent}`);
      assert.equal(body.hasAdditionalRequest, true, 'a genuinely compound utterance must set hasAdditionalRequest even on the answer-only path');
      voiceLogId = body.voiceLogId;
    });

    const row = await prisma.voiceInteractionLog.findUnique({ where: { id: voiceLogId } });
    assert.equal(row?.hasAdditionalRequest, true);
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.floorSection.delete({ where: { id: section.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: ahmed.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});

test('POST /api/voice/parse-intent: a plain single-request transcript never flags hasAdditionalRequest', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');
  if (!process.env.GEMINI_API_KEY) {
    // This test needs a real Gemini call; skip cleanly in environments with no key configured, same policy as the rest of this file's implicit dependency on GEMINI_API_KEY for /parse-intent coverage.
    return;
  }

  const staffer = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task9-test__ single-request staffer', systemRole: 'STAFF' },
  });

  let voiceLogId = '';
  try {
    const token = await sessionFor(staffer.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: 'Mark me unavailable this Friday' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { hasAdditionalRequest: boolean; voiceLogId: string };
      assert.equal(body.hasAdditionalRequest, false, 'an ordinary single-request command must not flag hasAdditionalRequest');
      voiceLogId = body.voiceLogId;
    });

    const row = await prisma.voiceInteractionLog.findUnique({ where: { id: voiceLogId } });
    assert.equal(row?.hasAdditionalRequest, false);
  } finally {
    if (voiceLogId) await prisma.voiceInteractionLog.delete({ where: { id: voiceLogId } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffer.id } }).catch(() => {});
  }
});
```

- [ ] **Step 2: Run the full server test suite**

Run: `npm run test:server`
Expected: PASS. The three new tests return early and pass trivially in any environment without `GEMINI_API_KEY` set (same as the file's existing `/parse-intent` tests); with a real key configured, they exercise the live model.

- [ ] **Step 3: If `GEMINI_API_KEY` is available, run once more to confirm the live assertions actually pass**

Run: `npm run test:server`
Expected: PASS, with the three new tests actually executing their assertions (not skipping) — confirms the model reliably sets `hasAdditionalRequest: true` for these specific phrasings and `false` for the plain one. If the model doesn't reliably flag one of the compound phrasings, adjust that test's transcript wording (not the implementation) until it does — the goal is a stable, real example of the behavior, not a specific sentence.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/voice.test.ts
git commit -m "test(voice): cover compound-request detection across a mutating+mutating and read-only+mutating pair"
```

---

## Deferred (see spec §3, §9, not part of this plan)

- Real multi-intent execution or queuing.
- Parsing or reusing the second request's content from the original transcript.
- A numeric confidence score for the `hasAdditionalRequest` judgment itself.
- Auto-restarting the microphone after the follow-up prompt.
