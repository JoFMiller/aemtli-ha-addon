/* Service Worker – App-Shell offline verfügbar, aber online IMMER frisch.
   Strategie: network-first für eigene Assets (Cache nur als Offline-Fallback),
   damit geänderte index.html/app.js sofort ankommen (kein Cache-Bump nötig).
   Der Grocy-Proxy (/grocy/) und fremde Origins werden nicht angefasst. */
const CACHE = "aemtli-v3";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Grocy-API-Proxy (/grocy/) niemals cachen – dynamisch + mit Auth.
  // includes() statt startsWith(), damit es auch unter einem Basispfad greift.
  if (url.pathname.includes("/grocy/")) return;

  // Fremde Origin: nicht anfassen, direkt ans Netz.
  if (url.origin !== self.location.origin) return;

  // Navigationsanfragen: network-first, Cache (index.html) als Offline-Fallback.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((c) => c || caches.match("./")))
    );
    return;
  }

  // Eigene Assets: network-first, Cache als Fallback (offline / Server weg).
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
