var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/innertube.ts
var CLIENTS = [
  {
    name: "IOS",
    clientName: "IOS",
    clientVersion: "20.10.4",
    clientId: "5",
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X; en_US)",
    extraContext: {
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82"
    }
  },
  {
    name: "ANDROID_VR",
    clientName: "ANDROID_VR",
    clientVersion: "1.62.27",
    clientId: "28",
    userAgent: "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip",
    extraContext: {
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12",
      androidSdkVersion: 32
    }
  },
  {
    // Rarely succeeds now, but it is cheap and occasionally covers a video the
    // other two refuse. TVHTML5_SIMPLY_EMBEDDED_PLAYER was dropped: it returns
    // "YouTube is no longer supported in this application" for everything.
    name: "TVHTML5",
    clientName: "TVHTML5",
    clientVersion: "7.20250712.16.00",
    clientId: "7",
    userAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.master.0"
  }
];
function viaProxy(targetUrl, base) {
  const b = (base ?? "").trim();
  if (!b) return targetUrl;
  if (b.includes("{url}")) return b.replace("{url}", encodeURIComponent(targetUrl));
  const u = new URL(targetUrl);
  return b.replace(/\/$/, "") + u.pathname + u.search;
}
__name(viaProxy, "viaProxy");
function proxied(targetUrl, env) {
  return viaProxy(targetUrl, env.YT_PROXY_URL);
}
__name(proxied, "proxied");
function mediaProxyBase(env) {
  const explicit = (env.YT_MEDIA_PROXY_URL ?? "").trim();
  if (explicit) return explicit;
  const shared = (env.YT_PROXY_URL ?? "").trim();
  return shared.includes("{url}") ? shared : void 0;
}
__name(mediaProxyBase, "mediaProxyBase");
var INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
var PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?key=" + INNERTUBE_KEY + "&prettyPrint=false";
var ExtractionError = class extends Error {
  constructor(message, status = 502, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.name = "ExtractionError";
  }
  status;
  detail;
  static {
    __name(this, "ExtractionError");
  }
};
function parseVideoId(input) {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[\w-]{11}$/.test(raw)) return raw;
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  const v = url.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}
__name(parseVideoId, "parseVideoId");
async function callPlayer(client, videoId, env) {
  const context = {
    client: {
      clientName: client.clientName,
      clientVersion: client.clientVersion,
      hl: "en",
      gl: "US",
      ...client.extraContext ?? {}
    }
  };
  if (client.thirdParty) {
    context.thirdParty = { embedUrl: "https://www.youtube.com/" };
  }
  const body = JSON.stringify({
    videoId,
    context,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" }
    }
  });
  const target = proxied(PLAYER_URL, env);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": client.userAgent,
    "X-YouTube-Client-Name": client.clientId,
    "X-YouTube-Client-Version": client.clientVersion,
    Origin: "https://www.youtube.com",
    "Accept-Language": "en-US,en;q=0.9"
  };
  const res = await fetch(target, { method: "POST", headers, body });
  if (!res.ok) {
    throw new ExtractionError(
      `YouTube rejected the ${client.name} request`,
      502,
      `HTTP ${res.status}`
    );
  }
  return await res.json();
}
__name(callPlayer, "callPlayer");
function hasUsableStreams(pr) {
  const sd = pr.streamingData;
  if (!sd) return false;
  const all = [...sd.formats ?? [], ...sd.adaptiveFormats ?? []];
  return all.some((f) => !!f.url);
}
__name(hasUsableStreams, "hasUsableStreams");
async function callPlayerWithRetry(client, videoId, env, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callPlayer(client, videoId, env);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 250 * (i + 1)));
      }
    }
  }
  throw lastErr;
}
__name(callPlayerWithRetry, "callPlayerWithRetry");
async function fetchPlayer(videoId, env, opts) {
  const cacheKey = new Request(`https://player.sagetube.internal/${videoId}`);
  const cache = caches.default;
  if (!opts?.fresh) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const cached = await hit.json();
        if (cached?.player) return cached;
      }
    } catch {
    }
  }
  const failures = [];
  let transportOnly = true;
  for (const client of CLIENTS) {
    let pr;
    try {
      pr = await callPlayerWithRetry(client, videoId, env);
    } catch (err) {
      failures.push(`${client.name}: ${err.message}`);
      continue;
    }
    const status = pr.playabilityStatus?.status ?? "UNKNOWN";
    if (status === "OK" && hasUsableStreams(pr)) {
      const result = { player: pr, client: client.name };
      try {
        await cache.put(
          cacheKey,
          new Response(JSON.stringify(result), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "max-age=240"
            }
          })
        );
      } catch {
      }
      return result;
    }
    transportOnly = false;
    const reason = pr.playabilityStatus?.reason ?? pr.playabilityStatus?.messages?.join(" ") ?? (status === "OK" ? "no direct stream URLs returned" : status);
    failures.push(`${client.name}: ${reason}`);
    if (status === "ERROR" && /unavailable|private|removed|terminated/i.test(reason)) {
      throw new ExtractionError(reason, 404);
    }
  }
  const joined = failures.join(" | ");
  if (transportOnly) {
    throw new ExtractionError(
      "YouTube is rate-limiting this server right now. Wait a few seconds and try again.",
      503,
      joined
    );
  }
  if (/sign in|bot|confirm you/i.test(failures[0] ?? "")) {
    throw new ExtractionError(
      "YouTube wants a signed-in session for this particular video, so it cannot be fetched. Most other videos still work.",
      429,
      joined
    );
  }
  throw new ExtractionError("No playable streams found for this video.", 502, joined);
}
__name(fetchPlayer, "fetchPlayer");

// src/formats.ts
var CODEC_RE = /codecs="([^"]+)"/;
function parseMime(mime = "") {
  const type = mime.split("/")[0] || "";
  const sub = (mime.split("/")[1] || "").split(";")[0] || "";
  const codecs = (mime.match(CODEC_RE)?.[1] ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  let ext = sub;
  if (type === "audio") ext = sub === "mp4" ? "m4a" : sub;
  return { type, ext, codecs };
}
__name(parseMime, "parseMime");
function codecFamily(codecs) {
  const c = codecs.join(" ");
  if (/av01/.test(c)) return "AV1";
  if (/vp9|vp09/.test(c)) return "VP9";
  if (/avc1/.test(c)) return "H.264";
  if (/opus/.test(c)) return "Opus";
  if (/mp4a/.test(c)) return "AAC";
  return codecs[0] ?? "";
}
__name(codecFamily, "codecFamily");
function humanSize(bytes) {
  if (!bytes || bytes <= 0) return void 0;
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
__name(humanSize, "humanSize");
function codecScore(family) {
  return { "H.264": 3, VP9: 2, AV1: 1 }[family] ?? 0;
}
__name(codecScore, "codecScore");
function audioScore(family) {
  return { AAC: 2, Opus: 1 }[family] ?? 0;
}
__name(audioScore, "audioScore");
function extractFormats(player) {
  const sd = player.streamingData;
  const progressive = (sd?.formats ?? []).filter((f) => f.url);
  const adaptive = (sd?.adaptiveFormats ?? []).filter((f) => f.url);
  const toUi = /* @__PURE__ */ __name((f, kind) => {
    const { type, ext, codecs } = parseMime(f.mimeType);
    const size = f.contentLength ? Number(f.contentLength) : void 0;
    const bitrate = f.averageBitrate ?? f.bitrate;
    if (kind === "audio" || type === "audio" && kind !== "progressive") {
      const abr = bitrate ? Math.round(bitrate / 1e3) : void 0;
      return {
        itag: f.itag,
        kind: "audio",
        label: abr ? `${abr} kbps` : f.audioQuality ?? "audio",
        ext,
        codec: codecFamily(codecs),
        abr,
        bitrate,
        sizeBytes: size,
        sizeText: humanSize(size),
        needsMux: false
      };
    }
    const height = f.height;
    if (!height) return null;
    const fps = f.fps && f.fps > 30 ? f.fps : void 0;
    return {
      itag: f.itag,
      kind,
      label: `${height}p${fps ?? ""}`,
      ext: ext === "webm" ? "webm" : "mp4",
      codec: codecFamily(codecs),
      height,
      fps: f.fps,
      bitrate,
      sizeBytes: size,
      sizeText: humanSize(size),
      needsMux: kind === "video"
    };
  }, "toUi");
  const audio = [];
  for (const f of adaptive) {
    if (!f.mimeType?.startsWith("audio/")) continue;
    const ui = toUi(f, "audio");
    if (ui) audio.push(ui);
  }
  audio.sort(
    (a, b) => audioScore(b.codec) - audioScore(a.codec) || (b.abr ?? 0) - (a.abr ?? 0)
  );
  const bestAudioItag = audio[0]?.itag;
  const candidates = [];
  for (const f of progressive) {
    const ui = toUi(f, "progressive");
    if (ui) candidates.push(ui);
  }
  for (const f of adaptive) {
    if (!f.mimeType?.startsWith("video/")) continue;
    const ui = toUi(f, "video");
    if (ui) {
      ui.muxAudioItag = bestAudioItag;
      candidates.push(ui);
    }
  }
  const byLabel = /* @__PURE__ */ new Map();
  for (const c of candidates) {
    const prev = byLabel.get(c.label);
    if (!prev) {
      byLabel.set(c.label, c);
      continue;
    }
    const better = (c.kind === "progressive" ? 10 : 0) + codecScore(c.codec) > (prev.kind === "progressive" ? 10 : 0) + codecScore(prev.codec);
    if (better) byLabel.set(c.label, c);
  }
  const video = [...byLabel.values()].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0)
  );
  const kept = [];
  const audioOut = audio.filter((a) => {
    const abr = a.abr ?? 0;
    if (kept.some((k) => Math.abs(k - abr) <= 20)) return false;
    kept.push(abr);
    return true;
  });
  return { video, audio: audioOut };
}
__name(extractFormats, "extractFormats");
function findFormatUrl(player, itag) {
  const sd = player.streamingData;
  return [...sd?.formats ?? [], ...sd?.adaptiveFormats ?? []].find(
    (f) => f.itag === itag && f.url
  );
}
__name(findFormatUrl, "findFormatUrl");

// src/stream.ts
function safeFilename(name, ext) {
  const cleaned = name.replace(/[\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${cleaned || "video"}.${ext}`;
}
__name(safeFilename, "safeFilename");
function contentDisposition(filename, inline) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  const encoded = encodeURIComponent(filename);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
__name(contentDisposition, "contentDisposition");
async function streamFormat(opts, request, env) {
  const { player, client } = await fetchPlayer(opts.videoId, env, { fresh: true });
  const fmt = findFormatUrl(player, opts.itag);
  if (!fmt?.url) {
    throw new ExtractionError(
      "That quality is no longer offered for this video.",
      404
    );
  }
  const mime = (fmt.mimeType ?? "").split(";")[0] || "application/octet-stream";
  const sub = mime.split("/")[1] ?? "mp4";
  const ext = mime.startsWith("audio/") && sub === "mp4" ? "m4a" : sub;
  const title = opts.filename ?? player.videoDetails?.title ?? opts.videoId;
  const profile = CLIENTS.find((c) => c.name === client);
  const upstreamHeaders = {
    "User-Agent": profile?.userAgent ?? CLIENTS[0].userAgent,
    "Accept-Language": "en-US,en;q=0.9"
  };
  const range = request.headers.get("Range");
  if (range) upstreamHeaders.Range = range;
  const upstream = await fetch(viaProxy(fmt.url, mediaProxyBase(env)), {
    headers: upstreamHeaders
  });
  if (!upstream.ok && upstream.status !== 206) {
    let diagnostic = `HTTP ${upstream.status}`;
    try {
      const signedIp = new URL(fmt.url).searchParams.get("ip") ?? "?";
      const egress = await fetch("https://api.ipify.org?format=json").then((r) => r.json()).then((j) => j.ip ?? "?").catch(() => "?");
      diagnostic += ` | client=${client} | urlIp=${signedIp} | egressIp=${egress}`;
    } catch {
    }
    throw new ExtractionError("The media host refused the download.", 502, diagnostic);
  }
  const headers = new Headers();
  headers.set("Content-Type", mime);
  headers.set(
    "Content-Disposition",
    contentDisposition(safeFilename(title, ext), !!opts.inline)
  );
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "no-store");
  for (const h of ["Content-Length", "Content-Range"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");
  return new Response(upstream.body, { status: upstream.status, headers });
}
__name(streamFormat, "streamFormat");

// src/search.ts
var INNERTUBE_KEY2 = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
var WEB_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20250312.04.00",
  hl: "en",
  gl: "US"
};
var WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
var FILTER_VIDEOS_ONLY = "EgIQAQ%3D%3D";
function runsText(node) {
  if (!node || typeof node !== "object") return void 0;
  const n = node;
  if (typeof n.simpleText === "string") return n.simpleText;
  if (Array.isArray(n.runs)) {
    return n.runs.map((r) => typeof r.text === "string" ? r.text : "").join("");
  }
  return void 0;
}
__name(runsText, "runsText");
function parseDuration(text) {
  if (!text) return void 0;
  const parts = text.split(":").map((p) => Number(p.trim()));
  if (parts.some((p) => Number.isNaN(p))) return void 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
__name(parseDuration, "parseDuration");
function collectRenderers(node, out, depth = 0) {
  if (depth > 30 || !node) return;
  if (Array.isArray(node)) {
    for (const v of node) collectRenderers(v, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const n = node;
  for (const key of ["videoRenderer", "compactVideoRenderer", "gridVideoRenderer"]) {
    const r = n[key];
    if (r && typeof r === "object" && typeof r.videoId === "string") {
      out.push(r);
    }
  }
  for (const v of Object.values(n)) collectRenderers(v, out, depth + 1);
}
__name(collectRenderers, "collectRenderers");
function toFeedItem(r) {
  const id = r.videoId;
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const title = runsText(r.title);
  if (!title) return null;
  const thumbs = r.thumbnail?.thumbnails ?? [];
  const thumbnail = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const badges = JSON.stringify(r.badges ?? "") + JSON.stringify(r.thumbnailOverlays ?? "");
  const live = /LIVE|isLiveNow/i.test(badges);
  const duration = runsText(r.lengthText) ?? (typeof r.lengthSeconds === "string" ? void 0 : void 0);
  return {
    id,
    title,
    channel: runsText(r.ownerText) ?? runsText(r.longBylineText) ?? runsText(r.shortBylineText) ?? "Unknown",
    channelId: r.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint ? r.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId : void 0,
    duration,
    durationSeconds: parseDuration(duration),
    views: runsText(r.viewCountText) ?? runsText(r.shortViewCountText),
    published: runsText(r.publishedTimeText),
    thumbnail,
    live: live && !duration
  };
}
__name(toFeedItem, "toFeedItem");
async function innertube(endpoint, payload, env) {
  const res = await fetch(
    proxied(
      `https://www.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_KEY2}&prettyPrint=false`,
      env
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": WEB_UA,
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": WEB_CLIENT.clientVersion,
        Origin: "https://www.youtube.com",
        "Accept-Language": "en-US,en;q=0.9"
      },
      body: JSON.stringify({ context: { client: WEB_CLIENT }, ...payload })
    }
  );
  if (!res.ok) throw new Error(`InnerTube ${endpoint} failed: HTTP ${res.status}`);
  return res.json();
}
__name(innertube, "innertube");
function parseResults(data, limit, excludeLive) {
  const raw = [];
  collectRenderers(data, raw);
  const seen = /* @__PURE__ */ new Set();
  const items = [];
  for (const r of raw) {
    const item = toFeedItem(r);
    if (!item || seen.has(item.id)) continue;
    if (excludeLive && (item.live || !item.duration)) continue;
    seen.add(item.id);
    items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}
__name(parseResults, "parseResults");
function findContinuation(node, depth = 0) {
  if (depth > 30 || !node) return void 0;
  if (Array.isArray(node)) {
    for (const v of node) {
      const t = findContinuation(v, depth + 1);
      if (t) return t;
    }
    return void 0;
  }
  if (typeof node !== "object") return void 0;
  const n = node;
  const cc = n.continuationCommand;
  if (cc && typeof cc.token === "string") return cc.token;
  for (const v of Object.values(n)) {
    const t = findContinuation(v, depth + 1);
    if (t) return t;
  }
  return void 0;
}
__name(findContinuation, "findContinuation");
async function searchFull(query, env, limit = 30, opts) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await innertube("search", { query, params: FILTER_VIDEOS_ONLY }, env);
      const items = parseResults(data, limit, opts?.excludeLive);
      if (items.length) {
        return { items, continuation: findContinuation(data) };
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
  }
  if (lastErr) throw lastErr;
  return { items: [] };
}
__name(searchFull, "searchFull");
async function continueSearch(token, env, limit = 30, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await innertube("search", { continuation: token }, env);
      const items = parseResults(data, limit, opts?.excludeLive);
      if (items.length) {
        return { items, continuation: findContinuation(data) };
      }
    } catch {
    }
    if (attempt < 1) await new Promise((r) => setTimeout(r, 150));
  }
  return { items: [] };
}
__name(continueSearch, "continueSearch");
async function search(query, env, limit = 30, opts) {
  return (await searchFull(query, env, limit, opts)).items;
}
__name(search, "search");
var CATEGORIES = [
  // Queries lean towards produced, finished uploads. Broad terms like "news"
  // or "gaming" return mostly 24/7 live channels, which are filtered out and
  // would otherwise leave the grid nearly empty.
  {
    id: "trending",
    label: "Trending",
    queries: [
      "most viewed videos this week",
      "trending videos 2026",
      "viral video this month",
      "popular videos right now",
      "best videos this week"
    ]
  },
  {
    id: "music",
    label: "Music",
    queries: [
      "official music video 2026",
      "new songs 2026",
      "top hits this month",
      "official audio new release",
      "live performance 2026"
    ]
  },
  {
    id: "gaming",
    label: "Gaming",
    queries: [
      "gameplay walkthrough 2026",
      "gaming moments compilation",
      "new game review 2026",
      "speedrun world record",
      "best gaming clips"
    ]
  },
  {
    id: "movies",
    label: "Movies",
    queries: [
      "official movie trailer 2026",
      "new film trailer",
      "movie clips scenes",
      "behind the scenes film",
      "short film award winning"
    ]
  },
  {
    id: "news",
    label: "News",
    queries: [
      "news recap this week",
      "world news explained",
      "top stories this month",
      "news analysis 2026",
      "weekly news roundup"
    ]
  },
  {
    id: "sports",
    label: "Sports",
    queries: [
      "match highlights 2026",
      "best goals compilation",
      "sports top plays",
      "championship highlights",
      "greatest moments sport"
    ]
  },
  {
    id: "learning",
    label: "Learning",
    queries: [
      "documentary explained",
      "how it works explained",
      "science documentary 2026",
      "history documentary",
      "tutorial for beginners"
    ]
  },
  {
    id: "podcasts",
    label: "Podcasts",
    queries: [
      "podcast full episode",
      "interview podcast 2026",
      "best podcast moments",
      "long form interview",
      "podcast highlights"
    ]
  }
];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
__name(shuffle, "shuffle");
async function feed(categoryId, env) {
  const cat = CATEGORIES.find((c) => c.id === categoryId) ?? CATEGORIES[0];
  const cacheKey = new Request(`https://feed.sagetube.internal/${cat.id}`);
  const cache = caches.default;
  const query = cat.queries[Math.floor(Math.random() * cat.queries.length)];
  let result = { items: [] };
  try {
    result = await searchFull(query, env, 30, { excludeLive: true });
  } catch {
    result = { items: [] };
  }
  if (result.items.length) {
    const out = { items: shuffle(result.items), continuation: result.continuation };
    try {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(out), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "max-age=1800"
          }
        })
      );
    } catch {
    }
    return out;
  }
  const stale = await cache.match(cacheKey);
  if (stale) {
    const cached = await stale.json();
    return { items: shuffle(cached.items ?? []), continuation: cached.continuation };
  }
  return { items: [] };
}
__name(feed, "feed");

// src/landing.ts
var LANDING_PAGES = [
  {
    slug: "youtube-to-mp3",
    title: "YouTube to MP3 Converter - Free, No Sign-Up",
    h1: "YouTube to MP3 converter",
    description: "Convert any YouTube video to MP3 at 192 kbps, or grab the original M4A audio. Runs in your browser, no software and no account.",
    intro: "Paste a YouTube link below to pull the audio out of any video. You can take the untouched AAC (M4A) track straight from YouTube, or convert it to MP3 for players that need the older format. The conversion runs inside your browser, so the file never touches a server.",
    sections: [
      {
        h2: "M4A or MP3 - which should you pick?",
        body: "M4A is the audio YouTube actually stores, so downloading it is a straight copy with nothing lost and nothing re-encoded. MP3 has to be converted from that track, which costs a little quality but plays on virtually every device, car stereo and DJ program ever made. If your player supports M4A, take it. Otherwise take MP3 at 192 kbps."
      },
      {
        h2: "Why the audio quality tops out around 128 kbps",
        body: "YouTube does not store a lossless master for public playback. The best audio stream it serves is roughly 128 kbps AAC, so that is the ceiling for any downloader, including this one. A tool promising 320 kbps MP3 from YouTube is upscaling a 128 kbps source, which adds file size without adding detail."
      },
      {
        h2: "Good for podcasts, lectures and mixes",
        body: "Audio-only downloads are a fraction of the size of the video. A two-hour podcast is a few dozen megabytes as M4A instead of a gigabyte or more as 1080p, which makes it practical to keep offline on a phone."
      }
    ],
    faq: [
      {
        q: "Does converting to MP3 reduce the quality?",
        a: "Slightly, because it re-encodes an already compressed track. Choose M4A instead if your device supports it - that download is a bit-for-bit copy."
      },
      {
        q: "Is there a length limit?",
        a: "No fixed limit. Very long files use more browser memory during MP3 conversion, so for multi-hour recordings the direct M4A download is more reliable."
      }
    ]
  },
  {
    slug: "youtube-to-mp4",
    title: "YouTube to MP4 Downloader - 1080p, 720p, 480p",
    h1: "YouTube to MP4 downloader",
    description: "Download YouTube videos as MP4 in 480p, 720p or 1080p. No watermark, no sign-up, nothing installed.",
    intro: "Save any YouTube video as a standard MP4 that plays on phones, TVs and every editor. Pick the resolution you want and the file downloads straight to your device.",
    sections: [
      {
        h2: "Which resolution should you choose?",
        body: "720p is the practical default: it looks sharp on a phone or tablet and keeps files small enough to share over messaging apps. Choose 1080p when the video will be viewed on a laptop or TV, or when you plan to edit it. Below 480p the file gets noticeably soft on any modern screen."
      },
      {
        h2: "Why higher resolutions take an extra step",
        body: "YouTube only publishes one ready-made file that already contains both picture and sound, and it is 360p. Every resolution above that arrives as a separate video track and audio track. This site downloads both and joins them in your browser before saving. The streams are copied rather than re-encoded, so the result is identical in quality to the source and the join takes seconds rather than minutes."
      },
      {
        h2: "H.264 for maximum compatibility",
        body: "Where YouTube offers a choice of codecs, the H.264 version is preferred here. It is the format Premiere, Final Cut, DaVinci Resolve, PowerPoint and older TVs all understand. VP9 and AV1 are more efficient but far pickier about where they will play."
      }
    ],
    faq: [
      {
        q: "Will the MP4 have a watermark?",
        a: "No. The file is exactly what YouTube serves, with nothing overlaid or appended."
      },
      {
        q: "Can I open the file in a video editor?",
        a: "Yes. MP4 files using H.264 video and AAC audio import into every mainstream editor without conversion."
      }
    ]
  },
  {
    slug: "4k-video-downloader",
    title: "4K Video Downloader - Save YouTube in 2160p",
    h1: "4K video downloader",
    description: "Download YouTube videos in 4K (2160p) and 1440p, straight from your browser. No desktop app required.",
    intro: "When a video is published in 4K, this page will save it at full 2160p resolution. Pick the quality you want and the video and audio tracks are fetched and joined locally.",
    sections: [
      {
        h2: "Check that the source is really 4K",
        body: "A downloader cannot add detail that was never uploaded. If 2160p does not appear in the quality list, the creator did not publish a 4K version, and the highest entry shown is genuinely the best available. Upscaled 1080p offered as 4K elsewhere is just a bigger file of the same picture."
      },
      {
        h2: "Expect large files and a real merge step",
        body: "A few minutes of 2160p can run to several hundred megabytes, and 4K on YouTube is usually VP9 or AV1 rather than H.264. Both tracks are downloaded in full and merged in your browser, which needs enough free memory to hold them. On a machine with limited RAM, 1440p is a far lighter download that still looks excellent on most displays."
      },
      {
        h2: "1440p is the underrated option",
        body: "1440p carries most of the visible benefit of 4K at roughly a third of the file size, and it is far quicker to merge. Unless you are viewing on a genuine 4K panel, it is usually the better trade."
      }
    ],
    faq: [
      {
        q: "Why is 4K slower than 1080p?",
        a: "The file is several times larger, so both the download and the merge take proportionally longer. Nothing is being re-encoded - it is simply more data."
      },
      {
        q: "My browser ran out of memory on a 4K video.",
        a: "The merge holds both tracks in memory. Close other tabs and retry, or choose 1440p, which needs far less."
      }
    ]
  },
  {
    slug: "youtube-shorts-downloader",
    title: "YouTube Shorts Downloader - Save Shorts as MP4",
    h1: "YouTube Shorts downloader",
    description: "Download YouTube Shorts as MP4 without a watermark. Paste the Shorts link and save it in seconds.",
    intro: "Shorts links work exactly like any other YouTube URL here. Paste a /shorts/ address and it resolves to the video, with the full set of qualities available.",
    sections: [
      {
        h2: "Shorts are small and quick",
        body: "A Short is a minute or less, so even the highest quality is a small file and the merge for HD finishes almost instantly. Vertical video keeps its original 9:16 framing - nothing is cropped, padded or re-scaled."
      },
      {
        h2: "No watermark added",
        body: "The saved file is the stream YouTube serves, so there is no overlay from this site. Note that if the creator uploaded a clip that already carried a watermark from another platform, that mark is part of the video itself and cannot be removed by any downloader."
      }
    ],
    faq: [
      {
        q: "Do Shorts URLs work directly?",
        a: "Yes. Paste the /shorts/ link into the search box and it opens the video's download page automatically."
      }
    ]
  }
];
function findLanding(slug) {
  return LANDING_PAGES.find((p) => p.slug === slug);
}
__name(findLanding, "findLanding");

// src/render.ts
var SITE_NAME = "SageTube";
var SITE_TAGLINE = "YouTube Video & Audio Downloader";
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(esc, "esc");
function safeJson(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
__name(safeJson, "safeJson");
function isoDuration(seconds) {
  if (!seconds || seconds <= 0) return void 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = Math.floor(seconds % 60);
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s ? `${s}S` : ""}`;
}
__name(isoDuration, "isoDuration");
function navHtml(active) {
  const items = CATEGORIES.map(
    (c) => `<a class="side-item${active === c.id ? " active" : ""}" href="/category/${c.id}">
      <span>${esc(c.label)}</span></a>`
  ).join("");
  return `
    <a class="side-item${!active ? " active" : ""}" href="/"><span>Home</span></a>
    <div class="side-sep"></div>
    ${items}
    <div class="side-sep"></div>
    ${LANDING_PAGES.map(
    (p) => `<a class="side-item" href="/${p.slug}"><span>${esc(p.h1)}</span></a>`
  ).join("")}
    <div class="side-sep"></div>
    <a class="side-item" href="/how-to-download"><span>How it works</span></a>
    <a class="side-item" href="/faq"><span>FAQ</span></a>
    <p class="side-note">Download content you own or that is licensed for reuse. Respect copyright and YouTube's Terms of Service.</p>`;
}
__name(navHtml, "navHtml");
function chipsHtml(active) {
  const chips = [
    `<a class="chip${!active ? " active" : ""}" href="/">All</a>`,
    ...CATEGORIES.map(
      (c) => `<a class="chip${active === c.id ? " active" : ""}" href="/category/${c.id}">${esc(c.label)}</a>`
    )
  ];
  return `<nav class="chips" aria-label="Categories">${chips.join("")}</nav>`;
}
__name(chipsHtml, "chipsHtml");
function layout(o) {
  const ogImage = o.ogImage ?? `${o.origin}/og.png`;
  const jsonLd = (o.jsonLd ?? []).map((b) => `<script type="application/ld+json">${safeJson(b)}<\/script>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}" />
<link rel="canonical" href="${esc(o.canonical)}" />
${o.noindex ? '<meta name="robots" content="noindex, follow" />' : '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />'}
<meta name="theme-color" content="#0f0f0f" />
<meta property="og:site_name" content="${SITE_NAME}" />
<meta property="og:type" content="${esc(o.ogType ?? "website")}" />
<meta property="og:title" content="${esc(o.title)}" />
<meta property="og:description" content="${esc(o.description)}" />
<meta property="og:url" content="${esc(o.canonical)}" />
<meta property="og:image" content="${esc(ogImage)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(o.title)}" />
<meta name="twitter:description" content="${esc(o.description)}" />
<meta name="twitter:image" content="${esc(ogImage)}" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23ff0033'/%3E%3Cpath d='M13 9l10 7-10 7z' fill='%23fff'/%3E%3C/svg%3E" />
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="application-name" content="${SITE_NAME}" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="${SITE_NAME}" />
<meta name="mobile-web-app-capable" content="yes" />
<link rel="preconnect" href="https://i.ytimg.com" />
<link rel="dns-prefetch" href="https://i.ytimg.com" />
<link rel="stylesheet" href="/styles.css" />
${jsonLd}
</head>
<body>

<header class="topbar">
  <button class="icon-btn menu-btn" id="menuBtn" aria-label="Menu">
    <svg viewBox="0 0 24 24"><path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg>
  </button>

  <a class="brand" href="/" aria-label="${SITE_NAME} home">
    <span class="brand-mark"><svg viewBox="0 0 24 24"><path d="M9 7l9 5-9 5z"/></svg></span>
    <span class="brand-text">Sage<span>Tube</span></span>
  </a>

  <form class="searchbar" id="searchForm" role="search" action="/search" method="get">
    <input id="searchInput" name="q" type="search" autocomplete="off"
           value="${esc(o.searchValue ?? "")}"
           placeholder="Search or paste a YouTube link" aria-label="Search YouTube" />
    <button type="submit" class="search-go" aria-label="Search">
      <svg viewBox="0 0 24 24"><path d="M21 20l-5.6-5.6a7 7 0 10-1.4 1.4L20 21zM5 10.5a5.5 5.5 0 1111 0 5.5 5.5 0 01-11 0z"/></svg>
    </button>
  </form>

  <button class="icon-btn downloads-btn" id="downloadsBtn" aria-label="Downloads">
    <svg viewBox="0 0 24 24"><path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-5.7 1.4-1.4L12 13.6V3zM5 19h14v2H5z"/></svg>
    <span class="badge" id="dlBadge" hidden>0</span>
  </button>
</header>

<div class="shell">
  <nav class="sidebar" id="sidebar" aria-label="Categories">${navHtml(o.activeNav)}</nav>
  <div class="scrim" id="scrim"></div>
  <main class="main" id="main">
    <div class="install-banner" id="installBanner" hidden>
      <span class="install-mark"><svg viewBox="0 0 24 24"><path d="M9 7l9 5-9 5z"/></svg></span>
      <div class="install-copy">
        <b>Install ${SITE_NAME}</b>
        <span>Add it to your home screen for one-tap downloads, offline-ready.</span>
      </div>
      <button class="install-yes" id="installAccept">Install</button>
      <button class="install-no" id="installDismiss" aria-label="Not now">
        <svg viewBox="0 0 24 24"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
      </button>
    </div>
    ${chipsHtml(o.activeNav)}
    ${o.body}
  </main>
</div>

<div class="sheet-wrap" id="sheetWrap" hidden>
  <div class="sheet-backdrop" data-close></div>
  <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <div class="sheet-head">
      <img id="sheetThumb" alt="" />
      <div class="sheet-meta">
        <h3 id="sheetTitle">Loading...</h3>
        <p id="sheetSub"></p>
      </div>
      <button class="icon-btn" data-close aria-label="Close">
        <svg viewBox="0 0 24 24"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
      </button>
    </div>
    <div class="tabs" id="sheetTabs">
      <button class="tab active" data-tab="video">Video</button>
      <button class="tab" data-tab="audio">Audio</button>
    </div>
    <div class="sheet-body" id="sheetBody">
      <div class="loading"><span class="spinner"></span> Fetching available qualities...</div>
    </div>
  </section>
</div>

<aside class="drawer" id="drawer" hidden>
  <div class="drawer-head">
    <h3>Downloads</h3>
    <button class="text-btn" id="clearDone" hidden>Clear finished</button>
    <button class="icon-btn" id="drawerClose" aria-label="Close">
      <svg viewBox="0 0 24 24"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
    </button>
  </div>
  <div class="drawer-body" id="drawerBody"><p class="empty">Nothing downloading yet.</p></div>
</aside>

<div class="toast-stack" id="toasts"></div>

<script>window.__INITIAL__=${safeJson(o.initial ?? {})};<\/script>
<script src="/app.js" defer><\/script>
</body>
</html>`;
}
__name(layout, "layout");
var DL_ICON = `<svg viewBox="0 0 24 24"><path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-5.7 1.4-1.4L12 13.6V3zM5 19h14v2H5z"/></svg>`;
function cardHtml(v, eager = false) {
  const dur = v.live ? `<span class="dur live">LIVE</span>` : v.duration ? `<span class="dur">${esc(v.duration)}</span>` : "";
  const sub = [v.views, v.published].filter(Boolean).map(esc).join(" &middot; ");
  return `<article class="card" data-id="${esc(v.id)}" data-title="${esc(v.title)}">
  <a class="thumb-wrap" href="/watch/${esc(v.id)}" aria-label="${esc(v.title)}">
    <img src="${esc(v.thumbnail)}" alt="${esc(v.title)}" width="480" height="270"
         loading="${eager ? "eager" : "lazy"}" decoding="async" />
    ${dur}
  </a>
  <div class="card-body">
    <div class="card-text">
      <h3 class="card-title"><a href="/watch/${esc(v.id)}">${esc(v.title)}</a></h3>
      <p class="card-sub">${esc(v.channel)}</p>
      <p class="card-sub">${sub}</p>
    </div>
    <button class="dl-btn" data-dl="${esc(v.id)}" aria-label="Download ${esc(v.title)}">
      ${DL_ICON}<span>Get</span>
    </button>
  </div>
</article>`;
}
__name(cardHtml, "cardHtml");
function sentinelHtml(continuation) {
  if (!continuation) return "";
  return `<div class="sentinel" id="feedSentinel" data-token="${esc(continuation)}">
    <span class="spinner"></span><span>Loading more videos\u2026</span>
  </div>`;
}
__name(sentinelHtml, "sentinelHtml");
function gridHtml(items) {
  if (!items.length) {
    return `<div class="state"><h2>Nothing to show</h2><p>YouTube returned no results for this request. Try a different search or category.</p></div>`;
  }
  return `<div class="grid" id="grid">${items.map((v, i) => cardHtml(v, i < 4)).join("")}</div>`;
}
__name(gridHtml, "gridHtml");
function formatTableHtml(videoId, title, video, audio) {
  const row = /* @__PURE__ */ __name((f) => {
    const direct = !f.needsMux;
    const pill = direct ? `<span class="pill direct">Direct</span>` : `<span class="pill merge">Merge</span>`;
    const detail = direct ? `${f.ext.toUpperCase()} &middot; ${f.codec}${f.kind === "progressive" ? " &middot; with audio" : ""}` : `${f.ext.toUpperCase()} &middot; ${f.codec} &middot; merged with best audio in your browser`;
    return `<button class="fmt" data-itag="${f.itag}" data-kind="${f.kind}"
      data-mux="${f.needsMux ? 1 : 0}" data-audio-itag="${f.muxAudioItag ?? ""}"
      data-label="${esc(f.label)}" data-ext="${esc(f.ext)}"
      data-size="${f.sizeBytes ?? ""}">
      <span class="fmt-q">${esc(f.label)}</span>
      <span class="fmt-info"><b>${esc(detail)}</b>${f.sizeText ? esc(f.sizeText) : ""}</span>
      ${pill}
    </button>`;
  }, "row");
  return `<div class="panel">
    <h2>Download this video</h2>
    <p class="hint">Pick a quality. <b>Direct</b> saves straight from the source.
      <b>Merge</b> pulls the video and audio tracks and joins them in your browser
      &mdash; nothing is uploaded anywhere.</p>
    <div class="tabs" id="watchTabs">
      <button class="tab active" data-tab="video">Video (${video.length})</button>
      <button class="tab" data-tab="audio">Audio (${audio.length})</button>
    </div>
    <div id="watchFormats" data-video-id="${esc(videoId)}" data-title="${esc(title)}">
      <div data-pane="video">${video.map(row).join("") || `<p class="hint">No video streams available.</p>`}</div>
      <div data-pane="audio" hidden>${audio.map(row).join("") || `<p class="hint">No audio streams available.</p>`}</div>
    </div>
  </div>`;
}
__name(formatTableHtml, "formatTableHtml");

// src/index.ts
var json = /* @__PURE__ */ __name((data, status = 200, maxAge = 300) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": status === 200 ? `public, max-age=${maxAge}` : "no-store"
  }
}), "json");
var html = /* @__PURE__ */ __name((body, status = 200, maxAge = 600) => new Response(body, {
  status,
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": status === 200 ? `public, max-age=${maxAge}, s-maxage=${maxAge}` : "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  }
}), "html");
function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  const pad = /* @__PURE__ */ __name((n) => String(n).padStart(2, "0"), "pad");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
__name(fmtDuration, "fmtDuration");
async function homePage(origin, env, categoryId) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  const { items, continuation } = await feed(cat?.id ?? "trending", env).catch(() => ({
    items: [],
    continuation: void 0
  }));
  const heading = cat ? `${cat.label} videos to download` : `Download YouTube videos in MP4 and MP3`;
  const intro = cat ? `Browse ${cat.label.toLowerCase()} videos and save any of them as MP4 video or M4A/MP3 audio, in the quality you choose.` : `Search YouTube, preview any video, and download it as MP4 up to 4K or extract the audio as MP3. No app to install, no account, nothing uploaded to a server.`;
  const canonical = cat ? `${origin}/category/${cat.id}` : `${origin}/`;
  const body = `
    <div class="page-head">
      <h1>${esc(heading)}</h1>
      <p>${esc(intro)}</p>
    </div>
    ${gridHtml(items)}
    ${sentinelHtml(continuation)}
    ${cat ? "" : homeSeoProse()}`;
  return html(
    layout({
      title: cat ? `${cat.label} Videos - Download MP4 & MP3 | ${SITE_NAME}` : `${SITE_NAME} - ${SITE_TAGLINE} (MP4, 1080p, 4K, MP3)`,
      description: intro,
      canonical,
      origin,
      activeNav: cat?.id,
      initial: {
        page: cat ? "category" : "home",
        category: cat?.id ?? null,
        items,
        continuation
      },
      body,
      jsonLd: [
        {
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: SITE_NAME,
          url: `${origin}/`,
          potentialAction: {
            "@type": "SearchAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: `${origin}/search?q={search_term_string}`
            },
            "query-input": "required name=search_term_string"
          }
        },
        {
          "@context": "https://schema.org",
          "@type": "WebApplication",
          name: SITE_NAME,
          url: `${origin}/`,
          applicationCategory: "MultimediaApplication",
          operatingSystem: "Any (web browser)",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }
        }
      ]
    }),
    200,
    120
  );
}
__name(homePage, "homePage");
function homeSeoProse() {
  return `<section class="seo">
    <h2>Save YouTube videos as MP4 or MP3</h2>
    <p>${SITE_NAME} is a browser-based downloader. Paste a YouTube link or search
    from the bar above, choose a quality, and the file saves straight to your
    device. There is no desktop app, no browser extension and no sign-up.</p>

    <h3>Every quality YouTube offers</h3>
    <p>YouTube serves 360p as a single ready-made file, and everything above it
    as separate video and audio tracks. ${SITE_NAME} lists both: the 360p file
    downloads directly, while 480p, 720p, 1080p, 1440p and 4K are joined back
    together inside your browser using WebAssembly. The tracks are copied, not
    re-encoded, so there is no quality loss and no waiting on a server queue.</p>

    <h3>Audio-only downloads</h3>
    <p>Switch to the Audio tab to pull just the soundtrack. The original AAC
    (M4A) track downloads directly at up to 128 kbps, and MP3 conversion runs
    locally in your browser if you need the more compatible format.</p>

    <h3>Your files stay yours</h3>
    <p>Merging and conversion happen on your own machine. Files are never
    written to disk on our side, never queued and never retained.</p>

    <h3>Please download responsibly</h3>
    <p>Use ${SITE_NAME} for videos you own, videos published under a licence
    that permits reuse, or content you have permission to save. Downloading
    copyrighted material without permission may breach YouTube's Terms of
    Service and local copyright law.</p>
  </section>`;
}
__name(homeSeoProse, "homeSeoProse");
async function watchPage(videoId, origin, env) {
  const { player } = await fetchPlayer(videoId, env);
  const { video, audio } = extractFormats(player);
  const d = player.videoDetails;
  const title = d?.title ?? "Untitled";
  const channel = d?.author ?? "Unknown";
  const seconds = Number(d?.lengthSeconds ?? 0);
  const description = (d?.shortDescription ?? "").slice(0, 5e3);
  const views = d?.viewCount ? Number(d.viewCount).toLocaleString("en-US") : void 0;
  const thumb = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  const canonical = `${origin}/watch/${videoId}`;
  const best = video[0]?.label ?? "HD";
  const metaDesc = `Download "${title}" by ${channel} as MP4 up to ${best}, or extract the audio as MP3. Free, no sign-up, straight from your browser.`;
  const relatedItems = await search(
    title.split(/\s+/).slice(0, 6).join(" "),
    env,
    12
  ).catch(() => []);
  const related = relatedItems.filter((r) => r.id !== videoId).slice(0, 8);
  const body = `
  <div class="watch">
    <div>
      <iframe class="player" src="https://www.youtube-nocookie.com/embed/${esc(videoId)}"
        title="${esc(title)}" loading="lazy" allowfullscreen
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"></iframe>
      <h1>${esc(title)}</h1>
      <p class="watch-meta">${esc(channel)}${views ? ` &middot; ${esc(views)} views` : ""}${seconds ? ` &middot; ${esc(fmtDuration(seconds))}` : ""}</p>
      ${formatTableHtml(videoId, title, video, audio)}
      ${description ? `<h2 style="font-size:15px;margin:24px 0 4px">Description</h2><div class="watch-desc">${esc(description.slice(0, 1200))}</div>` : ""}
    </div>
    <aside class="related">
      <h2>Related videos</h2>
      ${related.length ? `<div class="grid">${related.map((r) => cardHtml(r)).join("")}</div>` : `<p class="card-sub">No related videos found.</p>`}
    </aside>
  </div>`;
  return html(
    layout({
      title: `Download "${title}" - MP4 & MP3 | ${SITE_NAME}`,
      description: metaDesc,
      canonical,
      origin,
      ogType: "video.other",
      ogImage: thumb,
      initial: { page: "watch", videoId, title, video, audio },
      body,
      jsonLd: [
        {
          "@context": "https://schema.org",
          "@type": "VideoObject",
          name: title,
          description: description.slice(0, 500) || metaDesc,
          thumbnailUrl: [
            `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
            `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
          ],
          duration: isoDuration(seconds),
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
          contentUrl: `https://www.youtube.com/watch?v=${videoId}`,
          uploadDate: void 0,
          author: { "@type": "Person", name: channel },
          interactionStatistic: d?.viewCount ? {
            "@type": "InteractionCounter",
            interactionType: { "@type": "WatchAction" },
            userInteractionCount: Number(d.viewCount)
          } : void 0
        },
        {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: `${origin}/` },
            { "@type": "ListItem", position: 2, name: title, item: canonical }
          ]
        }
      ]
    })
  );
}
__name(watchPage, "watchPage");
function converterBox(placeholder) {
  return `<form class="hero-box" action="/search" method="get" role="search">
    <input name="q" type="search" required
      placeholder="${esc(placeholder)}" aria-label="YouTube link" />
    <button type="submit">Get it</button>
  </form>`;
}
__name(converterBox, "converterBox");
function landingPageHtml(page, origin) {
  const others = LANDING_PAGES.filter((p) => p.slug !== page.slug);
  const canonical = `${origin}/${page.slug}`;
  const body = `
    <div class="page-head">
      <h1>${esc(page.h1)}</h1>
      <p>${esc(page.intro)}</p>
    </div>
    ${converterBox("Paste a YouTube link...")}
    <section class="seo" style="margin-top:32px">
      ${page.sections.map((s) => `<h2>${esc(s.h2)}</h2><p>${esc(s.body)}</p>`).join("")}
      <h2>Questions</h2>
      ${page.faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join("")}
      <h2>More download tools</h2>
      <ul>
        ${others.map((p) => `<li><a href="/${p.slug}" style="color:#3ea6ff">${esc(p.h1)}</a></li>`).join("")}
        <li><a href="/how-to-download" style="color:#3ea6ff">How to download a YouTube video</a></li>
      </ul>
    </section>`;
  return html(
    layout({
      title: `${page.title} | ${SITE_NAME}`,
      description: page.description,
      canonical,
      origin,
      body,
      jsonLd: [
        {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: page.faq.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a }
          }))
        },
        {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: `${origin}/` },
            { "@type": "ListItem", position: 2, name: page.h1, item: canonical }
          ]
        }
      ]
    })
  );
}
__name(landingPageHtml, "landingPageHtml");
async function searchPage(q, origin, env) {
  const { items, continuation } = q ? await searchFull(q, env).catch(() => ({ items: [], continuation: void 0 })) : { items: [], continuation: void 0 };
  const body = `
    <div class="page-head">
      <h1>${esc(q ? `Download videos for "${q}"` : "Search")}</h1>
      <p>${items.length} result${items.length === 1 ? "" : "s"}. Pick any video to choose a quality.</p>
    </div>
    ${gridHtml(items)}
    ${sentinelHtml(continuation)}`;
  return html(
    layout({
      title: `${q} - Download MP4 & MP3 | ${SITE_NAME}`,
      description: `Download videos matching "${q}" as MP4 video or MP3 audio.`,
      canonical: `${origin}/search?q=${encodeURIComponent(q)}`,
      origin,
      searchValue: q,
      // Search result pages are thin/duplicative; index the hub pages instead.
      noindex: true,
      initial: { page: "search", query: q, items },
      body
    })
  );
}
__name(searchPage, "searchPage");
var FAQ = [
  {
    q: "Is SageTube free to use?",
    a: "Yes. There is no account, no subscription and no download limit."
  },
  {
    q: "Why does 1080p need to be merged?",
    a: "YouTube only serves a ready-made video-plus-audio file at 360p. Every higher resolution is delivered as a separate video track and audio track, so the two must be joined before the file will play with sound. SageTube does that inside your browser."
  },
  {
    q: "Does merging re-encode and lose quality?",
    a: "No. The tracks are stream-copied into an MP4 container, so the video and audio data are bit-for-bit identical to what YouTube served."
  },
  {
    q: "Do my videos get uploaded to a server?",
    a: "No. The merge and any MP3 conversion run locally in your browser with WebAssembly. Nothing is stored on our side."
  },
  {
    q: "Can I download age-restricted or private videos?",
    a: "Private videos are never accessible. Some age-restricted videos work and some do not, depending on how YouTube gates them."
  },
  {
    q: "Is downloading YouTube videos legal?",
    a: "It depends on the content and where you live. Downloading your own uploads or openly licensed material is generally fine. Saving copyrighted content without permission may breach YouTube's Terms of Service and copyright law. Use the tool responsibly."
  }
];
function faqPage(origin) {
  const body = `
    <div class="page-head"><h1>Frequently asked questions</h1>
    <p>How ${SITE_NAME} works, and what it can and cannot do.</p></div>
    <section class="seo" style="margin-top:16px;border-top:0;padding-top:0">
      ${FAQ.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join("")}
    </section>`;
  return html(
    layout({
      title: `FAQ - YouTube Downloader Questions | ${SITE_NAME}`,
      description: "Answers about downloading YouTube videos as MP4 or MP3: quality, merging, privacy and legality.",
      canonical: `${origin}/faq`,
      origin,
      body,
      jsonLd: [
        {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: FAQ.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a }
          }))
        }
      ]
    })
  );
}
__name(faqPage, "faqPage");
function howToPage(origin) {
  const steps = [
    { name: "Find the video", text: "Search from the bar at the top, or paste a full YouTube link." },
    { name: "Open it", text: "Select the video to open its page, or press Get on any card." },
    { name: "Pick a quality", text: "Choose an MP4 resolution from the Video tab, or an audio format from the Audio tab." },
    { name: "Save the file", text: "Direct qualities download immediately. Higher resolutions are merged in your browser first, then saved." }
  ];
  const body = `
    <div class="page-head"><h1>How to download a YouTube video</h1>
    <p>Four steps, no software to install.</p></div>
    <section class="seo" style="margin-top:16px;border-top:0;padding-top:0">
      <ol>${steps.map((s) => `<li><b style="color:var(--text)">${esc(s.name)}.</b> ${esc(s.text)}</li>`).join("")}</ol>
      <h3>Which format should I pick?</h3>
      <p>For phones and general sharing, 720p MP4 is the sweet spot. For archiving, take the
      highest resolution offered. For music or podcasts, use the Audio tab and take M4A for the
      best quality or MP3 for the widest compatibility.</p>
    </section>`;
  return html(
    layout({
      title: `How to Download YouTube Videos (MP4 & MP3) | ${SITE_NAME}`,
      description: "Step-by-step: search or paste a YouTube link, choose a quality, and save the video as MP4 or the audio as MP3.",
      canonical: `${origin}/how-to-download`,
      origin,
      body,
      jsonLd: [
        {
          "@context": "https://schema.org",
          "@type": "HowTo",
          name: "How to download a YouTube video",
          step: steps.map((s, i) => ({
            "@type": "HowToStep",
            position: i + 1,
            name: s.name,
            text: s.text
          }))
        }
      ]
    })
  );
}
__name(howToPage, "howToPage");
function robots(origin) {
  return new Response(
    `User-agent: *
Allow: /$
Allow: /watch/
Allow: /category/
Disallow: /api/
Disallow: /search

Sitemap: ${origin}/sitemap.xml
`,
    { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } }
  );
}
__name(robots, "robots");
async function sitemap(origin, env) {
  const urls = [
    { loc: `${origin}/`, priority: "1.0", changefreq: "hourly" },
    { loc: `${origin}/how-to-download`, priority: "0.7", changefreq: "monthly" },
    { loc: `${origin}/faq`, priority: "0.6", changefreq: "monthly" },
    // Keyword landing pages carry the commercial intent, so they rank above
    // the category feeds in priority.
    ...LANDING_PAGES.map((p) => ({
      loc: `${origin}/${p.slug}`,
      priority: "0.9",
      changefreq: "weekly"
    })),
    ...CATEGORIES.map((c) => ({
      loc: `${origin}/category/${c.id}`,
      priority: "0.8",
      changefreq: "daily"
    }))
  ];
  const trending = (await feed("trending", env).catch(() => ({ items: [] }))).items;
  for (const v of trending.slice(0, 40)) {
    urls.push({ loc: `${origin}/watch/${v.id}`, priority: "0.7", changefreq: "weekly" });
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(
    (u) => `  <url><loc>${esc(u.loc)}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
  ).join("\n")}
</urlset>`;
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    }
  });
}
__name(sitemap, "sitemap");
function notFound(origin) {
  return html(
    layout({
      title: `Page not found | ${SITE_NAME}`,
      description: "That page does not exist.",
      canonical: `${origin}/`,
      origin,
      noindex: true,
      body: `<div class="state"><h2>Page not found</h2><p>That link does not point anywhere. <a href="/" style="color:#3ea6ff">Go back home</a>.</p></div>`
    }),
    404
  );
}
__name(notFound, "notFound");
function errorPage(origin, err) {
  const message = err instanceof ExtractionError ? err.message : "Something went wrong loading that video.";
  const status = err instanceof ExtractionError ? err.status : 500;
  return html(
    layout({
      title: `Unavailable | ${SITE_NAME}`,
      description: message,
      canonical: `${origin}/`,
      origin,
      noindex: true,
      body: `<div class="state"><h2>Cannot load this video</h2><p>${esc(message)}</p>
        <p style="margin-top:12px"><a href="/" style="color:#3ea6ff">Back to home</a></p></div>`
    }),
    status >= 500 ? 502 : status
  );
}
__name(errorPage, "errorPage");
async function handleInfo(url, env) {
  const input = url.searchParams.get("url") ?? url.searchParams.get("v") ?? "";
  const videoId = parseVideoId(input);
  if (!videoId) return json({ error: "That doesn't look like a YouTube link." }, 400);
  const { player, client } = await fetchPlayer(videoId, env);
  const { video, audio } = extractFormats(player);
  const d = player.videoDetails;
  const seconds = Number(d?.lengthSeconds ?? 0);
  return json({
    id: videoId,
    title: d?.title ?? "Untitled",
    channel: d?.author ?? "Unknown",
    duration: seconds ? fmtDuration(seconds) : void 0,
    views: d?.viewCount ? Number(d.viewCount).toLocaleString("en-US") : void 0,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    extractedWith: client,
    video,
    audio
  });
}
__name(handleInfo, "handleInfo");
async function handleDownload(url, request, env, inline) {
  const videoId = parseVideoId(url.searchParams.get("v") ?? url.searchParams.get("url") ?? "");
  const itag = Number(url.searchParams.get("itag"));
  if (!videoId || !Number.isFinite(itag)) {
    return json({ error: "Missing video id or itag." }, 400);
  }
  return streamFormat(
    { videoId, itag, inline, filename: url.searchParams.get("title") ?? void 0 },
    request,
    env
  );
}
__name(handleDownload, "handleDownload");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    if (path.startsWith("/api/")) {
      try {
        switch (path) {
          case "/api/categories":
            return json(CATEGORIES.map(({ id, label }) => ({ id, label })));
          case "/api/feed":
            return json(await feed(url.searchParams.get("category") ?? "trending", env), 200, 60);
          case "/api/more": {
            const token = url.searchParams.get("token") ?? "";
            if (!token) return json({ error: "Missing token." }, 400);
            const live = url.searchParams.get("live") === "1";
            return json(
              await continueSearch(token, env, 30, { excludeLive: !live }),
              200,
              60
            );
          }
          case "/api/search": {
            const q = (url.searchParams.get("q") ?? "").trim();
            if (!q) return json({ error: "Empty search." }, 400);
            const asId = parseVideoId(q);
            if (asId && /https?:|youtu/i.test(q)) return json({ items: [], resolvedVideoId: asId });
            return json({ items: await search(q, env) });
          }
          case "/api/info":
            return await handleInfo(url, env);
          case "/api/download":
            return await handleDownload(url, request, env, false);
          case "/api/stream":
            return await handleDownload(url, request, env, true);
          default:
            return json({ error: "Not found" }, 404);
        }
      } catch (err) {
        if (err instanceof ExtractionError) {
          return json({ error: err.message, detail: err.detail }, err.status);
        }
        return json({ error: err.message ?? "Unexpected error" }, 500);
      }
    }
    if (path === "/robots.txt") return robots(origin);
    if (path === "/sitemap.xml") return sitemap(origin, env);
    try {
      if (path === "/") return await homePage(origin, env);
      if (path === "/faq") return faqPage(origin);
      if (path === "/how-to-download") return howToPage(origin);
      const landing = findLanding(path.slice(1));
      if (landing) return landingPageHtml(landing, origin);
      if (path === "/search") {
        const q = (url.searchParams.get("q") ?? url.searchParams.get("u") ?? url.searchParams.get("text") ?? "").trim();
        const pasted = parseVideoId(q);
        if (pasted && (/https?:|youtu/i.test(q) || /^[\w-]{11}$/.test(q))) {
          return Response.redirect(`${origin}/watch/${pasted}`, 302);
        }
        return await searchPage(q, origin, env);
      }
      const cat = path.match(/^\/category\/([\w-]+)$/);
      if (cat) {
        if (!CATEGORIES.some((c) => c.id === cat[1])) return notFound(origin);
        return await homePage(origin, env, cat[1]);
      }
      const watch = path.match(/^\/watch\/([\w-]{11})$/);
      if (watch) return await watchPage(watch[1], origin, env);
      if (path === "/watch") {
        const id = parseVideoId(url.searchParams.get("v") ?? "");
        if (id) return Response.redirect(`${origin}/watch/${id}`, 301);
      }
      return notFound(origin);
    } catch (err) {
      return errorPage(origin, err);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-lMDhoF/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-lMDhoF/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
