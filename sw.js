const CACHE_NAME = 'das-beste-des-tages-v20';

// Ohne diese beiden Dateien startet die App nicht. Sie liegen auf einem
// fremden Server (jsDelivr), deshalb werden sie gleich bei der Installation
// mitgesichert – sonst bleibt die App beim ersten Start ohne Netz leer.
const EXTERNAL_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/fuse.js@7.0.0'
];

const FONT_URL = './fonts/schibsted-grotesk-latin-wght-normal.woff2';

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await cache.addAll(['./index.html', './icon.svg', './icon-192.png', './apple-touch-icon.png', './manifest.json', FONT_URL]);
      // Fehlschläge hier dürfen die Installation nicht verhindern
      await Promise.all(EXTERNAL_ASSETS.map(url => cache.add(url).catch(() => {})));
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            caches.open(CACHE_NAME).then(c => c.put('./index.html', response.clone()));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Schrift ändert sich nie: direkt aus dem Cache
  if (url.origin === self.location.origin && url.pathname.includes('/fonts/')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
        if (response.ok) caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
        return response;
      }))
    );
    return;
  }

  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const network = fetch(event.request).then(response => {
          if (response.ok) {
            caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
          }
          return response;
        });
        // Sofort aus dem Cache antworten, die Kopie im Hintergrund auffrischen
        if (cached) { network.catch(() => {}); return cached; }
        return network;
      })
    );
  }
});

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {}
  const title = payload.title || 'Wir zwei';
  const options = {
    body: payload.body || 'Was war heute dein schönster Moment? Halte ihn kurz fest.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: payload.url || './?tab=wir' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './?tab=wir';
  const tab = new URL(targetUrl, self.location.href).searchParams.get('tab');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          if (tab) client.postMessage({ type: 'open-tab', tab });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
