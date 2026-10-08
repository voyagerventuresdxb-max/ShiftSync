import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// PREVIEW-ONLY BRANCH (preview/r15-voice-variant-b, never merged): on Vercel preview builds only,
// `@/voiceVariant` is src/dev/voiceVariantPreview.ts (opens variant B with ?variant=b). Every other
// build — local, CI, production — resolves it to src/voiceVariant.ts, which always says "a".
const voiceVariantPreview = process.env.VERCEL_ENV === 'preview';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      ...(voiceVariantPreview ? [{ find: /^@\/voiceVariant$/, replacement: fileURLToPath(new URL('./src/dev/voiceVariantPreview.ts', import.meta.url)) }] : []),
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Read by scripts/check-bundle-size.mjs to work out which chunks each screen downloads.
    manifest: true,
  },
});
