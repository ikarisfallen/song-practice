// Minimal service worker. Chrome/Android require at least a registered
// SW with a fetch handler before they'll offer "Install app" on the
// home screen. We don't actually cache anything ourselves — just pass
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
  // The plain `fetch(event.request)` form re-issues the request with
  // its default cache mode, which means JS-initiated fetches go
  // through the browser's HTTP cache. That's a problem for the
  // songs/ folder: those URLs are stable (e.g. songs/Jordu.musicxml
  // with no ?v= cachebuster) so a cached 200 response keeps being
  // returned even after the file on disk is edited or deleted.
  // Hard-refreshing the page doesn't help — it only bypasses cache
  // for the initial page load, not for SW-mediated fetches that
  // happen later.
  //
  // For the songs/ folder we force `cache: 'no-store'` so every
  // probe and head-load goes to the network. Other resources
  // (Tone.js / VexFlow CDN scripts, drum samples, etc.) keep the
  // default cache behavior so production loads stay fast.
  const url = new URL(event.request.url);
  if (url.pathname.includes('/songs/')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
  } else {
    event.respondWith(fetch(event.request));
  }
});
