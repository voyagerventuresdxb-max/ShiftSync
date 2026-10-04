import { Router } from 'express';
import { requireSession } from '../middleware/requireSession.js';
import { aiUsageSummary } from '../lib/aiBudget.js';

export const aiRouter = Router();

/**
 * GET /api/ai/usage[?locationId=] — the AI spend cap's state for the signed-in
 * OWNER: the shared month-to-date estimate and the monthly limit, today's calls
 * and the daily call limit, whether AI is currently paused, and this venue's
 * own share. Owners only; asking about any venue other than the caller's own
 * is refused.
 */
aiRouter.get('/usage', requireSession, async (req, res) => {
  if (req.user!.systemRole !== 'OWNER') return res.status(403).json({ error: 'Only the venue owner can see AI usage.' });
  const asked = typeof req.query.locationId === 'string' ? req.query.locationId.trim() : '';
  if (asked && asked !== req.user!.locationId) return res.status(403).json({ error: 'You do not have access to this location.' });
  try {
    return res.status(200).json(await aiUsageSummary(req.user!.locationId));
  } catch (err) {
    console.error('[ai.usage] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading AI usage.' });
  }
});
