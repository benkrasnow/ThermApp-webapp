// Service worker: makes the installed app work with no network.
//
// Every app file is cached when the service worker installs. Requests then go network-first:
// when the server (this PC over `adb reverse`, or a website) is reachable you get the current
// files, which also refresh the cache. When it isn't, the cached copy is served at once. So an
// app installed once over USB debugging keeps working with the PC unplugged.
//
// Bump CACHE when the file list changes. Content updates don't need a bump: network-first
// fetches refresh the cache whenever the server is reachable.

const CACHE = "thermapp-v1";
const APP_FILES = [
  "./", "./index.html", "./app.css", "./manifest.webmanifest",
  "./js/main.js", "./js/worker.js", "./js/usb.js", "./js/protocol.js", "./js/calibration.js",
  "./js/processing.js", "./js/enhance.js", "./js/view.js", "./js/capture.js", "./js/palettes.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/favicon-32.png",
];
const NETWORK_TIMEOUT_MS = 2500;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_FILES.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Only the app's own files. Calibration lookups and anything else go straight to the network.
  if (req.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith(new URL("./", location).pathname)) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req, { cache: "no-cache" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") return (await cache.match("./index.html")) || Response.error();
    return Response.error();
  }
}
