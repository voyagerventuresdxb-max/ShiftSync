import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Trash2, Upload } from 'lucide-react';
import { fetchPolicyDocuments, uploadPolicyDocument, deletePolicyDocument, fetchPolicyDocumentFile, ApiError, type PolicyDocumentDto } from '../api/policyDocuments';
import { useIdentity } from '../state/IdentityContext';

/**
 * Training & Policy document hub — venue-level PDF documents (handbooks,
 * compliance policies, etc.), grouped by free-text category client-side.
 * Follows the same free-text-category-grouping + <datalist> autocomplete
 * pattern established by EightySixBoard.tsx in the Floor Plan phase.
 */
export default function PolicyDocuments({ locationId }: { locationId: string }) {
  const { session } = useIdentity();
  const [docs, setDocs] = useState<PolicyDocumentDto[]>([]);
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => {
    fetchPolicyDocuments(session!.token, locationId)
      .then(setDocs)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load documents.'));
  }, [session, locationId]);

  useEffect(() => {
    load();
  }, [load]);

  const knownCategories = useMemo(() => [...new Set(docs.map((d) => d.category))].sort(), [docs]);
  const grouped = useMemo(() => {
    const byCategory = new Map<string, PolicyDocumentDto[]>();
    for (const d of docs) {
      const bucket = byCategory.get(d.category) ?? [];
      bucket.push(d);
      byCategory.set(d.category, bucket);
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [docs]);

  const handleUpload = async () => {
    if (!file || !category.trim() || !title.trim()) return;
    setUploading(true);
    setError(null);
    try {
      await uploadPolicyDocument(session!.token, { file, category: category.trim(), title: title.trim() });
      setFile(null);
      setCategory('');
      setTitle('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not upload that document.');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePolicyDocument(session!.token, id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that document.');
    }
  };

  // The document link used to be a plain <a href> — no longer possible now
  // that the file itself is session-gated (this app authenticates via a
  // Bearer header, not a cookie, so a browser's own navigation can't carry
  // it). Fetch the bytes with the real session token, then hand the browser
  // a same-origin blob: URL to open instead.
  const handleOpen = async (d: PolicyDocumentDto) => {
    setError(null);
    try {
      const blob = await fetchPolicyDocumentFile(session!.token, d.fileUrl);
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank', 'noopener,noreferrer');
      // The new tab has already loaded the blob by the time it opens; revoking
      // shortly after frees the memory without racing the open() call itself.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that document.');
    }
  };

  return (
    <section className="panel p-5">
      <h2 className="text-base font-semibold">Training &amp; Policy Documents</h2>

      {error && (
        <div className="error-block mt-3" role="alert">
          <p>{error}</p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          className="staff-directory-input"
          list="policy-doc-categories"
          placeholder="Category (e.g. Onboarding, Food Safety)"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <datalist id="policy-doc-categories">
          {knownCategories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <input
          className="staff-directory-input"
          placeholder="Document title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button
          className="btn btn-primary"
          onClick={() => void handleUpload()}
          disabled={uploading || !file || !category.trim() || !title.trim()}
        >
          <Upload className="h-4 w-4" /> Upload
        </button>
      </div>

      {grouped.length === 0 ? (
        <p className="hint mt-4">No documents uploaded yet.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {grouped.map(([cat, catDocs]) => (
            <div key={cat}>
              <p className="eyebrow">{cat}</p>
              <ul className="mt-1.5 space-y-1.5">
                {catDocs.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                    <button
                      type="button"
                      onClick={() => void handleOpen(d)}
                      className="flex min-w-0 items-center gap-2 text-left hover:text-accent"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{d.title}</span>
                    </button>
                    <button onClick={() => void handleDelete(d.id)} aria-label={`Delete ${d.title}`} className="shrink-0 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
