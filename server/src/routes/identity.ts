import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { createOtpCode, verifyOtpCode, issueSession, phoneDigits } from '../lib/identity.js';

export const identityRouter = Router();

/** POST /api/identity/request-otp — body: { phone } — login path, phone must already match a real User. */
identityRouter.post('/request-otp', async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const digits = phoneDigits(phone);
    const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true, phone: true } });
    const match = users.find((u) => u.phone && phoneDigits(u.phone) === digits);
    if (!match) return res.status(404).json({ error: 'No active staff member found with that phone number.' });

    const { plainCode, expiresAt } = await createOtpCode(phone, 'LOGIN');
    console.log(`[identity] OTP for ${phone} (LOGIN): ${plainCode} — no SMS integration exists; this is a stand-in until one is added.`);

    return res.status(200).json({
      expiresAt: expiresAt.toISOString(),
      devCode: process.env.NODE_ENV === 'production' ? undefined : plainCode,
    });
  } catch (err) {
    console.error('[identity.requestOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while requesting a code.' });
  }
});

/** POST /api/identity/verify-otp — body: { phone, code } */
identityRouter.post('/verify-otp', async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    if (!phone || !code) return res.status(400).json({ error: 'phone and code are required.' });

    const result = await verifyOtpCode(phone, 'LOGIN', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    const digits = phoneDigits(phone);
    const users = await prisma.user.findMany({ where: { isActive: true } });
    const match = users.find((u) => u.phone && phoneDigits(u.phone) === digits);
    if (!match) return res.status(404).json({ error: 'No active staff member found with that phone number.' });

    const { plainToken, expiresAt } = await issueSession(match.id);
    return res.status(200).json({
      token: plainToken,
      expiresAt: expiresAt.toISOString(),
      user: { id: match.id, fullName: match.fullName, jobTitle: match.jobTitle },
    });
  } catch (err) {
    console.error('[identity.verifyOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while verifying the code.' });
  }
});
