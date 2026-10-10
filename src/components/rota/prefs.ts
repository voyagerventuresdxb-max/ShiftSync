/**
 * Per-device rota preferences (Spec §1: density and the clock are a user
 * setting persisted per device). localStorage can be missing or throw
 * (private mode, a locked-down WebView), so every access is guarded and the
 * builder works with the defaults.
 */
export type Density = 'comfortable' | 'compact';
export type ClockPref = '12h' | '24h';

const KEYS = {
  density: 'shiftsync.rota.density',
  clock: 'shiftsync.rota.clock',
  requests: 'shiftsync.rota.requestsOpen',
  coach: 'shiftsync.rota.coachDone.v1',
} as const;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted on this device; the setting still applies for this visit.
  }
}

export function readDensity(): Density {
  return read(KEYS.density) === 'compact' ? 'compact' : 'comfortable';
}
export function writeDensity(d: Density): void {
  write(KEYS.density, d);
}

/** null = follow the venue's clock setting from the week document. */
export function readClock(): ClockPref | null {
  const v = read(KEYS.clock);
  return v === '12h' || v === '24h' ? v : null;
}
export function writeClock(c: ClockPref): void {
  write(KEYS.clock, c);
}

export function readRequestsOpen(): boolean {
  return read(KEYS.requests) !== 'false';
}
export function writeRequestsOpen(open: boolean): void {
  write(KEYS.requests, open ? 'true' : 'false');
}

export function readCoachDone(): boolean {
  return read(KEYS.coach) === 'true';
}
export function writeCoachDone(): void {
  write(KEYS.coach, 'true');
}
