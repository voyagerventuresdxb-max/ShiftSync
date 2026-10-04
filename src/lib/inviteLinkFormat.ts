const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "Expires in 30 days" / "Expires in 5 hours" / "Expired". */
export function describeInviteExpiry(expiresAt: string, now = Date.now()): string {
  const left = new Date(expiresAt).getTime() - now;
  if (!(left > 0)) return 'Expired';
  if (left > DAY_MS) {
    const days = Math.ceil(left / DAY_MS);
    return `Expires in ${days} days`;
  }
  const hours = Math.ceil(left / HOUR_MS);
  return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** "3 of 10 uses" with a cap, "3 joins" without. */
export function describeInviteUses(useCount: number, maxUses: number | null): string {
  if (maxUses !== null) return `${useCount} of ${maxUses} use${maxUses === 1 ? '' : 's'}`;
  return `${useCount} join${useCount === 1 ? '' : 's'}`;
}
