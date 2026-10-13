// Volley service worker: push notifications + app badge. No offline caching (keeps updates instant).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // presence of a fetch handler keeps iOS happy

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Volley';
  const opts = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    try {
      if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
        data.badge > 0 ? await self.navigator.setAppBadge(data.badge) : await self.navigator.clearAppBadge();
      }
    } catch {}
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((c) => c.postMessage({ type: 'push', data }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if ('focus' in c) {
        c.postMessage({ type: 'open', url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
