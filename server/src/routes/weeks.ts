import { Router } from 'express';
import { isMondayIso, WEEK_START_NOT_MONDAY_ERROR } from '../lib/venueWeek.js';
import { requireSession, requireManager, assertOwnsLocation } from '../middleware/requireSession.js';
import { requireSessionOrKioskToken } from '../middleware/kioskAccess.js';
import { applyWeekPatch, getWeekDoc, previewWeekPublish, publishWeek, type WeekViewer } from '../lib/actions/weekActions.js';
import type { WeekPatchInput } from '../../../shared/rotaWeek.js';

/**
 * Rota builder v2 — the week document API (shared/rotaWeek.ts). Reads are
 * open to any session of the venue (and the kiosk token, which gets the
 * published view); every write is manager-only and goes through
 * lib/actions/weekActions.ts, so the version check, the person-day rules and
 * the audit trail are the same whether the change came from the grid, voice
 * or a template.
 */
export const weeksRouter = Router();

function viewerOf(req: { kioskLocationId?: string; user?: { id: string; systemRole: 'OWNER' | 'MANAGER' | 'STAFF' } }): WeekViewer {
  if (req.kioskLocationId !== undefined || !req.user) return { role: 'KIOSK' };
  return { role: req.user.systemRole, userId: req.user.id };
}

/** GET /api/weeks/:locationId/:weekStart — the week document as this viewer may see it. */
weeksRouter.get('/:locationId/:weekStart', requireSessionOrKioskToken, async (req, res) => {
  try {
    const { locationId, weekStart } = req.params;
    if (!isMondayIso(weekStart)) return res.status(400).json({ error: WEEK_START_NOT_MONDAY_ERROR });
    const week = await getWeekDoc({ locationId, weekStart, viewer: viewerOf(req) });
    return res.status(200).json(week);
  } catch (err) {
    console.error('[weeks.get] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the week.' });
  }
});

/**
 * PATCH /api/weeks/:locationId/:weekStart — body: WeekPatchInput.
 * 200 with the WeekPatchResult on success, 409 with the version_conflict result
 * (and the current week) when the client's version is stale, 422 with
 * `{ error, refusal, op }` when an op breaks a rule.
 */
weeksRouter.patch('/:locationId/:weekStart', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId, weekStart } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    if (!isMondayIso(weekStart)) return res.status(400).json({ error: WEEK_START_NOT_MONDAY_ERROR });
    const body = (req.body ?? {}) as Partial<WeekPatchInput>;
    if (!Array.isArray(body.ops) || body.ops.length === 0) return res.status(400).json({ error: 'ops must be a non-empty array.' });
    if (body.expectedVersion !== undefined && typeof body.expectedVersion !== 'number') {
      return res.status(400).json({ error: 'expectedVersion must be a number when given.' });
    }
    const patch: WeekPatchInput = {
      ops: body.ops,
      expectedVersion: body.expectedVersion,
      overridePendingRequests: body.overridePendingRequests === true,
      note: body.note ? String(body.note).slice(0, 500) : null,
    };
    const result = await applyWeekPatch({ locationId, weekStart, actorId: req.user!.id, source: 'grid', patch, viewer: viewerOf(req) });
    if (result.result === 'version_conflict') return res.status(409).json(result);
    if (result.result === 'refused') return res.status(422).json({ error: result.message, refusal: result.refusal, op: result.op });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[weeks.patch] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the week.' });
  }
});

/** POST /api/weeks/:locationId/:weekStart/publish-preview — the diff and fingerprint the confirm sheet shows. */
weeksRouter.post('/:locationId/:weekStart/publish-preview', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId, weekStart } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    if (!isMondayIso(weekStart)) return res.status(400).json({ error: WEEK_START_NOT_MONDAY_ERROR });
    return res.status(200).json(await previewWeekPublish({ locationId, weekStart }));
  } catch (err) {
    console.error('[weeks.publishPreview] failed', err);
    return res.status(500).json({ error: 'Unexpected error while preparing the publish preview.' });
  }
});

/**
 * POST /api/weeks/:locationId/:weekStart/publish — body: { expectedVersion, fingerprint }.
 * 409 when the version moved or the diff no longer matches the fingerprint
 * (the body carries the fresh preview), 422 when there is nothing to publish.
 */
weeksRouter.post('/:locationId/:weekStart/publish', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId, weekStart } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    if (!isMondayIso(weekStart)) return res.status(400).json({ error: WEEK_START_NOT_MONDAY_ERROR });
    const expectedVersion = req.body?.expectedVersion;
    const fingerprint = req.body?.fingerprint;
    if (typeof expectedVersion !== 'number' || typeof fingerprint !== 'string' || !fingerprint) {
      return res.status(400).json({ error: 'expectedVersion (number) and fingerprint (string) are required — run publish-preview first.' });
    }
    const result = await publishWeek({ locationId, weekStart, actorId: req.user!.id, expectedVersion, fingerprint });
    if (result.result === 'version_conflict' || result.result === 'fingerprint_mismatch') return res.status(409).json(result);
    if (result.result === 'empty') return res.status(422).json({ error: result.message, result: 'empty' });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[weeks.publish] failed', err);
    return res.status(500).json({ error: 'Unexpected error while publishing the week.' });
  }
});
