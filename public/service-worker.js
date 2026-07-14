// service-worker.js
//
// Two jobs:
// 1. Cache the app shell so the app still opens with no signal (common
//    for a crew that's traveling).
// 2. Let index.html keep working offline; actual clock in/out data is
//    handled separately by offlineQueue.js, not by this file, since that
//    needs IndexedDB rather than the Cache API.

const CACHE_NAME = "site-clock-shell-v1";
const SHELL_FILES = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache API calls — those go through the online/offline queue
  // logic in offlineQueue.js instead, so we always want a live network
  // attempt for them.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // App shell: cache-first, so the app opens instantly and works offline.
  event.respondWith(
    caches.match(request).then((cached) => {
      return (
        cached ||
        fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() => caches.match("/index.html"))
      );
    })
  );
});
