const cacheName = "codex-control-plane-shell-v4";
const shell = ["/", "/styles.css", "/app.js", "/notifications.js", "/environment.js", "/run-output.js", "/live-view.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(shell)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("codex-control-plane-shell-") && key !== cacheName).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") void self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (!shell.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(cacheName).then((cache) => cache.put(url.pathname, copy)));
    }
    return response;
  }).catch(async () => {
    const cache = await caches.open(cacheName);
    return await cache.match(url.pathname) || new Response("Runner unavailable", { status: 503 });
  }));
});
