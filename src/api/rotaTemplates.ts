import { ApiError } from './schedules';

export interface RotaTemplateDto {
  id: string;
  name: string;
  entryCount: number;
  createdAt: string;
}

export interface TemplateEntryInput {
  dayOffset: number;
  roleId: string;
  userId: string | null;
  start: string;
  end: string;
  note?: string;
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function fetchRotaTemplates(locationId: string): Promise<RotaTemplateDto[]> {
  const data = await request<{ templates: RotaTemplateDto[] }>(`/api/rota-templates/${locationId}`);
  return data.templates;
}

export async function saveRotaTemplate(locationId: string, name: string, entries: TemplateEntryInput[], createdById?: string): Promise<RotaTemplateDto> {
  const data = await request<{ template: RotaTemplateDto }>('/api/rota-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId, name, entries, createdById: createdById ?? null }),
  });
  return data.template;
}

export async function deleteRotaTemplate(id: string): Promise<void> {
  await request(`/api/rota-templates/${id}`, { method: 'DELETE' });
}

export async function applyRotaTemplate(id: string, weekStart: string, createdById?: string): Promise<{ createdCount: number }> {
  return request(`/api/rota-templates/${id}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weekStart, createdById: createdById ?? null }),
  });
}
