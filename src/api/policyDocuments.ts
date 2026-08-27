/**
 * Client for the Policy Documents API (server/src/routes/policyDocuments.ts)
 * — venue-level PDF documents (handbooks, compliance policies, etc.),
 * grouped by category client-side; the server returns a flat list.
 */
import { ApiError } from './schedules';
export { ApiError };

export interface PolicyDocumentDto {
  id: string;
  category: string;
  title: string;
  fileUrl: string;
  originalName: string | null;
  createdAt: string;
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

/** GET /api/policy-documents/:locationId */
export async function fetchPolicyDocuments(locationId: string): Promise<PolicyDocumentDto[]> {
  const data = await request<{ documents: PolicyDocumentDto[] }>(`/api/policy-documents/${locationId}`);
  return data.documents;
}

/** POST /api/policy-documents/upload — multipart: file, locationId, category, title, uploadedById? */
export async function uploadPolicyDocument(input: { file: File; locationId: string; category: string; title: string; uploadedById?: string }): Promise<PolicyDocumentDto> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('locationId', input.locationId);
  form.append('category', input.category);
  form.append('title', input.title);
  if (input.uploadedById) form.append('uploadedById', input.uploadedById);
  const data = await request<{ document: PolicyDocumentDto }>('/api/policy-documents/upload', { method: 'POST', body: form });
  return data.document;
}

/** DELETE /api/policy-documents/:id */
export async function deletePolicyDocument(id: string): Promise<void> {
  await request(`/api/policy-documents/${id}`, { method: 'DELETE' });
}
