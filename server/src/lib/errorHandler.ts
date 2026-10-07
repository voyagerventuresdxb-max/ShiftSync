import type { ErrorRequestHandler } from 'express';
import multer from 'multer';

/** An upload refused for a reason the person can fix (the wrong file type). Its message is shown to them. */
export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadRejectedError';
  }
}

export const GENERIC_ERROR_MESSAGE = 'Something went wrong with that request. Please try again.';
export const INVALID_JSON_MESSAGE = "The request body isn't valid JSON.";
export const TOO_LARGE_MESSAGE = 'The request is too large.';

/**
 * The API's last error handler. Upload refusals (multer's own limits and the routes' file-type
 * checks) keep their message, and an unreadable request body gets a fixed one; anything else
 * answers with a generic message so no internal detail reaches the caller. The real error is
 * always logged here.
 */
export const apiErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[app] unhandled error', err);
  if (err instanceof multer.MulterError || err instanceof UploadRejectedError) return res.status(400).json({ error: err.message });
  const type = (err as { type?: unknown } | null)?.type;
  if (type === 'entity.parse.failed') return res.status(400).json({ error: INVALID_JSON_MESSAGE });
  if (type === 'entity.too.large') return res.status(400).json({ error: TOO_LARGE_MESSAGE });
  return res.status(400).json({ error: GENERIC_ERROR_MESSAGE });
};
