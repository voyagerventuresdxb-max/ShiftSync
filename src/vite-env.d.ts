/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin for builds not served behind the `/api` rewrite (the Capacitor shell). Unset on the web. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
