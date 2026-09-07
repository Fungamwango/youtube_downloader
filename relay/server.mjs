#!/usr/bin/env node
/**
 * SageTube relay.
 *
 * Why this exists
 * ---------------
 * googlevideo signs the requesting IP into every stream URL (`ip` appears in
 * the URL's `sparams`), so a download only succeeds when the media request
 * leaves from the same address that minted the URL.
 *
 * From Cloudflare Workers that is impossible: Cloudflare reaches
 * www.youtube.com over IPv4 but googlevideo over IPv6, so the minting address
 * and the fetching address never match and the media host answers 403.
 * Measured on the deployed Worker, that broke 7 of 8 downloads.
 *
 * This relay fixes it by performing BOTH halves — the InnerTube call that mints
 * the URL and the media fetch that reads it — from this one machine, so the
 * addresses agree. Run it anywhere with a normal residential or VPS
 * connection; the Worker stays the public site.
 *
 * Usage
 * -----
 *   node relay/server.mjs                    # listens on 127.0.0.1:8789
 *   PORT=9000 TOKEN=secret node relay/server.mjs
 *
 * Then expose it (no port-forwarding needed):
 *   cloudflared tunnel --url http://localhost:8789
 *
 * and point the Worker at it:
 *   npx wrangler secret put YT_PROXY_URL
 *   # https://<tunnel>.trycloudflare.com/fetch?token=<TOKEN>&url={url}
 *
 * Requires Node 18+ (uses the built-in fetch).
 */

import http from "node:http";

const PORT = Number(process.env.PORT || 8789);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.TOKEN || "";

/**
 * Only these hosts may be fetched. Without this the relay would be an open
 * proxy that anyone who learned the URL could point at any server on the
 * internet — or at machines inside your own network.
 */
const ALLOWED_HOST = /(^|\.)(youtube\.com|youtubei\.googleapis\.com|googlevideo\.com|ytimg\.com|youtu\.be)$/i;

/** Hop-by-hop headers that must not be forwarded. */
const STRIP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "content-length",
  "accept-encoding",
]);

function deny(res, code, message) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(message + "\n");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return deny(res, 400, "Bad request URL");
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname !== "/fetch") return deny(res, 404, "Not found");

  if (TOKEN && url.searchParams.get("token") !== TOKEN) {
    return deny(res, 403, "Bad or missing token");
  }

  const target = url.searchParams.get("url");
  if (!target) return deny(res, 400, "Missing ?url=");

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return deny(res, 400, "Malformed target URL");
  }
  if (targetUrl.protocol !== "https:") return deny(res, 400, "Only https targets");
  if (!ALLOWED_HOST.test(targetUrl.hostname)) {
    return deny(res, 403, `Host not allowed: ${targetUrl.hostname}`);
  }

  // Forward the caller's headers (User-Agent and Range matter most) minus the
  // hop-by-hop ones, so YouTube sees the same request the Worker would send.
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  }

  // Demand an uncompressed body. Node's fetch decompresses transparently but
  // then reports the *compressed* content-length (and drops content-encoding),
  // so forwarding those headers truncated the response. Asking for identity
  // sidesteps that entirely and keeps content-length accurate for progress.
  headers["accept-encoding"] = "identity";

  const method = req.method || "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);

  let upstream;
  try {
    upstream = await fetch(targetUrl, { method, headers, body, redirect: "follow" });
  } catch (err) {
    return deny(res, 502, `Upstream fetch failed: ${err.message}`);
  }

  // Node's fetch transparently decompresses, so the body written below is
  // decoded while upstream's content-length describes the *compressed* size.
  // Forwarding that length truncates the response — it silently cut InnerTube
  // JSON in half. Drop the length whenever the body was encoded.
  const wasEncoded = !!upstream.headers.get("content-encoding");

  const out = {};
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (["content-encoding", "transfer-encoding", "connection"].includes(k)) return;
    if (k === "content-length" && wasEncoded) return;
    out[key] = value;
  });
  res.writeHead(upstream.status, out);

  if (!upstream.body) return res.end();

  // Stream rather than buffer, so a 4K download does not sit in memory.
  let written = 0;
  try {
    for await (const chunk of upstream.body) {
      const buf = Buffer.from(chunk);
      written += buf.length;
      if (!res.write(buf)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
  } catch (err) {
    // Never swallow this silently: an error here truncates the body, and a
    // half-written response looks like corrupt data rather than a failure.
    console.error(
      `relay: stream aborted after ${written} bytes for ${targetUrl.hostname}: ${err.message}`,
    );
    res.destroy();
    return;
  }
  res.end();
});

// Binding to anything but loopback means the internet can reach this. Without
// a token that is an open proxy running on someone else's bandwidth bill, so
// refuse to start rather than quietly becoming one.
const isPublic = HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1";
if (isPublic && !TOKEN) {
  console.error(
    `Refusing to listen on ${HOST} without a token.\n` +
      "Set TOKEN=<something-secret> so only your Worker can use this relay.",
  );
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`SageTube relay listening on http://${HOST}:${PORT}`);
  console.log(`  health check: /health`);
  console.log(`  token: ${TOKEN ? "required" : "NOT SET (loopback only)"}`);
});
