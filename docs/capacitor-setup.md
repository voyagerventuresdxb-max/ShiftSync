# Capacitor (iOS / Android) — setup guide

Status (2026-09-22): **there is no native app yet.** No `capacitor.config.*`, no `ios/` or
`android/` directory, no `@capacitor/*` dependency exists in any branch or worktree of this
repo. This guide is the exact path to create one, written to be run on a machine that has
the native toolchains — the review machine does not (Windows; no Xcode, which is
macOS-only; no Android Studio, no Android SDK, no JDK, no Gradle), so nothing below has
been executed. Every command is standard Capacitor 6 usage; verify each step's output
before moving to the next.

## 0. The one design decision first: what does the native app load?

The web app calls its API with **relative** URLs (`fetch('/api/...')`, ~20 files under
`src/api/`). Inside a Capacitor WebView the bundled site is served from
`capacitor://localhost` (iOS) / `http://localhost` (Android), so a relative `/api/...`
would hit the app bundle, not the server. Two ways round it:

| | A. Thin wrapper — load the live site | B. Bundle `dist/` — point fetches at the API |
|---|---|---|
| How | `server.url` in `capacitor.config.ts` = the production Vercel URL; the WebView loads the deployed site, Vercel's `/api` rewrite reaches Railway as usual | Ship `dist/` in the app; add `VITE_API_BASE_URL` and prefix every `fetch('/api…')`/`'/uploads…'` with it; Railway API must allow the app's origin (CORS is already `cors()`-open) |
| Code changes | none | a small `apiUrl()` helper + edits across `src/api/*.ts` and the two components that build `/uploads/...` image URLs |
| Works offline | no (blank if no network) | shell loads offline; API still needs network |
| App store review | Apple can reject apps that are "just a website"; fine for internal/TestFlight demos | the normal expectation for a store submission |
| For MBRIF | **use this** — nothing to change, and it demos exactly what the web URL demos | the follow-up once the app is more than a demo |

The rest of this guide sets up **A**, and marks where B differs.

**Prerequisite for A:** the production web deployment must be live (`docs/deployment.md`,
steps 1–3 done and `https://shift-sync-two-ashy.vercel.app/api/health` answering).
Until then the native app has nothing to load.

## 1. Toolchains needed on your machine

- Node 20+ (the repo says `engines.node >= 22`).
- **iOS:** a Mac. Xcode 15 or newer from the App Store, plus its Command Line Tools
  (`xcode-select --install`), CocoaPods (`sudo gem install cocoapods` or `brew install
  cocoapods`). Running on a physical iPhone needs an Apple ID signed into Xcode (free for
  7-day dev builds; a paid Apple Developer account for TestFlight/App Store).
- **Android:** Android Studio (Hedgehog 2023.1 or newer) with, from its SDK Manager:
  Android SDK Platform 34, Android SDK Build-Tools 34, Android SDK Platform-Tools,
  Android Emulator, and a system image for the emulator (e.g. API 34 arm64/x86_64). JDK
  17 (Android Studio bundles one; otherwise install Temurin 17). Set `ANDROID_HOME` to the
  SDK path and `JAVA_HOME` to the JDK, and add `$ANDROID_HOME/platform-tools` to `PATH`.

## 2. Install Capacitor into the repo

From the repo root (any branch off `master`):

```bash
npm install @capacitor/core @capacitor/cli
npm install @capacitor/ios @capacitor/android
npx cap init "ShiftSync" "com.shiftsync.app" --web-dir dist
```

`cap init` writes `capacitor.config.ts`. Replace its contents with:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.shiftsync.app',
  appName: 'ShiftSync',
  webDir: 'dist',
  server: {
    // Option A (thin wrapper): load the deployed site. Remove this block for option B.
    url: 'https://shift-sync-two-ashy.vercel.app',
    // Let the WebView follow links to the same site and the API host without
    // bouncing to the system browser.
    allowNavigation: ['shift-sync-two-ashy.vercel.app', '*.up.railway.app'],
  },
  ios: {
    contentInset: 'automatic',
  },
  android: {
    // The site is https; no cleartext needed.
    allowMixedContent: false,
  },
};

export default config;
```

For option B instead: delete `server.url`/`allowNavigation`, set `VITE_API_BASE_URL` to the
Railway URL when running `npm run build`, and make the API clients honour it.

## 3. Build the web app and add the platforms

```bash
npm run build                 # produces dist/ — Capacitor copies this even for option A
npx cap add ios               # creates ios/  (macOS only)
npx cap add android           # creates android/
npx cap sync                  # copies dist/ + config into both native projects, installs pods on macOS
```

Commit `capacitor.config.ts`, `ios/` and `android/` (Capacitor's generated projects are
meant to be versioned; add `ios/App/Pods/` and `android/.gradle/`, `android/app/build/` to
`.gitignore`).

## 4. Native permissions the web app needs

The web app records voice commands with `getUserMedia`/`MediaRecorder` and uploads files
from the file picker. Add:

- **iOS** — `ios/App/App/Info.plist`:
  - `NSMicrophoneUsageDescription` = "ShiftSync uses the microphone for voice shift commands."
  - `NSCameraUsageDescription` = "ShiftSync uses the camera to photograph a printed roster."
  - `NSPhotoLibraryUsageDescription` = "ShiftSync lets you pick a roster file or photo."
- **Android** — `android/app/src/main/AndroidManifest.xml`:
  - `<uses-permission android:name="android.permission.RECORD_AUDIO" />`
  - `<uses-permission android:name="android.permission.CAMERA" />`
  - `<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />`

Known caveat: microphone access from a WebView needs the native side to grant the
`getUserMedia` request. Capacitor's Android bridge handles `onPermissionRequest` for
microphone/camera when the manifest permissions above are declared, but this is the first
thing to test on a real device — if voice commands fail with "Microphone access was denied"
in the app while the same site works in mobile Safari/Chrome, the WebView permission bridge
is the cause, not the app.

Push notifications (`web-push`/VAPID, `NotificationSettings.tsx`) rely on a service-worker
push subscription, which does not exist inside a WebView. Expect that panel to report
notifications unavailable in the native app; a native push integration
(`@capacitor/push-notifications` + APNs/FCM) is separate work.

## 5. Run it

```bash
npx cap open ios              # opens Xcode: pick a simulator or your device, press Run
npx cap open android          # opens Android Studio: let Gradle sync, pick an emulator/device, Run
```

Or from the CLI: `npx cap run ios` / `npx cap run android` (prompts for a target).

First-run checks, in this order:
1. The Welcome intro renders (proves the WebView loaded the site).
2. Account step: phone → code appears on screen (`ALLOW_DEV_OTP_ECHO=true` on Railway,
   demo-only) → venue created — proves `/api` reaches Railway through Vercel.
3. Roster step: tap the upload zone → the native file picker opens → pick an `.xlsx` →
   Review shows rows.
4. Voice: tap the mic keystone → OS permission prompt → record — see the caveat in §4.

## 6. Rebuild loop

After any web change: `npm run build && npx cap sync`, then Run again from Xcode/Android
Studio. Under option A the native app picks up web changes on the next launch without a
rebuild (it loads the deployed site); only `capacitor.config.ts`, plugins and native
permissions need a resync.

## 7. Not done yet (tracked)

- Option B's `VITE_API_BASE_URL` plumbing (needed before a store submission).
- App icons / splash screens (`@capacitor/assets` generates both from one 1024×1024 PNG).
- Native push notifications.
- A real device test of microphone permission in the WebView (§4).
