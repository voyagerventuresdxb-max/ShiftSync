/**
 * Shared recipient-resolution for "notify whoever manages this venue" —
 * used anywhere a staff-initiated action (a swap request, a join request)
 * needs a manager's attention. One place so every caller agrees on what
 * "a manager" means here (MANAGER or OWNER, active, same location).
 */
import { prisma } from './prisma.js';

export async function getManagerIdsForLocation(locationId: string): Promise<string[]> {
  const managers = await prisma.user.findMany({
    where: { locationId, systemRole: { in: ['MANAGER', 'OWNER'] }, isActive: true },
    select: { id: true },
  });
  return managers.map((m) => m.id);
}
