# AI Voice: Publish Rota + Apply Rota Template (v1 slice)

## 1. Context

This is the fourth voice slice, built on `feat/voice-query-my-schedule` (confirmed as the branch holding the most recent merged voice work: Gemini STT, `/parse-intent`, confidence-gated resolution via `CONFIDENCE_THRESHOLD = 0.6`, confirm-before-execute as two separate endpoints, `VoiceInteractionLog`, role-scoped `MANAGER_INTENTS`/`STAFF_INTENTS`, the read-only `QUERY_MY_SCHEDULE` pattern, and compound-request detection via `hasAdditionalRequest`).

Today `MANAGER_INTENTS` covers `MARK_AVAILABILITY`, `REQUEST_SWAP`, `QUERY_MY_SCHEDULE` (inherited from staff), plus `APPROVE_SWAP`, `DECLINE_SWAP`, `APPROVE_JOIN`, `DECLINE_JOIN`, `CREATE_SHIFT`, `EDIT_SHIFT`, `ASSIGN_SECTION`. This slice adds two more manager-only intents: `PUBLISH_ROTA` and `APPLY_ROTA_TEMPLATE`.

Unlike every mutator wired to voice so far, the two mutators this slice needs — `POST /api/shifts/:locationId/publish` (`shifts.ts`) and `POST /api/rota-templates/:id/apply` (`rotaTemplates.ts`) — are still inline in their route handlers. `shiftActions.ts`, `sectionActions.ts`, and `swapActions.ts` already exist in `server/src/lib/actions/` from prior slices; this slice adds `rotaActions.ts` to the same directory.

## 2. Decision (already made — this spec documents it, not re-derives it)

**2.1 — `PUBLISH_ROTA`'s confirm-preview count is computed server-side, deterministically, never left to the model.**

Every existing intent's confirm-preview is just the model's own `summary` string — free text the model composes from context. That's fine when being wrong costs a misworded sentence. It is not fine here: the task requires the preview to state an exact shift count and exact staff count, and trusting the model to both retrieve and arithmetic-check those numbers from a `weekShifts` context array (capped at 200 rows) is exactly the shape of failure this repo has already been burned by once (the hardcoded-flag/duty-label incident cited in the task). A miscounted confirm-preview is worse than no preview — it's a specific, checkable-sounding claim that's wrong.

So: the model still resolves *which* week (`weekStart`, using the same relative-date resolution `CREATE_SHIFT`/`MARK_AVAILABILITY` already do against `today` in context) and still produces its own `summary` for logging/fallback purposes, but the `/parse-intent` handler recomputes the authoritative count itself, once `weekStart` is known, via a new exported read function (`getRotaPublishPreview`, §6) that reuses the exact `groupBy` the REST route already uses — not a new query shape, not an unbounded one. That count **replaces** the model's summary in the response sent to the client for `PUBLISH_ROTA` specifically. Every other intent's `summary` is untouched.

If the resolved week has zero shifts, the preview short-circuits to a rejection (mirrors the REST route's existing 400 "No shifts exist for this week yet.") rather than showing "This will publish 0 shifts across 0 staff — confirm?".

**2.2 — `APPLY_ROTA_TEMPLATE` fuzzy-matching is model-driven, with a server-side ambiguity backstop — not a bespoke Levenshtein utility as the sole mechanism.**

No string-similarity helper exists anywhere in this repo today (confirmed by direct search — `server/src/parsing/templates.ts`'s "fuzzy" matching is exact-membership against a fixed alias list, a different problem entirely). Two options were weighed:

- **(a) Pure server-side edit-distance matching**: transcript's spoken template reference vs. every saved `RotaTemplate.name` for the location, scored by a new Levenshtein-ratio helper, threshold-gated.
- **(b) Model-driven resolution** (the pattern every other id-bearing intent already uses — `roleId`, `staffId`, `sectionId` are all resolved by the model picking from a list handed to it in context): feed saved template names + ids into `PromptContext` (manager-tier only) exactly like `roles`/`floorSections` are fed today, let the model return a `templateId` directly.

Chosen: **(b), with a server-side backstop that does not depend on the model's own `confidence` field alone.** Relying solely on the model's stated confidence for a name-similarity judgment is the same failure shape as the incident this task explicitly warns against — an opaque, unverifiable decision executed silently. So in addition to `templateId`, the model also returns the raw `templateName` text it matched against (a new nullable schema field, same pattern as `targetUserName` alongside `targetUserId` on `REQUEST_SWAP`). The server then independently re-derives a match using a small, local, well-tested string-similarity helper (`server/src/lib/textSimilarity.ts`, new file — normalized Levenshtein ratio, ~20 lines, no dependency) between the model's `templateName` and every saved template name for the location:

- If the model's `templateId` names an existing template **and** that template's own name scores above the similarity floor (0.6) against the model's `templateName` **and** no other saved template scores within 0.1 of it (no close runner-up) → resolve, proceed to confirm-preview showing the real matched template's name.
- Otherwise (no valid `templateId`, ambiguous margin, or low similarity score) → do not execute. Respond with a clarifying question listing the 2–3 closest candidate template names by score, same shape as an `UNRECOGNIZED` response but with a clarification-specific reason, so the client can prompt "did you mean X or Y?" instead of a bare "could not understand."

This gives the exact behavior the task asks for (fuzzy match resolves confidently; a close-but-wrong or genuinely ambiguous name asks rather than guesses) while keeping resolution structurally consistent with how every other entity reference already resolves in this pipeline, and keeping the ambiguity check independently verifiable/testable rather than trusting one opaque confidence number.

**2.3 — Both mutators' validation moves INTO the extracted action function, not just the raw write.**

`sectionActions.ts`/`swapActions.ts`'s established split — "validation stays in the caller" — works there because each caller's validation is 2–3 lines. It does not work here: `applyRotaTemplate`'s validation (template exists + owned, every entry's `roleId` exists and is same-location, every entry's `userId` exists and is same-location, on-behalf-of-user check) is substantial, and this slice has an explicit, non-negotiable requirement — "No parallel validation logic between the two callers" — that a validate-in-caller split would violate the moment `voice.ts`'s `/execute` case duplicates that block.

So `publishRota`/`applyRotaTemplate` follow `decideSwapRequest`'s shape instead: the action function does its own existence/ownership checks internally and returns a discriminated result (`{ result: 'ok', ... } | { result: 'not_found', message } | { result: 'invalid_reference', message } | ...`), and each caller (REST route, voice `/execute`) just translates that result into its own response shape. Zero duplicated validation logic between them. This is a deliberate, spec-documented deviation from the `sectionActions.ts` precedent, justified by this slice's explicit anti-duplication requirement — not a change to how simpler future extractions should work.

## 3. Goals

- `PUBLISH_ROTA`: manager says "publish this week's rota" / "publish the schedule for next week" → resolves week → shows accurate, server-computed shift/staff counts → on confirm, publishes via the same mutator the REST UI uses.
- `APPLY_ROTA_TEMPLATE`: manager says "apply the holiday template to next week" / "use the Ramadan schedule for this week" → resolves template by fuzzy name match (or asks for clarification) → resolves week → shows a preview naming the real matched template → on confirm, applies via the same mutator the REST UI uses.
- Both intents structurally absent from `STAFF_INTENTS`/the staff Gemini schema — not filtered post-hoc.
- `RotaPublish` and `RotaTemplate.apply` mutators extracted into `lib/actions/rotaActions.ts`; REST routes become thin wrappers; voice's `/execute` calls the identical functions.

## 4. Non-goals (this slice)

- No new fuzzy-matching UI for browsing/searching templates outside voice.
- No change to `RotaTemplate` creation/deletion (already using `withAuditedTransaction` one-liners; untouched).
- No change to how `RotaPublish`'s REST-facing `publish-status` GET endpoint works.
- No general-purpose string-similarity library adoption beyond the one local helper this slice needs.
- No retry/undo for a voice-triggered publish — same as the REST UI today, publishing is not reversible via a voice "undo" command.

## 5. Data model changes

None. `RotaPublish` and `RotaTemplate` schemas are unchanged. `VoiceInteractionLog` already has the columns prior slices added (`hasAdditionalRequest`, outcome fields); no new columns needed — a clarifying question for `APPLY_ROTA_TEMPLATE` reuses the existing low-confidence/`UNRECOGNIZED`-shaped response path, not a new outcome type.

## 6. Backend: mutator extraction (`server/src/lib/actions/rotaActions.ts`, new file)

```ts
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { withAuditedTransaction } from '../auditLog.js';
import { notifySchedulePublished } from '../scheduleNotifications.js';
import { combineDateAndTime, DEFAULT_VENUE_TIMEZONE } from '../venueTime.js'; // exact helper names TBC against existing imports in shifts.ts/rotaTemplates.ts

interface TemplateEntry {
  dayOffset: number;
  roleId: string;
  userId: string | null;
  start: string;
  end: string;
  note?: string;
}

// --- Read: publish preview (also used by /parse-intent to compute PUBLISH_ROTA's accurate count) ---
export async function getRotaPublishPreview(
  locationId: string,
  weekStart: Date,
): Promise<{ shiftCount: number; staffCount: number }> {
  // Exactly the groupBy currently inline in shifts.ts's POST /:locationId/publish —
  // moved here verbatim so the route, and /parse-intent's preview computation,
  // can never drift on what "affected shifts/staff" means.
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const shiftGroups = await prisma.shift.groupBy({
    by: ['userId'],
    where: { locationId, date: { gte: weekStart, lt: weekEnd } },
    _count: true,
  });
  const shiftCount = shiftGroups.reduce((sum, g) => sum + g._count, 0);
  const staffCount = shiftGroups.filter((g) => g.userId !== null).length;
  return { shiftCount, staffCount };
}

// --- Write: publish ---
export type PublishRotaResult =
  | { result: 'ok'; publishedAt: Date; notifiedCount: number; affectedUserIds: string[] }
  | { result: 'not_found'; message: string }
  | { result: 'empty'; message: string };

export async function publishRota(input: {
  locationId: string;
  weekStart: Date;
  publishedById: string;
}): Promise<PublishRotaResult> {
  const location = await prisma.location.findUnique({ where: { id: input.locationId } });
  if (!location) return { result: 'not_found', message: `Location "${input.locationId}" not found.` };

  const { shiftCount, staffCount } = await getRotaPublishPreview(input.locationId, input.weekStart);
  if (shiftCount === 0) return { result: 'empty', message: 'No shifts exist for this week yet.' };

  const weekEnd = new Date(input.weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const publishedAt = new Date();
  const shiftGroups = await prisma.shift.groupBy({
    by: ['userId'],
    where: { locationId: input.locationId, date: { gte: input.weekStart, lt: weekEnd } },
    _count: true,
  });
  const notifiedCount = staffCount;
  const affectedUserIds = shiftGroups
    .filter((g): g is typeof g & { userId: string } => g.userId !== null)
    .map((g) => g.userId);

  const [publish] = await prisma.$transaction([
    prisma.rotaPublish.upsert({
      where: { locationId_weekStart: { locationId: input.locationId, weekStart: input.weekStart } },
      create: { locationId: input.locationId, weekStart: input.weekStart, publishedAt, publishedById: input.publishedById, notifiedCount },
      update: { publishedAt, publishedById: input.publishedById, notifiedCount },
    }),
    prisma.shift.updateMany({
      where: { locationId: input.locationId, date: { gte: input.weekStart, lt: weekEnd } },
      data: { status: 'PUBLISHED', updatedAt: publishedAt },
    }),
  ]);

  return { result: 'ok', publishedAt: publish.publishedAt, notifiedCount: publish.notifiedCount, affectedUserIds };
}

// Split out exactly like notifySwapRequested/notifySwapDecided in swapActions.ts —
// never called inside the transaction above; caller does `void notifyRotaPublished(...)` after.
export async function notifyRotaPublished(affectedUserIds: string[], weekStart: string): Promise<void> {
  await notifySchedulePublished(affectedUserIds, weekStart);
}

// --- Write: apply template ---
export type ApplyRotaTemplateResult =
  | { result: 'ok'; createdCount: number; templateName: string }
  | { result: 'template_not_found'; message: string }
  | { result: 'invalid_role'; roleId: string; message: string }
  | { result: 'invalid_user'; userId: string; message: string };

export async function applyRotaTemplate(input: {
  templateId: string;
  weekStart: Date;
  createdById: string;
  actorId: string; // for the audit row; may differ from createdById the same way rotaTemplates.ts's on-behalf-of path allows today
}): Promise<ApplyRotaTemplateResult> {
  const template = await prisma.rotaTemplate.findUnique({ where: { id: input.templateId } });
  if (!template) return { result: 'template_not_found', message: `Template "${input.templateId}" not found.` };

  const entries = template.entries as unknown as TemplateEntry[];
  const roleIds = [...new Set(entries.map((e) => e.roleId))];
  const userIds = [...new Set(entries.map((e) => e.userId).filter((v): v is string => v !== null))];

  const roles = await prisma.role.findMany({ where: { id: { in: roleIds } } });
  const rolesById = new Map(roles.map((r) => [r.id, r]));
  for (const roleId of roleIds) {
    const role = rolesById.get(roleId);
    if (!role || role.locationId !== template.locationId) {
      return { result: 'invalid_role', roleId, message: `Role "${roleId}" not found.` };
    }
  }
  if (userIds.length > 0) {
    const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
    const usersById = new Map(users.map((u) => [u.id, u]));
    for (const userId of userIds) {
      const user = usersById.get(userId);
      if (!user || user.locationId !== template.locationId) {
        return { result: 'invalid_user', userId, message: `Staff member "${userId}" not found.` };
      }
    }
  }

  const location = await prisma.location.findUnique({ where: { id: template.locationId }, select: { timezone: true } });
  const timezone = location?.timezone || DEFAULT_VENUE_TIMEZONE;

  const created = await withAuditedTransaction(
    prisma,
    async (tx) => {
      const rows: { id: string }[] = [];
      for (const e of entries) {
        const date = new Date(input.weekStart);
        date.setUTCDate(date.getUTCDate() + e.dayOffset);
        const dateStr = date.toISOString().slice(0, 10);
        const overnight = e.end <= e.start;
        rows.push(
          await tx.shift.create({
            data: {
              locationId: template.locationId, roleId: e.roleId, userId: e.userId, createdById: input.createdById,
              date, startTime: combineDateAndTime(dateStr, e.start, timezone), endTime: combineDateAndTime(dateStr, e.end, timezone, overnight),
              managerNotes: e.note ?? null, status: 'DRAFT',
            },
          }),
        );
      }
      return rows;
    },
    (rows) => ({
      locationId: template.locationId, actorId: input.actorId, action: 'SHIFT_CREATED', entityType: 'Shift',
      entityId: rows[0]?.id ?? input.templateId,
      note: `Applied template "${template.name}" to week ${input.weekStart.toISOString().slice(0, 10)} — created ${rows.length} shift(s)`,
    }),
  );
  return { result: 'ok', createdCount: created.length, templateName: template.name };
}
```

`shifts.ts`'s `POST /:locationId/publish` and `rotaTemplates.ts`'s `POST /:id/apply` become thin wrappers: keep their own request-shape validation (weekStart regex, on-behalf-of-user resolution) and `assertOwnsLocation`/`requireManager` gating exactly as today, call `publishRota`/`applyRotaTemplate`, then map the discriminated result to the existing HTTP status codes (`not_found`/`template_not_found`/`invalid_role`/`invalid_user` → 404, `empty` → 400, `ok` → 200/201 with the existing response body shape unchanged — no REST API contract change).

**New file**: `server/src/lib/textSimilarity.ts` — normalized Levenshtein-ratio helper (`similarity(a: string, b: string): number`, 0–1), plus `bestMatch(query: string, candidates: { id: string; name: string }[]): { best: { id, name, score } | null; runnerUp: { id, name, score } | null }` used by the `APPLY_ROTA_TEMPLATE` ambiguity check (§2.2). Unit-tested directly (exact match → 1.0, empty-string edge case, case/whitespace normalization, a genuinely ambiguous pair).

## 7. Backend: voice intent schema & context

### 7.1 `intentSchema.ts`

```ts
export const MANAGER_INTENTS = [
  ...STAFF_INTENTS,
  'APPROVE_SWAP', 'DECLINE_SWAP', 'APPROVE_JOIN', 'DECLINE_JOIN',
  'CREATE_SHIFT', 'EDIT_SHIFT', 'ASSIGN_SECTION',
  'PUBLISH_ROTA', 'APPLY_ROTA_TEMPLATE',
] as const;
```

New `ParsedIntent` variants:

```ts
| { intent: 'PUBLISH_ROTA'; weekStart: string; confidence: number; summary: string }
| { intent: 'APPLY_ROTA_TEMPLATE'; templateId: string | null; templateName: string; weekStart: string; confidence: number; summary: string }
```

New shared `properties` fields (nullable, same flat-object convention as every existing field):

- `weekStart: { type: STRING, nullable: true, description: 'YYYY-MM-DD, the Monday of the target week, for PUBLISH_ROTA/APPLY_ROTA_TEMPLATE — resolve relative phrases like "this week"/"next week" against today.' }`
- `templateId: { type: STRING, nullable: true, description: 'For APPLY_ROTA_TEMPLATE — one of the ids in the provided rota-templates list, if you can confidently match the spoken template name to one.' }`
- `templateName: { type: STRING, nullable: true, description: 'For APPLY_ROTA_TEMPLATE — the template name as referenced in the transcript (verbatim or your best normalization), even if you are not fully certain which saved template it maps to.' }`

`intentSchemaFor`/`allowedIntentsFor` need no changes beyond the `MANAGER_INTENTS` array update — both already derive from it.

### 7.2 `parseIntent.ts` — `buildContext()`

Inside the existing `if (user.systemRole !== 'STAFF')` branch (manager-tier only — same structural-absence pattern as `roles`/`floorSections`/`weekShifts`), add:

```ts
const templates = await prisma.rotaTemplate.findMany({
  where: { locationId: user.locationId },
  select: { id: true, name: true },
});
ctx.rotaTemplates = templates;
```

No new bounded-window concern here — this is a per-location list of saved templates, inherently small (not a growing-over-time collection like shifts).

`PUBLISH_ROTA`'s shift/staff count is deliberately **not** added to `buildContext()` — per §2.1, that count can't be computed until `weekStart` is resolved, which only happens after the model returns its response. It's computed in `/parse-intent` itself (§8), not fed in as pre-context.

### 7.3 `prompts.ts`

`buildSystemPrompt` gets the manager-tier prompt extended with the two new intents' descriptions and examples (mirroring the existing per-intent example-phrasing blocks), plus an explicit instruction for `APPLY_ROTA_TEMPLATE`: "If you are not confident which saved template the caller means, still set `templateName` to your best reading of what they said, but leave `templateId` null or lower `confidence` rather than guessing the nearest name." And the list of `ctx.rotaTemplates` names+ids gets rendered into the prompt the same way `ctx.roles`/`ctx.floorSections` already are.

## 8. Backend: `/parse-intent` + `/execute` wiring (`server/src/routes/voice.ts`)

### 8.1 `/parse-intent`

After `parseVoiceIntent` returns `resolution`, before the existing response is built, add a post-process step specific to the two new intents (only runs when `resolution.response.intent` is one of them — every other intent's response passes through unchanged):

- **`PUBLISH_ROTA`**: parse `weekStart` to a `Date`, call `getRotaPublishPreview(locationId, weekStart)`. If `shiftCount === 0`, replace `resolution.response` with an `UNRECOGNIZED`-shaped rejection ("There are no shifts scheduled for the week of {weekStart} yet — nothing to publish."). Otherwise, overwrite `resolution.response.summary` with the deterministic string: `` `This will publish ${shiftCount} shift${shiftCount === 1 ? '' : 's'} across ${staffCount} staff member${staffCount === 1 ? '' : 's'} for the week of ${weekStart} — confirm?` ``.
- **`APPLY_ROTA_TEMPLATE`**: call `bestMatch(resolution.response.templateName, ctx.rotaTemplates)` (re-fetch or thread through from `buildContext`'s result — the same list already built once this request). Apply §2.2's rule: model's `templateId` valid + matches best-match id + score ≥ 0.6 + no runner-up within 0.1 → keep `templateId`, overwrite `summary` to name the real matched template ("Apply template \"{name}\" to the week of {weekStart} — confirm?"). Otherwise → replace `resolution.response` with a clarification-shaped rejection listing the top 2–3 candidate names by score ("I'm not sure which saved template you meant — did you mean \"{a}\" or \"{b}\"? Please say the template name again.").

`voiceLogId`/interaction-logging behavior is unchanged — the *attempted* (pre-coercion) intent is still what's logged, exactly as the existing confidence-threshold coercion already works; this is the same coercion mechanism, just with two new trigger conditions layered on top of the existing confidence check, not a parallel logging path.

### 8.2 `/execute`

Two new `switch` cases, following the `CREATE_SHIFT` case's validate → mutate → audit → respond shape (validation here is minimal per-case since `publishRota`/`applyRotaTemplate` now own their own existence/ownership checks per §2.3 — the case just maps the discriminated result to a status code):

```ts
case 'PUBLISH_ROTA': {
  const weekStart = new Date(`${intent.weekStart}T00:00:00.000Z`);
  const result = await publishRota({ locationId, weekStart, publishedById: actorId });
  if (result.result === 'not_found') return respond(404, { error: result.message }, 'REJECTED_VALIDATION', result.message);
  if (result.result === 'empty') return respond(400, { error: result.message }, 'REJECTED_VALIDATION', result.message);
  void notifyRotaPublished(result.affectedUserIds, intent.weekStart);
  return respond(200, { executed: true, result: { publishedAt: result.publishedAt.toISOString(), notifiedCount: result.notifiedCount } }, 'EXECUTED');
}
case 'APPLY_ROTA_TEMPLATE': {
  if (!intent.templateId) return respond(400, { error: 'No template was resolved for this request.' }, 'REJECTED_VALIDATION', 'templateId missing');
  const weekStart = new Date(`${intent.weekStart}T00:00:00.000Z`);
  const result = await applyRotaTemplate({ templateId: intent.templateId, weekStart, createdById: actorId, actorId });
  if (result.result !== 'ok') return respond(404, { error: result.message }, 'REJECTED_VALIDATION', result.message);
  return respond(201, { executed: true, result: { createdCount: result.createdCount, templateName: result.templateName } }, 'EXECUTED');
}
```

`validateIntentShape` gets two new cases mirroring the existing date-shape checks (`weekStart` matches `DATE_RE` and round-trips through `Date`; `APPLY_ROTA_TEMPLATE` additionally requires non-empty `templateName`).

## 9. Frontend

`VoiceCommandSheet.tsx`'s confirm-sheet already renders `intent.summary` as the confirm text for every mutating intent — no new component needed, since §8.1's server-side summary override means `PUBLISH_ROTA`/`APPLY_ROTA_TEMPLATE` confirm-previews arrive pre-formatted with accurate counts/matched-template-name exactly like every other intent's summary. The only frontend change is `src/api/voice.ts`'s `ParsedIntent` TypeScript type mirroring the two new union members from `intentSchema.ts` (kept in sync the same way prior slices' frontend types were).

## 10. Explicitly deferred (follow-up slices)

- Voice-driven creation/deletion of `RotaTemplate`s themselves (this slice only applies an existing one).
- A "which templates exist" query intent (parallel to `QUERY_MY_SCHEDULE`) — a manager can already see this via the RotaBuilder UI.
- Undo/rollback of a voice-triggered publish.
- Compound requests that chain `PUBLISH_ROTA`/`APPLY_ROTA_TEMPLATE` with another intent in one utterance — falls under the existing generic `hasAdditionalRequest` follow-up flow, no special-casing needed here.

## 11. Testing plan

**Automated (this slice, before merge):**
- `rotaActions.test.ts`: `getRotaPublishPreview` against a real seeded multi-shift, multi-staff week (not empty/trivial) — assert exact counts. `publishRota` ok/empty/not_found paths. `applyRotaTemplate` ok/template_not_found/invalid_role/invalid_user paths, real seeded template + roles + staff.
- `textSimilarity.test.ts`: exact match, close-but-imperfect match resolves (score ≥ 0.6, no ambiguous runner-up), genuinely ambiguous pair (two saved templates both score close) triggers the "no confident match" branch, case/whitespace normalization.
- `voice.execute.test.ts` additions: `PUBLISH_ROTA` end-to-end against a populated week asserting the response's `notifiedCount`/shift count match the seeded data; `APPLY_ROTA_TEMPLATE` end-to-end both the clean-resolve path and the low-confidence-clarification path (assert `executed: false`-shaped clarification response, not a silent apply); a `STAFF`-session request for either intent asserts 403 at the `allowedIntentsFor` gate, same as existing role-boundary tests for prior manager-only intents.
- Full existing suite run (`npm run test:server` via the branch-schema/connection-limit wrapper) to confirm no regression in the extracted-but-behaviorally-identical REST routes.

**Manual QA (real floor-noise/accent testing, carried over from prior slices):**
- "Publish this week's rota" / "publish the schedule for next week" spoken in a noisy environment — confirm-preview states real counts, not a placeholder.
- "Apply the holiday template to next week" against a real saved template named something close-but-not-identical (e.g. saved as "Winter Holiday Schedule", spoken as "the holiday template") — confirms without asking.
- Two similarly-named saved templates (e.g. "Ramadan Sahur" and "Ramadan Closing") — spoken ambiguously → clarifying question, not a silent pick.

## 12. Rollout

No feature flag, matching how every prior intent shipped. Extraction (rotaActions.ts + REST route thin-wrapping) is a behavior-preserving refactor and can land independently of the voice wiring if useful to split the PR — spec doesn't mandate a split, plan (§ implementation plan) may sequence it as an early, easily-reviewable task regardless.
