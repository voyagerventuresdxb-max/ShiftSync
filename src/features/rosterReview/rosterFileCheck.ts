/**
 * What the roster upload accepts, checked on the phone before anything is sent. The same list
 * and size limit as the server (server/src/routes/schedules.ts: a known type OR a known
 * extension, 10 MB), so this never turns away a file the server would read; it only says why
 * straight away, with nothing uploaded.
 */

/**
 * The file picker's `accept`: extensions plus their types, so an iPhone offers Photo Library,
 * Take Photo and Files (and hands photos over as JPEG). No `capture`: that would force the camera.
 */
export const ROSTER_ACCEPT = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.xlsx',
  '.xls',
  '.csv',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
].join(',');

export const ROSTER_MAX_BYTES = 10 * 1024 * 1024;

const SERVER_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const SERVER_EXTENSIONS = /\.(xlsx|xls|csv|pdf|png|jpe?g|webp|gif)$/i;

/** Why this file can't be read, in plain words; null when it can be sent. */
export function rosterFileProblem(file: { name: string; type?: string; size: number }): string | null {
  if (!SERVER_TYPES.has(file.type ?? '') && !SERVER_EXTENSIONS.test(file.name)) {
    return `ShiftSync can't read "${file.name}". Choose a PDF, a photo (JPG, PNG or WebP), an Excel file or a CSV.`;
  }
  if (file.size === 0) return `"${file.name}" is empty. Choose the roster file again.`;
  if (file.size > ROSTER_MAX_BYTES) {
    return `"${file.name}" is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit is 10 MB. Export a smaller file, or take a photo of the printed roster instead.`;
  }
  return null;
}

export const ROSTER_OFFLINE_MESSAGE = "You're offline, so nothing was sent. Reconnect, then choose the file again.";
