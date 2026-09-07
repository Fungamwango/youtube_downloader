/* SageTube service worker.
 *
 * Deliberately conservative. Its jobs are to make the app installable, to keep
 * the shell usable offline, and above all to stay out of the way of downloads:
 * /api/ requests are never intercepted, because passing a ranged, multi-hundred
 * megabyte media stream through the SW would break resume and buffer the whole
 * file in the worker.
 */

var VERSION = "sagetube-v1";
var STATIC_CACHE = VERSION + "-static";
var PAGE_CACHE = VERSION + "-pages";

var PRECACHE = [
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then(function (cache) {
        // A single missing file must not fail the whole install.
        return Promise.all(
          PRECACHE.map(function (url) {
            return cache.add(url).catch(function () {});
          })
        );
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) { return k.indexOf(VERSION) !== 0; })
            .map(function (k) { return caches.delete(k); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (event) {
  if (event.data === "skip-waiting") self.skipWaiting();
});

function isStaticAsset(url) {
  return /\.(css|js|png|svg|webmanifest|ico|woff2?)$/.test(url.pathname);
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  // Never touch other origins (YouTube thumbnails, the ffmpeg CDN).
  if (url.origin !== self.location.origin) return;

  // Never touch the API. Downloads rely on range requests and streaming.
  if (url.pathname.indexOf("/api/") === 0) return;

  if (isStaticAsset(url)) {
    // Cache-first, refreshed in the background.
    event.respondWith(
      caches.match(req).then(function (hit) {
        var net = fetch(req)
          .then(function (res) {
            if (res && res.ok) {
              var copy = res.clone();
              caches.open(STATIC_CACHE).then(function (c) { c.put(req, copy); });
            }
            return res;
          })
          .catch(function () { return hit; });
        return hit || net;
      })
    );
    return;
  }

  if (req.mode === "navigate") {
    // Network-first: pages are server-rendered and change often, so a stale
    // cache hit would show outdated results. Cache is the offline fallback.
    event.respondWith(
      fetch(req)
        .then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(PAGE_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            if (hit) return hit;
            // Each step is a promise, so this has to chain rather than use ||.
            return caches.match("/").then(function (home) {
              return (
                home ||
                new Response(
                  "<!doctype html><meta charset=utf-8><title>Offline</title>" +
                    '<body style="background:#0f0f0f;color:#f1f1f1;font-family:system-ui;' +
                    'display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
                    "<div><h1>You are offline</h1>" +
                    "<p style=\"color:#aaa\">SageTube needs a connection to reach YouTube.</p></div>",
                  { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 503 }
                )
              );
            });
          });
        })
    );
  }
});
