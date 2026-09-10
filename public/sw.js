/**
 * ShiftSync service worker — Web Push only, for now. Handles a `push`
 * event by showing a notification, and a `notificationclick` by focusing
 * (or opening) a window at the URL the payload names. Not a full
 * offline/asset-caching service worker; nothing here intercepts `fetch`.
 *
 * Registered from src/lib/push.ts (`registerServiceWorker`) on every app
 * load — registration itself never prompts the user for anything. The
 * actual permission prompt only happens when a person explicitly opts in
 * (see src/lib/push.ts's `subscribeToPush`), never automatically here.
 */

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: 'ShiftSync', body: event.data.text() };
    }
  }

  const title = data.title || 'ShiftSync';
  const options = {
    body: data.body || '',
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
