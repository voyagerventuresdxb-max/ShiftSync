/** Client for the 86 List API (server/src/routes/eightySix.ts). */
import { ApiError } from './schedules';

export { ApiError };

export interface EightySixItemDto {
  id: string;
  itemName: string;
  station: string;
  status: 'EIGHTY_SIXED' | 'BACK_ON';
  note: string | null;
  eightySixedAt: string;
  backOnAt: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

/** GET /api/eighty-six/:locationId — active items, or all if includeResolved. */
export async function fetchEightySixList(locationId: string, includeResolved = false): Promise<EightySixItemDto[]> {
  const data = await request<{ items: EightySixItemDto[] }>(
    `/api/eighty-six/${locationId}${includeResolved ? '?includeResolved=1' : ''}`,
  );
  return data.items;
}

/** POST /api/eighty-six — 86 a new item. */
export async function eightySixItem(input: {
  locationId: string;
  itemName: string;
  station: string;
  note?: string;
  createdById?: string;
}): Promise<EightySixItemDto> {
  const { item } = await request<{ item: EightySixItemDto }>('/api/eighty-six', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return item;
}

/** PATCH /api/eighty-six/:id/back-on */
export async function markBackOn(itemId: string, actorId?: string): Promise<EightySixItemDto> {
  const { item } = await request<{ item: EightySixItemDto }>(`/api/eighty-six/${itemId}/back-on`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorId: actorId ?? null }),
  });
  return item;
}
