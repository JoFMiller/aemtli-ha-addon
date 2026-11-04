/* Service Worker – App-Shell offline verfügbar, online IMMER frisch.
   Strategie: network-first für eigene Assets (Cache nur als Offline-Fallback),
   damit geänderte index.html/app.js sofort ankommen. Fehlerantworten werden nie
   gecacht. Der Grocy-Proxy (/grocy/) und fremde Origins werden nicht angefasst.
   Seit 2.3 zeigt er außerdem Web-Push-Nachrichten „Neues auf der Liste“ an. */
const CACHE = "aemtli-v8";
const SHELL = [
  "./",
  "./index.html",
  "./boot.js",
  "./shelf.js",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/badge-96.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // tolerant: ein fehlendes Icon darf die Installation nicht verhindern
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
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

  // Grocy-API-Proxy (/grocy/), Open-Food-Facts-Proxy (/off/) und Push-Dienst (/push/) niemals cachen – dynamisch + mit Auth.
  if (url.pathname.includes("/grocy/") || url.pathname.includes("/off/") || url.pathname.includes("/push/")) return;

  // Fremde Origin: nicht anfassen, direkt ans Netz.
  if (url.origin !== self.location.origin) return;

  // Navigationsanfragen: network-first, Cache (index.html) als Offline-Fallback.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            e.waitUntil(caches.open(CACHE).then((c) => c.put("./index.html", copy)));
          }
          return res;
        })
        .catch(() =>
          caches.match("./index.html")
            .then((c) => c || caches.match("./"))
            .then((c) => c || Response.error())
        )
    );
    return;
  }

  // Eigene Assets: network-first (mit Revalidierung), Cache als Fallback.
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      })
      .catch(() => caches.match(req).then((c) => c || Response.error()))
  );
});

/* ---- Web Push (Ämtli 2.3) ---- */
// Der Dienst im Add-on schickt JSON {title, body, tag, url}; Text als Fallback.
self.addEventListener("push", (e) => {
  let d = {};
  if (e.data) {
    try { d = e.data.json() || {}; }
    catch (_) { try { d = { body: e.data.text() }; } catch (__) { d = {}; } }
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "Ämtli", {
      body: d.body || "",
      tag: d.tag || "aemtli",
      renotify: true,                       // gleicher Tag ersetzt die alte Nachricht – trotzdem hörbar
      icon: "./icons/icon-192.png",
      badge: "./icons/badge-96.png",   // Statusleiste: Android nimmt nur den Alphakanal → weiße Silhouette ohne Hintergrund
      data: { url: d.url || "./" },
    })
  );
});

// Antippen: ein offenes Ämtli-Fenster nach vorn holen, sonst die App öffnen.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const scope = self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const win = list.find((c) => c.url && c.url.startsWith(scope));
      if (win && "focus" in win) return win.focus();
      return self.clients.openWindow ? self.clients.openWindow(scope) : undefined;
    })
  );
});

// Der Browser hat das Abo erneuert oder verworfen: Die App meldet es beim nächsten Start selbst neu.
self.addEventListener("pushsubscriptionchange", () => {
  console.log("[aemtli] pushsubscriptionchange – die App synchronisiert beim nächsten Start");
});
