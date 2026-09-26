import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { createOtpCode, verifyOtpCode, issueSession } from '../lib/identity.js';
import { findPhoneMatches } from './identity.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { DEFAULT_ROLES } from '../../../shared/defaultRoles.js';
import { otpRequestRateLimiters, otpVerifyRateLimiters } from '../middleware/rateLimit.js';
import { devOtpEchoEnabled, logDevOtpEcho } from '../lib/devOtpEcho.js';

export const signupRouter = Router();

/**
 * POST /api/signup/request-otp — body: { phone }
 *
 * Brand-new-venue signup path — deliberately distinct from `/api/join`
 * (self-registration against an EXISTING location's roster). There is no
 * `locationId` here because there is no location yet; that's the entire
 * point of this route.
 */
signupRouter.post('/request-otp', ...otpRequestRateLimiters, async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const { plainCode, expiresAt } = await createOtpCode(phone, 'SIGNUP');
    // No SMS integration exists; this is a stand-in until one is added.
    const echo = devOtpEchoEnabled();
    if (echo) logDevOtpEcho('signup', phone, 'SIGNUP', plainCode);

    return res.status(200).json({
      expiresAt: expiresAt.toISOString(),
      devCode: echo ? plainCode : undefined,
    });
  } catch (err) {
    console.error('[signup.requestOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while requesting a code.' });
  }
});

/**
 * POST /api/signup/verify-otp — body: { phone, code, fullName, venueName }
 *
 * On success, creates a brand-new Organization + Location + User(OWNER) in
 * one transaction — a partial failure here (e.g. the User create failing
 * after Org/Location already committed) would otherwise leave an orphaned,
 * ownerless venue behind. This is deliberately the first of a 5-screen
 * wizard (Welcome → Venue → Roster → Review → Invite); the Venue screen
 * collects the venue's real emirate/address/venueType right after this, so
 * only the bare minimum is collected here.
 */
signupRouter.post('/verify-otp', ...otpVerifyRateLimiters, async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    const fullName = String(req.body?.fullName ?? '').trim();
    const venueName = String(req.body?.venueName ?? '').trim();
    if (!phone || !code) return res.status(400).json({ error: 'phone and code are required.' });
    if (!fullName) return res.status(400).json({ error: 'fullName is required.' });
    if (!venueName) return res.status(400).json({ error: 'venueName is required.' });

    const result = await verifyOtpCode(phone, 'SIGNUP', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    // Global check — no location scope exists yet. Reuses identity.ts's own
    // lookup rather than re-implementing the same lossy phoneDigits filter a
    // second time — one lookup, one place to fix if normalization ever
    // changes. Returns ALL matches, not just the first, because two
    // genuinely different numbers can normalize to the same digits and
    // User.phone has no unique constraint (yet — a pending migration will
    // eventually enforce this at the DB level too; this is the
    // application-layer enforcement in the meantime).
    const existingMatches = await findPhoneMatches(phone);
    if (existingMatches.length > 0) {
      return res.status(409).json({ error: 'An account already exists for this phone number — log in instead.' });
    }

    // Sensible defaults for fields not yet collected: Organization.name
    // reuses venueName (one org started by one signup is the normal case;
    // there's no distinct "restaurant group" name at this stage), and
    // Location.name is the real venue name. Location.timezone/currency are
    // intentionally omitted so Prisma applies the schema's own @default
    // (Asia/Dubai / AED) rather than hand-copying a value that could drift
    // from the column default. venueType/emirate/address are left unset —
    // venueType specifically must stay null, not venueName: it's a
    // categorical value from the wizard's own Venue-step card-select
    // (VENUE_TYPES in shared/venueTypes.ts — "Fine Dining", "Bar / Lounge", etc.),
    // not the venue's own name, and that step collects it next.
    const { user } = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({ data: { name: venueName } });
      const location = await tx.location.create({
        data: { organizationId: organization.id, name: venueName },
      });
      const user = await tx.user.create({
        data: { locationId: location.id, fullName, phone, systemRole: 'OWNER' },
      });
      // Zero-setup scheduling: the venue can build its first rota the moment
      // signup finishes, with no roster upload and no admin setup step (the
      // Locations → Departments → Roles chore 7shifts makes an admin do by
      // hand first). Ordinary Role rows — renamed/removed/added later from
      // the Staff Directory. See shared/defaultRoles.ts.
      await tx.role.createMany({ data: DEFAULT_ROLES.map((name) => ({ locationId: location.id, name })) });
      // AuditAction has no dedicated "venue/location created" value; STAFF_CREATED
      // is reused here as the closest existing fit (a new Owner IS a new User),
      // per the task brief's explicit go-ahead rather than adding a new enum
      // value mid-task. entityType is 'Location' since the row's real subject
      // is the new venue's creation, not just the User row.
      await writeAuditLog(tx, {
        locationId: location.id,
        actorId: user.id,
        action: 'STAFF_CREATED',
        entityType: 'Location',
        entityId: location.id,
        note: `[signup] New venue "${venueName}" created via self-service signup; owner: ${fullName}.`,
      });
      return { location, user };
    });

    const { plainToken, expiresAt } = await issueSession(user.id);
    return res.status(201).json({
      token: plainToken,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        fullName: user.fullName,
        jobTitle: user.jobTitle,
        locationId: user.locationId,
        systemRole: user.systemRole,
      },
    });
  } catch (err) {
    console.error('[signup.verifyOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while verifying the code.' });
  }
});
