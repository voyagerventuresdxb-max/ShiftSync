import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { handleBack } from './backNavigation';

/**
 * Android hardware back → the shared back mechanism (src/lib/backNavigation.ts).
 *
 * Registering a `backButton` listener disables Capacitor's default handling
 * (WebView history back, else finish the activity), so every branch below is
 * explicit:
 *   (i)/(ii) a registered handler consumed it (an open overlay closed, or the
 *            onboarding wizard stepped back);
 *   (iii)    otherwise plain history back when the WebView has history;
 *   (iv)     at a root entry with nothing behind it, exit the app.
 *
 * A no-op in the browser (`Capacitor.isNativePlatform()` is false there), so
 * the web build carries no behaviour change. iOS has no hardware back and
 * Capacitor iOS 8.5.2 never enables WKWebView's edge-swipe gesture
 * (`allowsBackForwardNavigationGestures` stays at its `false` default — see
 * Decisions.md), so nothing here applies to iOS.
 */
export async function registerNativeBackButton(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await App.addListener('backButton', ({ canGoBack }) => {
    if (handleBack()) return;
    if (canGoBack) {
      window.history.back();
      return;
    }
    void App.exitApp();
  });
}
