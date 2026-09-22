import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession } from '../middleware/requireSession.js';
import { createShoutout } from '../lib/actions/communicationActions.js';

export const shoutoutsRouter = Router();

/**
 * GET /api/shoutouts/:locationId — newest first.
 * Deliberately NOT behind `requireSession` — same kiosk-access-fork decision
 * as `announcements.ts`'s GET (Option 3, 2026-08-31 — see MEMORY.md).
 * Confirmed still correct by the follow-up anonymous-read sweep.
 */
shoutoutsRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const rows = await prisma.shoutout.findMany({
      where: { locationId },
      orderBy: { createdAt: 'desc' },
      include: { employee: { select: { fullName: true } }, author: { select: { fullName: true } } },
    });
    return res.status(200).json({
      shoutouts: rows.map((s) => ({
        id: s.id,
        employeeId: s.employeeId,
        employeeName: s.employee.fullName,
        authorId: s.authorId,
        authorName: s.author?.fullName ?? null,
        shiftSnapshot: s.shiftSnapshot,
        note: s.note,
        createdAt: s.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[shoutouts.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading shoutouts.' });
  }
});

/**
 * POST /api/shoutouts — body: { employeeId, authorId?, shiftSnapshot?, note }.
 * `requireSession`-gated (spec 2026-09-11-voice-post-announcement-shoutout-design.md
 * §2.3a) — same authentication-only fix as announcements.ts's POST above;
 * this route previously required no session at all.
 *
 * `locationId` comes from the caller's own session, not the request body
 * (2026-09-20 tenant-isolation fix — same shape as announcements.ts's POST:
 * `createShoutout` only checked the given locationId *existed*, not that it
 * belonged to the caller, so any signed-in user could shoutout into a
 * different venue's feed by naming its locationId).
 */
shoutoutsRouter.post('/', requireSession, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const employeeId = String(req.body?.employeeId ?? '').trim();
    // Author is the signed-in user, never a body-supplied id — see the
    // matching note on announcements.ts's POST.
    const authorId = req.user!.id;
    const shiftSnapshot = req.body?.shiftSnapshot ? String(req.body.shiftSnapshot).trim() : null;
    const note = String(req.body?.note ?? '').trim();

    if (!employeeId) return res.status(400).json({ error: 'employeeId is required.' });
    if (!note) return res.status(400).json({ error: 'note is required.' });

    const result = await createShoutout({ locationId, employeeId, authorId, shiftSnapshot, note });
    if (result.result !== 'ok') {
      const status = result.result === 'rate_limited' ? 429 : result.result === 'too_long' ? 400 : 404;
      return res.status(status).json({ error: result.message });
    }
    return res.status(201).json({
      shoutout: {
        id: result.shoutout.id,
        employeeId: result.shoutout.employeeId,
        employeeName: result.shoutout.employeeName,
        authorId: result.shoutout.authorId,
        authorName: result.shoutout.authorName,
        shiftSnapshot,
        note: result.shoutout.note,
        createdAt: result.shoutout.createdAt.toISOString(),
      },
    });
  } catch (err) {
    console.error('[shoutouts.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the shoutout.' });
  }
});
