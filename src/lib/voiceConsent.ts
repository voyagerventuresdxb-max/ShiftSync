/**
 * Whether this person agreed to the voice notice on this device. Withdrawing it (Profile) turns
 * voice off here until they agree again on their next microphone tap.
 */
const key = (userId: string) => `shiftsync.voiceConsent.${userId}`;

/** Unreadable storage (private mode, blocked site data) means the notice is shown again — never skipped. */
export function hasVoiceConsent(userId: string): boolean {
  try {
    return localStorage.getItem(key(userId)) === '1';
  } catch {
    return false;
  }
}

export function saveVoiceConsent(userId: string): void {
  try {
    localStorage.setItem(key(userId), '1');
  } catch {
    // Not remembered: the notice is shown again next time.
  }
}

export function withdrawVoiceConsent(userId: string): void {
  try {
    localStorage.removeItem(key(userId));
  } catch {
    // Nothing stored that could be read either: the notice already shows every time.
  }
}
