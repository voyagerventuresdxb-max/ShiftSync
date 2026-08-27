import { prisma } from '../prisma.js';

export type AvailabilityMarkDto = {
  id: string;
  date: string; // YYYY-MM-DD
  type: 'UNAVAILABLE' | 'PREFERRED_OFF';
  note: string | null;
};

/**
 * Upserts one availability mark per (userId, date). `date` is assumed
 * already validated as YYYY-MM-DD by the caller (the HTTP route, or a
 * future voice caller).
 */
export async function markAvailability(input: {
  userId: string;
  date: string;
  type: 'UNAVAILABLE' | 'PREFERRED_OFF';
  note?: string | null;
}): Promise<{ result: 'ok'; mark: AvailabilityMarkDto }> {
  const date = new Date(`${input.date}T00:00:00.000Z`);
  const note = input.note ?? null;
  const mark = await prisma.availabilityMark.upsert({
    where: { userId_date: { userId: input.userId, date } },
    create: { userId: input.userId, date, type: input.type, note },
    update: { type: input.type, note },
  });
  return {
    result: 'ok',
    mark: {
      id: mark.id,
      date: mark.date.toISOString().slice(0, 10),
      type: mark.type as 'UNAVAILABLE' | 'PREFERRED_OFF',
      note: mark.note,
    },
  };
}
