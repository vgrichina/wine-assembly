// Service worker that synthesises cross-origin isolation headers.
//
// A document's isolation is decided by the headers on the response that created
// it, and a controlling service worker builds that response. So a host that
// will not set COOP/COEP for us — wine-assembly.berrry.app sets neither — can
// still yield `crossOriginIsolated === true`, which is the gate on handing a
// shared WebAssembly.Memory to a Worker.
//
// This is the `coi-serviceworker` pattern. It is not a way around the security
// model: the headers can only be added within our own origin's scope, and COEP
// still genuinely blocks foreign subresources afterwards.
//
// DELIBERATELY DOES NOT CACHE. The repo has no service worker precisely because
// a stale cache turns every later change into "my fix did nothing". This one
// re-headers and forwards, nothing else — every request still hits the network.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const req = event.request;
  // Range requests must pass through untouched: rebuilding the response would
  // drop the 206 semantics that media and large artifacts rely on.
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      // An opaque (no-cors) response has an unreadable body, so it cannot be
      // rebuilt — return it as-is and let COEP block it if it must.
      if (res.type === 'opaque' || res.type === 'opaqueredirect') return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      // Same-origin resources are automatically embeddable, but stamping CORP
      // costs nothing and covers the case of this origin being embedded.
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    } catch (err) {
      return new Response(String(err && err.message || err), { status: 502 });
    }
  })());
});
