// Minimal service worker. Chrome/Android require at least a registered
// SW with a fetch handler before they'll offer "Install app" on the
// home screen. We don't actually cache anything here — just pass
// requests through to the network. This keeps the install path alive
// without the headache of managing a cache for audio samples and
// MusicXML that change frequently during development.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
