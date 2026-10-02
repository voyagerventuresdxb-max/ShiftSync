# Android app (Capacitor shell)

ShiftSync's Android app is the same Vite/React bundle running inside a Capacitor 8 WebView.
There are no native plugins beyond `@capacitor/app` (hardware back, `src/lib/nativeBack.ts`):
no camera, push, preferences or deep-link plugins yet. Those are listed under
[WebView gaps](#webview-gaps-flagged-not-fixed) below.

| | |
|---|---|
| Capacitor | `@capacitor/core` / `cli` / `android` 8.5.2, `@capacitor/app` 8.1.1 |
| App id | `ae.shiftsync.app` (`capacitor.config.ts`). The Play Store makes this permanent after the first upload, so change it before then if the brand domain is different. |
| Web assets | `webDir: 'dist'` (the normal `vite build` output), copied into `android/app/src/main/assets/public` by `cap sync` (gitignored) |
| WebView origin | `https://localhost` (`server.androidScheme: 'https'`) |
| Android | minSdk 24, compileSdk/targetSdk 36, Gradle 8.14.3, AGP 8.13.0 (the generated `android/variables.gradle`, `android/build.gradle`) |

`android/` is committed, as Capacitor recommends. Build outputs, `.gradle/`, `local.properties`,
the copied web assets, the generated config files, `release/` and keystores (`*.jks`,
`*.keystore`) are all ignored by `android/.gitignore`.

## How the app reaches the API

On the web, every call is a relative `/api/...` or `/uploads/...` URL. The browser sends it to
the Vercel origin, and Vercel's rewrite forwards it to Railway (`vercel.json`), so it is
same-origin and CORS never applies. In the app the page's origin is `https://localhost`, so a
relative URL would go nowhere. Every call now goes through `apiUrl(path)` (`src/lib/apiUrl.ts`),
which prefixes `VITE_API_URL` when it is set at build time. When it is unset (every web build),
paths stay relative and the web app behaves exactly as before.

**Decision: point the app straight at the Railway API, not at the Vercel origin.**

| | `VITE_API_URL=https://shiftsync-api-production.up.railway.app` (chosen) | `VITE_API_URL=https://shift-sync-shift-sync1.vercel.app` |
|---|---|---|
| Hops | phone → Railway | phone → Vercel → Railway |
| CORS | answered by Express (`cors()`) | still cross-origin; Vercel passes Railway's CORS headers through, so it works, but there are two places to debug |
| Rate-limit key (`otpClientKey`) | `X-Real-IP` = the phone's own address | the (Vercel, client) pair, as on the web |
| Coupling | the APK has the Railway hostname baked in; moving the API means a new APK | survives an API move, but depends on Vercel for every API call |

Before a store release, put the API on a custom domain you control (e.g. `api.<brand>`) and
build with that, so the shipped APK isn't tied to a Railway-generated hostname.

`FRONTEND_ORIGIN` stays the web origin. Invite and login links are always minted for it:
the app sends `?baseUrl=https://localhost` when it fetches invite links (`src/api/invites.ts`,
`src/api/onboarding.ts`), which isn't in the allowlist, so the server falls back to the first
`FRONTEND_ORIGIN` (`resolveInviteBaseUrl`, `server/src/lib/inviteLinks.ts`). **Don't add
`https://localhost` to `FRONTEND_ORIGIN`**, or managers using the app would share links that only
work inside their own phone.

## Auth: no cookies, so no SameSite problem

The session is a Bearer token kept in `localStorage['shiftsync.session']` (`src/api/identity.ts`)
and sent as an `Authorization` header (`withAuth`). The server reads only that header
(`bearerToken` in `server/src/middleware/requireSession.ts`). Nothing in `src/`, `server/src/`
or `shared/` sets or reads a cookie: no `res.cookie`, no `credentials: 'include'`, no
`express-session`/`cookie-parser`. Cross-origin calls from `https://localhost` therefore need no
`SameSite=None`, no third-party-cookie allowance and no `Access-Control-Allow-Credentials`.

## CORS: `CORS_ORIGINS` (optional)

`server/src/app.ts` used `app.use(cors())`, which allows any origin. It now uses
`cors(corsOptionsFromEnv())` (`server/src/lib/corsOptions.ts`):

- **Unset or empty (today's deployments):** byte-for-byte the old behaviour,
  `Access-Control-Allow-Origin: *`. The app already works against production with no Railway
  change.
- **Set:** only the listed origins get CORS headers; everything else gets none, so the browser
  blocks the read and the preflight. Comma-separated, trailing slashes ignored.

Value for Railway when you want to tighten it (the human sets this; agents never touch Railway):

```
CORS_ORIGINS=https://localhost,capacitor://localhost
```

`https://localhost` is the Android shell. `capacitor://localhost` is the iOS shell, for later.
Add `http://localhost` only if you ever build with `androidScheme: 'http'`. The web origin
doesn't need to be listed, because the web app reaches the API same-origin through the rewrite.
CORS is defense in depth here, not access control: auth is a header, not an ambient cookie, so
a foreign page can't ride a user's session either way. Leave `CORS_ORIGINS` unset on local dev.

## One-time machine setup (Windows)

None of this exists on the dev machine today. `java`, `adb` and an SDK are all absent, and
`JAVA_HOME`/`ANDROID_HOME` are unset. Budget about 10–15 GB of disk.

1. Install **Android Studio Otter (2025.2.1) or newer**, the minimum for Capacitor 8. It bundles
   JDK 21 (the "JBR").
2. First launch → Standard setup. Then *Settings → Languages & Frameworks → Android SDK*:
   - SDK Platforms: **Android 16 (API 36)**.
   - SDK Tools: **Android SDK Build-Tools** (latest), **Platform-Tools**, **Emulator**, and
     **Command-line Tools (latest)**. Gradle fetches any other build-tools version it needs
     once the licences are accepted.
3. Set user environment variables (*System Properties → Environment Variables*) and open a new
   terminal:
   ```
   ANDROID_HOME = %LOCALAPPDATA%\Android\Sdk
   JAVA_HOME    = C:\Program Files\Android\Android Studio\jbr
   Path        += %ANDROID_HOME%\platform-tools ; %ANDROID_HOME%\emulator
   ```
   Check: `java -version` prints 21, and `adb version` works.
4. Create an emulator in *Device Manager*: Pixel 8 with an API 36 Google APIs x86_64 image.
   Or use a real phone with *Developer options → USB debugging* on.

## Build a debug APK against production

PowerShell, from the repo root:

```powershell
$env:VITE_API_URL = "https://shiftsync-api-production.up.railway.app"
npm run cap:sync            # vite build + npx cap sync android (refuses to run without VITE_API_URL)
cd android
.\gradlew.bat assembleDebug # first run downloads Gradle 8.14.3 and dependencies (several hundred MB)
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`. Install it:

```powershell
adb devices                 # the emulator or phone must be listed as "device"
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

Alternatives: `npm run cap:open` opens the project in Android Studio (▶ Run), or
`npx cap run android` builds, installs and launches on a chosen target. Re-run `npm run cap:sync`
after every web change. It copies a fresh `dist/` into the app.

## Against a local API (emulator)

```powershell
npm run server:dev                          # API on :4000, in another terminal
$env:VITE_API_URL = "http://10.0.2.2:4000"  # 10.0.2.2 = the host machine, seen from the emulator
npm run cap:sync
cd android; .\gradlew.bat assembleDebug; adb install -r app\build\outputs\apk\debug\app-debug.apk
```

For a physical phone over USB, run `adb reverse tcp:4000 tcp:4000` and use
`VITE_API_URL=http://localhost:4000` instead.

A plain-`http://` API needs cleartext traffic and mixed content (the page itself is
`https://localhost`). `capacitor.config.ts` turns both on **only** when `VITE_API_URL` starts
with `http://`. An `https://` build turns them off again on the next `cap:sync`, because both
settings live in generated, gitignored files. Sign in with a number your local
`ECHO_ALLOWED_PHONES`/`ALLOW_DEV_OTP_ECHO` setup echoes.

## Debugging

- WebView console, network and DOM: desktop Chrome → `chrome://inspect/#devices` → *inspect*
  under the ShiftSync WebView. Debug builds enable WebView debugging automatically.
- Native log: `adb logcat -s Capacitor Capacitor/Console`.
- A failed API call shows up in the inspector's Network tab. A CORS rejection appears there as
  a failed preflight (check `CORS_ORIGINS`), and an unset `VITE_API_URL` shows as requests to
  `https://localhost/api/...` answered with `index.html`.

## Smoke test (not yet run, because this machine has no SDK)

1. Sign in by phone code → Home (manager) or My Shifts (staff).
2. Floor Plan shows the plan image. That proves `/uploads` goes through `apiUrl` with the Bearer
   header.
3. Roster upload (onboarding Roster step and Scheduling → Upload) opens the Android file picker.
4. Hardware back: the checklist in `MEMORY.md` (Phase 4 "NOT VERIFIED (1)").
5. Kill and relaunch the app: you are still signed in (localStorage survived).

## WebView gaps (flagged, not fixed)

| Gap | Evidence | What happens today | Follow-up |
|---|---|---|---|
| **Safe areas / system bars** | `index.html` has no `viewport-fit=cover`. Only `RadialDock` uses `env(safe-area-inset-bottom)`. PR #43 (`claude/ios-safari-hardening`, not on this base) adds `viewport-fit=cover` and top/bottom inset padding. Capacitor 8's built-in `SystemBars` (`insetsHandling: 'css'` default) pads the WebView itself unless the page is `viewport-fit=cover` *and* the WebView is ≥ 140. | Content shouldn't sit under the status or gesture bar. The bars and padding show the theme's `windowBackground`, and `AppTheme.NoActionBar` is `DayNight`, so a light phone gets light bars around a `#0F0F12` app. | After #43 lands, add `var(--safe-area-inset-*, env(safe-area-inset-*))` fallbacks (Capacitor injects the vars for WebView < 140), set `plugins.SystemBars.style: 'DARK'` and a dark `windowBackground` and splash. Check on an Android 15/16 device. |
| **`<input type=file>`** | `RosterScreen.tsx` (`.xlsx,.xls,.csv,.pdf` and `image/*`), `ShiftUpload.tsx`, `SectionEditor.tsx` (`.pdf,.png,.jpg,.jpeg,.webp`), `PolicyDocuments.tsx` (`application/pdf`) | Works: Capacitor's `BridgeWebChromeClient.onShowFileChooser` opens the system picker and maps extensions to MIME types via `MimeTypeMap`. | Check on a device that `.csv` and `.xls` files are pickable. Android may map `.csv` to `text/comma-separated-values` while Drive serves `text/csv`, which would grey the file out. |
| **Camera capture** | `RosterScreen.tsx:291` `accept="image/*" capture="environment"` | `onShowFileChooser` launches `ACTION_IMAGE_CAPTURE`. The manifest doesn't declare `CAMERA`, so Capacitor launches the camera app with no runtime prompt; if no camera app exists it falls back to the file picker. | Fine as-is. Use `@capacitor/camera` only if in-app capture is wanted later. |
| **Microphone (voice)** | `AppShell.tsx` uses `getUserMedia` + `MediaRecorder` | `BridgeWebChromeClient.onPermissionRequest` asks for `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS`, but `AndroidManifest.xml` declares neither, so the request can't be granted and voice will fail. | Add both `<uses-permission>` lines to `android/app/src/main/AndroidManifest.xml`, then test voice on a device. |
| **Policy document "Open"** | `PolicyDocuments.tsx:78` `window.open(blobUrl, '_blank')` | Capacitor's `Bridge.launchIntent` keeps `blob:` URLs inside the WebView, and Android WebView has no PDF viewer, so expect a blank page or nothing. | Render with the already-bundled `pdfjs-dist` in-app, or write the blob with `@capacitor/filesystem` and hand it to a file-opener plugin. |
| **Session in localStorage** | `SESSION_STORAGE_KEY = 'shiftsync.session'` (`src/api/identity.ts`) | WebView localStorage lives in the app's private data. It is lost on *Clear storage* or reinstall. It isn't evicted like a browser tab's best-effort storage, but it isn't a guaranteed store either. `android:allowBackup="true"` (template default) also means Android Auto Backup can copy the WebView data, token included, to a restored device. | Move the token to `@capacitor/preferences` (or Keystore-backed secure storage) on native. Decide on `allowBackup` (or backup rules excluding `app_webview`) before release. |
| **Web Push** | `src/lib/push.ts` `isPushSupported()` needs `serviceWorker` **and** `PushManager`. `main.tsx` calls `registerServiceWorker()` on load. | Android WebView doesn't implement the Push API or Notifications, so `isPushSupported()` is false: no service worker is registered, and Profile → Notification preferences says "Push notifications aren't supported in this browser." Expected from the platform; not yet seen on a device. | Native push needs `@capacitor/push-notifications` (FCM) and a server-side sender next to `web-push` (out of scope for this pass). Meanwhile, on native the copy should say "coming to the app" rather than "this browser". |
| **Deep links** | Invite `…/join?invite=<token>`, login `…/login/link#<token>` (minted for `FRONTEND_ORIGIN`) | They open in the phone's browser, not the app. The web flow still works there. | Android App Links: an `intent-filter` with `autoVerify` for the web host, `/.well-known/assetlinks.json` on Vercel, and `App.addListener('appUrlOpen')` routing to the path. |
| **External links** | `InviteScreen.tsx:150` `window.open('https://wa.me/…')` | `Bridge.launchIntent` hands any non-app host to an `ACTION_VIEW` intent, so WhatsApp or the browser opens. Expected to work. | None. |
| **Share / clipboard** | `StaffDirectory.tsx:575` `navigator.share`, then `navigator.clipboard.writeText` | Android WebView has no Web Share API, so the button reads "Copy link" and copies. Clipboard write should work (secure origin, user gesture); not yet seen on a device. | Use `@capacitor/share` if a native share sheet is wanted. |
| **Native branches** | `Capacitor.isNativePlatform()` is used only in `src/lib/nativeBack.ts` | Hardware back is wired; nothing else knows it runs natively. | Add native branches as the follow-ups above land. |
| **Sourcemaps in the APK** | `vite.config.ts` `build.sourcemap: true` | The `.map` files are copied into the APK (larger download; the same maps are already public on the web). | Optionally build the app bundle with `--sourcemap false`. |

## Before a store release (not done)

Release signing keystore (keep it out of git; `android/.gitignore` ignores `*.jks`/`*.keystore`),
`versionCode`/`versionName` in `android/app/build.gradle`, app icon and splash (still the
Capacitor defaults), `allowBackup`, the API custom domain, and the gaps above.
