import type { CapacitorConfig } from '@capacitor/cli';

// Native shell around the Vite build. The WebView's origin is https://localhost,
// so the bundle must be built with VITE_API_URL set (see docs/android.md).
// A plain-http API (a local server at http://10.0.2.2:4000) is dev-only and
// needs cleartext + mixed content; an https API build never enables either.
const httpApi = process.env.VITE_API_URL?.startsWith('http://') ?? false;

const config: CapacitorConfig = {
  appId: 'ae.shiftsync.app',
  appName: 'ShiftSync',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: httpApi,
  },
  android: {
    allowMixedContent: httpApi,
  },
};

export default config;
