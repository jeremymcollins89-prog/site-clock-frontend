// service-worker.js
//
// Two jobs:
// 1. Cache the app shell so the app still opens with no signal (common
//    for a crew that's traveling).
// 2. Let index.html keep working offline; actual clock in/out data is
//    handled separately by offlineQueue.js, not by this file, since that
//    needs IndexedDB rather than the Cache API.

const CACHE_NAME = "site-clock-shell-v4";
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

// Job-scheduling push notifications: the backend sends { title, body, url }
// when an admin schedules this employee for a job.
self.addEventListener("push", (event) => {
  let data = { title: "Coll Timeclock", body: "You have a schedule update.", url: "/" };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({ type: "navigate", url: targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
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

  // The page itself (index.html / "/"): network-first. This is the piece
  // that was going stale — cache-first meant a phone that had ever opened
  // the app would keep seeing that same snapshot forever, no matter how
  // many times we shipped an update. Network-first means anyone with a
  // signal always gets the latest version; the cached copy is only used
  // as a fallback when there's genuinely no connection at all.
  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("/index.html"))
        )
    );
    return;
  }

  // Everything else (icons, manifest, the built JS/CSS bundles, which are
  // content-hashed per build): cache-first is safe here since a new
  // deploy produces new filenames rather than overwriting old ones.
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
