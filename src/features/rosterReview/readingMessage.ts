/**
 * What the screen says while a roster is being read. A spreadsheet reads in a second or two;
 * a photo or scan read by the AI reader can take tens of seconds (production allows ~100s
 * before the hosting proxy gives up), so the wording calms down as time passes rather than
 * looking stuck. There is no client-side timeout on the upload request.
 */
export function readingMessage(elapsedSeconds: number): string {
  if (elapsedSeconds < 8) return 'Reading your roster…';
  if (elapsedSeconds < 25) return 'Still reading. A photo or scan takes longer than a spreadsheet.';
  if (elapsedSeconds < 60) return 'Reading every row carefully. This can take a minute or two.';
  return 'Almost there. Big rosters can take up to two minutes. Keep this screen open.';
}
