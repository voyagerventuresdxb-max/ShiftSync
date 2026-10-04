import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { schedulesRouter } from './routes/schedules.js';
import { staffDirectoryRouter } from './routes/staffDirectory.js';
import { floorPlanRouter, floorPlanFilesRouter } from './routes/floorPlan.js';
import { announcementsRouter } from './routes/announcements.js';
import { shoutoutsRouter } from './routes/shoutouts.js';
import { floorFeedbackRouter } from './routes/floorFeedback.js';
import { pushRouter } from './routes/push.js';
import { notificationsRouter } from './routes/notifications.js';
import { swapRequestsRouter } from './routes/swapRequests.js';
import { shiftsRouter } from './routes/shifts.js';
import { rotaTemplatesRouter } from './routes/rotaTemplates.js';
import { attendanceRouter } from './routes/attendance.js';
import { eightySixRouter } from './routes/eightySix.js';
import { identityRouter } from './routes/identity.js';
import { joinRouter } from './routes/join.js';
import { signupRouter } from './routes/signup.js';
import { myShiftsRouter } from './routes/myShifts.js';
import { availabilityRouter } from './routes/availability.js';
import { policyDocumentsRouter, policyDocumentFilesRouter } from './routes/policyDocuments.js';
import { onboardingRouter } from './routes/onboarding.js';
import { invitesRouter } from './routes/invites.js';
import { locationsRouter } from './routes/locations.js';
import { rolesRouter } from './routes/roles.js';
import { voiceRouter } from './routes/voice.js';
import { loginLinksRouter } from './routes/loginLinks.js';
import { kioskRouter } from './routes/kiosk.js';
import { aiRouter } from './routes/ai.js';
import { corsOptionsFromEnv } from './lib/corsOptions.js';
import { requestIdMiddleware } from './lib/requestContext.js';
import { checkReadiness } from './lib/readiness.js';
import { isPushRecording, pushOutbox } from './lib/push.js';

export function createApp() {
  const app = express();

  // First, so every later log line (and the error handler's) carries this request's id.
  app.use(requestIdMiddleware);
  app.use(cors(corsOptionsFromEnv()));
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  // Readiness, for deploys and uptime checks: database reachable and every shipped migration applied.
  app.get('/api/health/ready', async (_req, res) => {
    const readiness = await checkReadiness();
    res.status(readiness.ok ? 200 : 503).json(readiness);
  });
  // Dev/e2e only (PUSH_TRANSPORT=record, refused in production): what push would have delivered.
  if (isPushRecording()) {
    app.get('/api/dev/push-outbox', (req, res) => {
      const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
      res.json({ sent: pushOutbox().filter((p) => !userId || p.userId === userId) });
    });
  }

  // Both uploaded-file subpaths are session-gated and location-scoped (see
  // policyDocuments.ts / floorPlan.ts). They are the only way to read an
  // upload: anything else under /uploads is a 404, never a static file. A
  // future third upload type needs its own authenticated route like these.
  app.use('/uploads/policy-documents', policyDocumentFilesRouter);
  app.use('/uploads/floor-plans', floorPlanFilesRouter);
  app.use('/uploads', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use('/api/schedules', schedulesRouter);
  app.use('/api/staff-directory', staffDirectoryRouter);
  app.use('/api/floor-plan', floorPlanRouter);
  app.use('/api/announcements', announcementsRouter);
  app.use('/api/shoutouts', shoutoutsRouter);
  app.use('/api/floor-feedback', floorFeedbackRouter);
  app.use('/api/push', pushRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/swap-requests', swapRequestsRouter);
  app.use('/api/shifts', shiftsRouter);
  app.use('/api/rota-templates', rotaTemplatesRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/eighty-six', eightySixRouter);
  app.use('/api/identity', identityRouter);
  app.use('/api/join', joinRouter);
  app.use('/api/signup', signupRouter);
  app.use('/api/my-shifts', myShiftsRouter);
  app.use('/api/availability', availabilityRouter);
  app.use('/api/policy-documents', policyDocumentsRouter);
  app.use('/api/onboarding', onboardingRouter);
  app.use('/api/invites', invitesRouter);
  app.use('/api/locations', locationsRouter);
  app.use('/api/roles', rolesRouter);
  app.use('/api/voice', voiceRouter);
  app.use('/api/login-links', loginLinksRouter);
  app.use('/api/kiosk', kioskRouter);
  app.use('/api/ai', aiRouter);

  // Multer errors (bad file type, size limit) surface via next(err); normalize them to JSON.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error('[app] unhandled error', err);
    const message = err instanceof Error ? err.message : 'Unexpected server error.';
    res.status(400).json({ error: message });
  };
  app.use(errorHandler);

  return app;
}
