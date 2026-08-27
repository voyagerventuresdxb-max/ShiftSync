import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { join } from 'node:path';
import { schedulesRouter } from './routes/schedules.js';
import { staffDirectoryRouter } from './routes/staffDirectory.js';
import { floorPlanRouter } from './routes/floorPlan.js';
import { announcementsRouter } from './routes/announcements.js';
import { shoutoutsRouter } from './routes/shoutouts.js';
import { swapRequestsRouter } from './routes/swapRequests.js';
import { shiftsRouter } from './routes/shifts.js';
import { rotaTemplatesRouter } from './routes/rotaTemplates.js';
import { attendanceRouter } from './routes/attendance.js';
import { eightySixRouter } from './routes/eightySix.js';
import { identityRouter } from './routes/identity.js';
import { joinRouter } from './routes/join.js';
import { myShiftsRouter } from './routes/myShifts.js';
import { availabilityRouter } from './routes/availability.js';
import { policyDocumentsRouter } from './routes/policyDocuments.js';
import { onboardingRouter } from './routes/onboarding.js';
import { voiceRouter } from './routes/voice.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Uploaded floor-plan images — served so every staff member's browser can
  // load the same plan, not just the device that uploaded it.
  app.use('/uploads', express.static(join(import.meta.dirname, '..', 'uploads')));

  app.use('/api/schedules', schedulesRouter);
  app.use('/api/staff-directory', staffDirectoryRouter);
  app.use('/api/floor-plan', floorPlanRouter);
  app.use('/api/announcements', announcementsRouter);
  app.use('/api/shoutouts', shoutoutsRouter);
  app.use('/api/swap-requests', swapRequestsRouter);
  app.use('/api/shifts', shiftsRouter);
  app.use('/api/rota-templates', rotaTemplatesRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/eighty-six', eightySixRouter);
  app.use('/api/identity', identityRouter);
  app.use('/api/join', joinRouter);
  app.use('/api/my-shifts', myShiftsRouter);
  app.use('/api/availability', availabilityRouter);
  app.use('/api/policy-documents', policyDocumentsRouter);
  app.use('/api/onboarding', onboardingRouter);
  app.use('/api/voice', voiceRouter);

  // Multer errors (bad file type, size limit) surface via next(err); normalize them to JSON.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error('[app] unhandled error', err);
    const message = err instanceof Error ? err.message : 'Unexpected server error.';
    res.status(400).json({ error: message });
  };
  app.use(errorHandler);

  return app;
}
