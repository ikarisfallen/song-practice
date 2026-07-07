// SW version: 2026-07-05.1 — bump this comment to force Chrome to
// fetch the new SW on the next page load. Any byte-level change
// works; the timestamped comment is just easy to remember.
// Minimal service worker. Chrome/Android require at least a registered
// SW with a fetch handler before they'll offer "Install app" on the
// home screen. We don't cache anything ourselves — every request goes
// to the network. The trick is making sure the BROWSER doesn't quietly
// serve cached copies on our behalf either.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // `fetch(event.request)` with default cache mode lets the browser
  // serve cached copies for stable URLs — fine for CDN scripts, NOT
  // fine for our own files. PWAs on Android are especially sticky:
  // once a stale index.html or app.js is cached, the new code never
  // reaches the user even though we ship version-busted querystrings,
  // because the SW intercepts every request and the inner default-
  // cache fetch hands back the old response.
  //
  // Policy:
  //   - same-origin requests (our HTML, JS, CSS, manifest.json,
  //     song files, drum samples) → `cache: 'no-store'`. Always go
  //     to the network. Cheap on a static site, and means a
  //     `git push` is reflected on the next page open.
  //   - cross-origin (CDN: Tone.js, VexFlow, Midi) → default cache.
  //     These are versioned URLs, mostly stable, and forcing
  //     no-store would re-download megabytes of library code on
  //     every load.
  let sameOrigin = true;
  try {
    const reqUrl = new URL(event.request.url);
    sameOrigin = reqUrl.origin === self.location.origin;
  } catch (e) { /* default to same-origin if parsing fails */ }
  if (sameOrigin) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
  } else {
    event.respondWith(fetch(event.request));
  }
});
