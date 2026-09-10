# AI Voice: Shift Create/Edit + Section Assignment Tools (v1 slice)

Date: 2026-09-09
Status: Approved for implementation planning

## 1. Context

ShiftSync already ships a working voice pipeline: push-to-talk capture in
`AppShell.tsx`, transcription and intent-parsing via Gemini
(`server/src/voice/{transcribe,parseIntent,intentSchema,prompts,model}.ts`),
a confirm-before-execute sheet (`VoiceCommandSheet.tsx`), and a role-scoped
`/api/voice/execute` endpoint that re-derives permissions from the session
and calls the same mutators/validation the REST API uses. This is tested
end-to-end (`server/src/routes/voice.test.ts`) for six intents:
`MARK_AVAILABILITY`, `REQUEST_SWAP`, `APPROVE_SWAP`, `DECLINE_SWAP`,
`APPROVE_JOIN`, `DECLINE_JOIN`.

This spec extends that same pipeline with the next vertical slice the
product brief asked for: **manager voice control of shift creation/editing
and floor-section assignment**, plus three cross-cutting gaps the brief
flagged as non-negotiable that the existing pipeline doesn't yet have:
a confidence threshold, day-one observability for rejected/unclear
commands, and audio-pipeline hardening (recording cap, noise
suppression, vocabulary biasing).

Four scope decisions were confirmed with the product owner before this
spec was written (see conversation record):

1. **Transcription stays on Gemini** — the shipped, tested provider — not
   OpenAI Whisper as the original brief assumed. Domain-vocabulary
   biasing is added to the existing Gemini prompt instead of switching
   providers.
2. **Confidence gating uses a model-self-reported score** (0–1) added to
   the response schema, not a purely binary UNRECOGNIZED-only signal.
3. **Rejected/unclear commands get a dedicated `VoiceInteractionLog`
   table** (small schema migration) rather than console-log-only.
4. **Audio hardening for this slice is a cap reduction + native
   `getUserMedia` noise-suppression constraints**, not a full RNNoise/VAD
   integration (deferred — see §9).

## 2. Goals

- Add `CREATE_SHIFT`, `EDIT_SHIFT`, `ASSIGN_SECTION` as manager-only voice
  intents, following the exact same architectural pattern as the existing
  six: same schema-constrained function-calling, same confirm-before-execute
  UI, same "voice calls the real mutator" guarantee, same location/role
  re-validation at execute time.
- Extract the shift-create, shift-edit, and section-assignment logic
  (currently inlined in `routes/shifts.ts` and `routes/floorPlan.ts`) into
  shared `lib/actions/` functions, so the REST routes and the voice
  `/execute` endpoint call one mutator each — zero duplicated validation.
- Add a numeric confidence gate to the parse step, with a configurable
  threshold, that forces a clarifying response instead of executing when
  the model isn't confident.
- Persist every voice interaction attempt (executed, low-confidence,
  unrecognized, or rejected) to a queryable log, distinct from `AuditLog`.
- Tighten the recording cap and add browser-native noise suppression.
- Add domain-vocabulary biasing (staff/section/role names + ShiftSync
  terms) to the transcription prompt.

## 3. Non-goals (this slice)

- `TimeOffRequest` approve/decline, `RotaPublish`, `RotaTemplate`,
  `Announcement`/`Shoutout` voice tools, and read-only voice queries
  ("who's working Friday") — next slices, same pattern, not built here.
- Any wage/hourly/overtime logic — compensation is flat monthly salary;
  no such logic is introduced anywhere in this feature, matching the
  product's MOHRE/WPS salaried model.
- RNNoise/WASM noise suppression or custom voice-activity-detection
  silence-trimming — deferred (§9).
- Logging a user's explicit "Cancel" tap on the confirm sheet — that's a
  UI dismissal of an otherwise-correct parse, not a phrasing/recognition
  failure, so it doesn't belong in the phrasing-tuning dataset this log
  exists for. Only model-side outcomes (low-confidence, unrecognized) and
  execute-time rejections (permission/validation/error) are logged.
- Switching the STT/LLM provider away from Gemini.

## 4. Data model changes

### 4.1 `VoiceInteractionLog` (new model)

```prisma
model VoiceInteractionLog {
  id            String   @id @default(cuid())
  locationId    String   @map("location_id")
  actorId       String   @map("actor_id")
  transcript    String   @db.Text
  resolvedIntent String  @map("resolved_intent") // raw intent string, e.g. "CREATE_SHIFT", "UNRECOGNIZED"
  confidence    Float?
  outcome       VoiceInteractionOutcome
  declineReason String?  @db.Text
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  location Location @relation(fields: [locationId], references: [id], onDelete: Cascade)
  actor    User     @relation(fields: [actorId], references: [id], onDelete: Cascade)

  @@index([locationId, createdAt])
  @@map("voice_interaction_logs")
}

enum VoiceInteractionOutcome {
  PENDING_CONFIRMATION // parsed above threshold, awaiting the client's /execute call
  LOW_CONFIDENCE        // parsed but below the confidence threshold — coerced to a clarify response
  UNRECOGNIZED           // model returned UNRECOGNIZED outright
  EXECUTED
  REJECTED_VALIDATION   // shape/entity/business-rule rejection inside /execute
  REJECTED_PERMISSION   // role/location permission rejection inside /execute
  ERROR                  // unhandled exception during parse or execute
}
```

Run via `npm run prisma:migrate` (adds a real migration under
`prisma/migrations/`, consistent with existing project convention).

### 4.2 No `AuditAction` changes needed

`SHIFT_CREATED`, `SHIFT_UPDATED`, and `SHIFT_ASSIGNED` already exist in
the `AuditAction` enum and are already what the REST routes use for these
three operations. Voice-originated rows continue the existing
`note: '[voice] "<transcript>"'` convention (already covered by
`voice.test.ts` assertions) — this already satisfies "tag voice-originated
rows distinctly from UI-originated ones." No new field on `AuditLog`.

## 5. Backend: mutator extraction

Mirror the existing `lib/actions/{swapActions,joinActions,availabilityActions}.ts`
pattern **exactly**, including where validation lives. Looking at the
precedent closely: `swapActions.ts`'s `createSwapRequest()` is a pure
mutator (takes already-validated input, does the `prisma.shiftSwapRequest.create`
call, nothing else) — the shift-ownership and target-user-location checks
live in each *caller* (`routes/swapRequests.ts`'s POST, and
`routes/voice.ts`'s `REQUEST_SWAP` case, independently, worded slightly
differently for each surface's error copy). This spec follows that same
division, not a new fully-centralized-validation variant — consistent
with how the six shipped intents already work, so a reviewer familiar
with `swapActions.ts` sees the same shape here.

**`server/src/lib/actions/shiftActions.ts`** (new)
- `createShift(data, client = prisma)` — exactly the
  `tx.shift.create({ data, include: SHIFT_INCLUDE })` call
  `shiftsRouter.post('/')` makes today, parameterized. No validation
  inside — the caller (REST route or voice execute) validates
  `roleId`/`userId` existence and same-location membership first, exactly
  as `shiftsRouter.post('/')` already does today.
- `updateShift(id, data, client = prisma)` — exactly the
  `tx.shift.update({ where: { id }, data, include: SHIFT_INCLUDE })` call
  `shiftsRouter.patch('/:id')` makes today. Same division: caller
  validates first.
- Both re-export `SHIFT_INCLUDE` and a `ShiftWithRelations` type so
  `routes/shifts.ts`, `routes/voice.ts`, and their tests share one
  Prisma-payload type instead of redefining the include shape.

**`server/src/lib/actions/sectionActions.ts`** (new)
- `upsertSectionAssignment(data, client = prisma)` — exactly the
  `tx.sectionAssignment.upsert(...)` call
  `floorPlanRouter.post('/assignments')` makes today (including the
  `hasDutyLabelKey` conditional-update semantics — that flag becomes an
  explicit parameter, not re-derived). Caller validates section/staff
  existence and same-location membership first, exactly as
  `floorPlanRouter.post('/assignments')` already does today.

`routes/shifts.ts` and `routes/floorPlan.ts` are modified to call these
extracted functions instead of inlining the `tx.shift.create`/`.update`/
`.upsert` calls, wrapped in `withAuditedTransaction` exactly as before.
**No behavior change** to the REST API or its validation — this is a
pure mechanical extraction of the write call only, matching the
precedent already noted in `auditLog.ts`'s comments about
`withAuditedTransaction` being introduced the same way. `routes/voice.ts`
duplicates the same validation these routes already do (matching how
`REQUEST_SWAP` duplicates `routes/swapRequests.ts`'s validation today)
and then calls the same extracted mutator.

Existing REST route tests (`shifts.test.ts`, `floorPlan.test.ts`) must
continue passing unmodified — they're the regression guard that the
extraction didn't change behavior.

## 6. Backend: voice intent schema & context

### 6.1 `intentSchema.ts`

- Add `'CREATE_SHIFT'`, `'EDIT_SHIFT'`, `'ASSIGN_SECTION'` to
  `MANAGER_INTENTS` only (not `STAFF_INTENTS` — structural role scoping,
  same mechanism as today: a STAFF session's Gemini call never receives
  these in its schema at all).
- Extend `ParsedIntent` union:
  ```ts
  | { intent: 'CREATE_SHIFT'; roleId: string; date: string; start: string; end: string; userId: string | null; confidence: number; summary: string }
  | { intent: 'EDIT_SHIFT'; shiftId: string; roleId?: string; date?: string; start?: string; end?: string; userId?: string | null; confidence: number; summary: string }
  | { intent: 'ASSIGN_SECTION'; sectionId: string; staffId: string; shiftDate: string; period: 'AM' | 'PM'; dutyLabel: string | null; confidence: number; summary: string }
  ```
- **`confidence` becomes a required field on every variant of the union**,
  including the six existing ones — not just the three new ones. Gating
  has to be uniform or old intents silently bypass the new threshold
  check. Update `schemaFor()` to add `confidence: { type: Type.NUMBER }`
  to `required`, and update the five existing `ParsedIntent` variants (in
  both `intentSchema.ts` and the mirrored client type in `src/api/voice.ts`)
  to include it.
- `time` fields (`start`/`end`) reuse the same `HH:MM` string shape
  `shiftsRouter.post('/')` already validates — the model is prompted to
  emit that format, and `validateIntentShape` (§6.3) re-validates it
  server-side exactly like the existing `DATE_RE` check does for dates.

### 6.2 `prompts.ts` / context (`parseIntent.ts`'s `buildContext`)

For manager-tier callers only, add to `PromptContext`:
- `roles: { id: string; name: string }[]` — `prisma.role.findMany({ where: { locationId } })`.
- `weekShifts: { id: string; roleName: string; date: string; start: string; end: string; assigneeName: string | null }[]`
  — shifts from venue-local "today" through +7 days, same bounded window
  the existing `callerShifts` query uses, scoped to the venue (not just
  the caller) since a manager needs to reference any shift.
- `floorSections: { id: string; label: string }[]` —
  `prisma.floorSection.findMany({ where: { locationId } })`.

Prompt additions (mirroring the existing "Known staff… id, never invent
one" pattern):
- List roles, this week's shifts, and floor sections the same way staff
  are listed today.
- Explicit instruction: "If you cannot find a confident, unambiguous
  match for a role, shift, section, or staff member in the lists above,
  or if the requested date/time is ambiguous, respond with UNRECOGNIZED
  and explain why — never guess an id that isn't listed, and never
  invent a time." (Extends the existing "never guess an id" sentence.)
- Explicit instruction to self-report `confidence` honestly: "Set
  confidence to how certain you are that this exactly matches what the
  caller asked for and that every id/date/time you filled in is correct
  — lower it whenever a name, date, or time was even slightly ambiguous
  before you resolved it."

### 6.3 Confidence threshold gate

In `parseIntent.ts`:
```ts
const CONFIDENCE_THRESHOLD = 0.6;
```
After `normalizeParsedIntent(raw)` returns a non-`UNRECOGNIZED` intent,
if `intent.confidence < CONFIDENCE_THRESHOLD`, replace it with an
`UNRECOGNIZED`-shaped result before returning — reusing the existing
`VoiceCommandSheet` "didn't catch that" UI path unchanged. The *original*
attempted intent and its confidence are still what gets written to
`VoiceInteractionLog` (§7) as `LOW_CONFIDENCE`, not lost — only the
*response returned to the client* is coerced.

`validateIntentShape` in `routes/voice.ts` gets three new cases
(`CREATE_SHIFT`, `EDIT_SHIFT`, `ASSIGN_SECTION`) with the same
shape-only pre-Prisma checks the existing cases use (required fields
present, date/time regex shape) — this is defense-in-depth against a
hand-crafted client body, exactly as documented in the existing comment
above that function.

## 7. Backend: interaction logging

New helper `server/src/voice/interactionLog.ts`:
- `logParsedInteraction(user, transcript, intent, outcome)` — called once
  at the end of `parseVoiceIntent()` (in `voice.ts`'s `/parse-intent`
  handler, after the function returns, so a `VoiceIntentError` from the
  Gemini call itself is never logged as a fabricated "attempt" — only
  real parses are). Writes one `VoiceInteractionLog` row and returns its
  `id`. `/parse-intent`'s response body gains a `voiceLogId` field.
- `updateInteractionOutcome(logId, outcome, declineReason?)` — called
  from `/execute` right before each response is sent: `EXECUTED` on
  success, `REJECTED_PERMISSION` on the existing 403 branch,
  `REJECTED_VALIDATION` on the existing 400/404/409 branches, `ERROR` on
  the catch-all. `/execute`'s request body gains an optional
  `voiceLogId` (sent by the client, round-tripped from `/parse-intent`'s
  response) — if absent (a hand-crafted request), execution proceeds
  exactly as it does today, just without an outcome update to log; this
  is observability, not a security gate, so its absence must never
  change execute's behavior.

`outcome` at parse-time is `UNRECOGNIZED` (model said so),
`LOW_CONFIDENCE` (§6.3's coercion), or `PENDING_CONFIRMATION` (a real,
above-threshold intent, awaiting execute). `resolvedIntent` is always the
*original* model output's `intent` string, even when coerced for the
client response — the log should reflect what the model actually tried,
not what the user was shown.

## 8. Frontend

- `src/api/voice.ts`: add `confidence: number` to all seven `ParsedIntent`
  variants (six existing + `UNRECOGNIZED`... `UNRECOGNIZED` itself has no
  confidence concept, leave it out same as server-side type), add the
  three new variants, add `voiceLogId: string` to `parseVoiceIntent`'s
  return type and thread it through `executeVoiceIntent`'s request body.
- `AppShell.tsx`: store `voiceLogId` alongside `voiceResult` state; pass
  it through in `handleVoiceConfirm`'s call to `executeVoiceIntent`.
- `VoiceCommandSheet.tsx`: no structural change — `intent.summary` already
  renders whatever plain-English sentence the model produces, and the
  prompt (§6.2) already requires one for these three new intents, e.g.
  "Create a Bartender shift for Ahmed, Friday 6pm–2am" or "Move Ahmed to
  the Bar section, Friday PM."
- `AppShell.tsx` audio capture:
  - `MAX_RECORDING_MS` (or equivalent constant) drops from 45000 to
    10000, matching the brief's 8–10s cap.
  - `getUserMedia({ audio: true })` becomes
    `getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true } })`.

## 9. Explicitly deferred (follow-up slices)

- RNNoise/WASM noise suppression and custom energy-based VAD
  silence-trimming before upload — native `getUserMedia` constraints are
  the v1 bar; revisit if real floor-noise testing (§10) shows they're
  insufficient.
- `TIME_OFF` (approve/decline), `RotaPublish`, `RotaTemplate`,
  `Announcement`/`Shoutout` voice tools, and read-only voice queries.
- Logging user-initiated Cancel on the confirm sheet.

## 10. Testing plan

**Automated (this slice, before merge):**
- `server/src/lib/actions/shiftActions.test.ts`,
  `sectionActions.test.ts` — unit-level coverage of the extracted
  mutators (moved/adapted from whatever inline coverage `shifts.test.ts`/
  `floorPlan.test.ts` already had for these code paths).
- `routes/shifts.test.ts`, `routes/floorPlan.test.ts` — must pass
  unmodified after extraction (regression guard on §5).
- `routes/voice.test.ts` — new cases per new intent, following the
  existing test file's exact structure (a real Express app on an
  ephemeral port, real Prisma fixtures, cleanup in `finally`):
  - MANAGER executes `CREATE_SHIFT` → real `Shift` row, `SHIFT_CREATED`
    audit row with `[voice]` note.
  - MANAGER executes `EDIT_SHIFT` → partial update applied correctly.
  - MANAGER executes `ASSIGN_SECTION` → real `SectionAssignment` upsert.
  - STAFF session hand-crafting any of the three → 403, nothing changes
    (same pattern as the existing `APPROVE_SWAP` STAFF-rejection test).
  - Cross-location `roleId`/`userId`/`sectionId` on each → 404, nothing
    changes (same pattern as the existing cross-location swap/join
    tests).
  - A parsed intent with `confidence` below threshold → `/parse-intent`
    returns an `UNRECOGNIZED`-shaped response; the underlying
    `VoiceInteractionLog` row records `LOW_CONFIDENCE` with the real
    attempted intent, not `UNRECOGNIZED`.
  - `/execute` with a valid `voiceLogId` → the log row's `outcome`
    updates to `EXECUTED`/`REJECTED_VALIDATION`/`REJECTED_PERMISSION` to
    match the response.
  - `/execute` with no `voiceLogId` (hand-crafted request) → behaves
    identically to today, just skips the log update.

**Manual QA (before this goes near a real shift — brief's explicit
requirement, cannot be satisfied by me in this environment):**
- Clean-room pass with a real manager voice, all three new intents.
- Real floor-noise recordings (kitchen noise, background music,
  overlapping voices) and a range of staff accents, run against the
  actual Gemini transcription endpoint, transcript-accuracy reviewed by
  a human.
- I can build a fixture-runner script (`scripts/voice-fixture-test.ts`:
  reads audio files from a folder + an expected-transcript manifest,
  calls `transcribeAudio` for each, reports diffs) as scaffolding for
  this — but the actual noisy/accented recordings must come from the
  team; I have no way to generate or source real floor audio.

## 11. Rollout

No feature flag — matches how the existing six intents shipped directly.
Migration (`VoiceInteractionLog`) is additive-only, no backfill needed,
safe to deploy ahead of the frontend/backend code that populates it.
