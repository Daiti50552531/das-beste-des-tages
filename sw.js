const CACHE_NAME = 'das-beste-des-tages-v11';

// Ohne diese beiden Dateien startet die App nicht. Sie liegen auf einem
// fremden Server (jsDelivr), deshalb werden sie gleich bei der Installation
// mitgesichert – sonst bleibt die App beim ersten Start ohne Netz leer.
const EXTERNAL_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/fuse.js@7.0.0'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await cache.addAll(['./index.html', './icon.svg', './manifest.json']);
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
  const title = payload.title || 'Das Beste des Tages';
  const options = {
    body: payload.body || 'Hast du heute schon dein Bestes des Tages festgehalten?',
    icon: './icon.svg',
    badge: './icon.svg',
    data: { url: payload.url || './?action=new' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
