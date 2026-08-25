import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { join } from 'node:path';
import { schedulesRouter } from './routes/schedules.js';
import { staffDirectoryRouter } from './routes/staffDirectory.js';
import { floorPlanRouter } from './routes/floorPlan.js';
import { announcementsRouter } from './routes/announcements.js';

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

  // Multer errors (bad file type, size limit) surface via next(err); normalize them to JSON.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error('[app] unhandled error', err);
    const message = err instanceof Error ? err.message : 'Unexpected server error.';
    res.status(400).json({ error: message });
  };
  app.use(errorHandler);

  return app;
}
