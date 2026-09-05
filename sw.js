/* PaperPress service worker — precache app shell, runtime-cache fonts. */
const CACHE = "paperpress-v8";
const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./viewer.js",
  "./manifest.webmanifest",
  "./vendor/pdf-lib.min.js",
  "./vendor/pdf.min.js",
  "./vendor/pdf.worker.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin && !isFont) return;

  // cache-first; fonts get cached on first successful fetch
  event.respondWith(
    caches.match(req, { ignoreSearch: isSameOrigin }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && (isFont || isSameOrigin)) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => {
        if (req.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      });
    })
  );
});
