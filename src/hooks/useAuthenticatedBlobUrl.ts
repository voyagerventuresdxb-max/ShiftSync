import { useEffect, useState } from 'react';
import { withAuth } from '../api/identity';

/**
 * Fetches a session-gated file (e.g. a floor-plan image behind
 * `/uploads/floor-plans/...`) with a real `Authorization` header and hands
 * back a same-origin `blob:` URL to render it with — `<img src>`/`useImage`
 * (and any other browser resource-loading attribute) can never attach a
 * custom header themselves, so a plain URL no longer works once the file
 * itself requires a Bearer token. Returns `undefined` while loading, on
 * error, or when either argument is missing.
 */
export function useAuthenticatedBlobUrl(fileUrl: string | undefined, token: string | undefined): string | undefined {
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!fileUrl || !token) {
      setBlobUrl(undefined);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    fetch(fileUrl, { headers: withAuth(token) })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setBlobUrl(undefined);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileUrl, token]);

  return blobUrl;
}
