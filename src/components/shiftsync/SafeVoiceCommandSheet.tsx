import { useEffect, type ComponentProps } from 'react';
import { VoiceCommandSheet } from '@/components/shiftsync/VoiceCommandSheet';
import { VoiceSheetBoundary } from '@/components/shiftsync/VoiceSheetBoundary';
import type { VoiceProblem } from '@/lib/voiceErrors';
import { isWellFormedReading, SHEET_ERROR, UNREADABLE } from '@/lib/voiceReading';

/**
 * The confirm sheet, only for a reading it can draw. An unreadable reading (missing what the sheet
 * draws) is handed back unshown, and an error while drawing closes the sheet: either way the app
 * stays, instead of the router's error page replacing it. In the sheet's own lazy chunk, so the
 * check costs screens that never open voice nothing.
 */
export function SafeVoiceCommandSheet({ onUnreadable, ...props }: ComponentProps<typeof VoiceCommandSheet> & { onUnreadable: (problem: VoiceProblem) => void }) {
  const readable = isWellFormedReading(props.intent);
  useEffect(() => {
    if (!readable) onUnreadable(UNREADABLE);
  }, [readable, onUnreadable]);
  if (!readable) return null;
  return (
    <VoiceSheetBoundary onError={() => onUnreadable(SHEET_ERROR)}>
      <VoiceCommandSheet {...props} />
    </VoiceSheetBoundary>
  );
}
