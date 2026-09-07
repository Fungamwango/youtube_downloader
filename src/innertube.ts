/**
 * InnerTube player client.
 *
 * Why this and not yt-dlp: Workers run in a V8 isolate with no subprocesses and
 * no Python, so the extractor has to be pure JS. The one method that works
 * without shipping a JS interpreter is to ask InnerTube using a *mobile/TV*
 * client context. Those clients get `streamingData.formats[].url` handed to
 * them directly, while the WEB client gets `signatureCipher` blobs that can
 * only be unscrambled by executing YouTube's player.js (impossible here: no
 * `eval` in Workers).
 *
 * The clients are tried in order and the first playable response wins.
 */

export interface ClientProfile {
  name: string;
  clientName: string;
  clientVersion: string;
  clientId: string;
  userAgent: string;
  extraContext?: Record<string, unknown>;
  /** Sent as the `cpn`-less embed referer for the TV client. */
  thirdParty?: boolean;
}

/**
 * Order matters, and it is measured rather than assumed. Tested across a
 * sample of videos, IOS answered every one with direct URLs; ANDROID_VR
 * answered one in four and returned LOGIN_REQUIRED ("Sign in to confirm you're
 * not a bot") for the rest; ANDROID, the music clients, WEB_CREATOR and both
 * embedded-player clients failed outright. So IOS leads and ANDROID_VR backs it
 * up, since the two fail on different videos.
 *
 * Re-check this order when extraction starts failing broadly: which clients
 * YouTube accepts changes every few months, and the fix is usually a reorder
 * or a client-version bump rather than new logic.
 */
export const CLIENTS: ClientProfile[] = [
  {
    name: "IOS",
    clientName: "IOS",
    clientVersion: "20.10.4",
    clientId: "5",
    userAgent:
      "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X; en_US)",
    extraContext: {
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
    },
  },
  {
    name: "ANDROID_VR",
    clientName: "ANDROID_VR",
    clientVersion: "1.62.27",
    clientId: "28",
    userAgent:
      "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip",
    extraContext: {
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12",
      androidSdkVersion: 32,
    },
  },
  {
    // Rarely succeeds now, but it is cheap and occasionally covers a video the
    // other two refuse. TVHTML5_SIMPLY_EMBEDDED_PLAYER was dropped: it returns
    // "YouTube is no longer supported in this application" for everything.
    name: "TVHTML5",
    clientName: "TVHTML5",
    clientVersion: "7.20250712.16.00",
    clientId: "7",
    userAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.master.0",
  },
];

/**
 * Routes an InnerTube URL through YT_PROXY_URL when one is configured.
 *
 * Workers' fetch() cannot use a classic CONNECT proxy, so two shapes that it
 * *can* use are supported:
 *   - a template containing {url}, for scraping APIs that take the target as a
 *     query parameter, e.g. https://api.example.com/get?token=X&url={url}
 *   - a reverse-proxy origin that mirrors youtube.com's paths, e.g.
 *     https://yt.example.com  ->  https://yt.example.com/youtubei/v1/player?...
 */
export function viaProxy(targetUrl: string, base?: string): string {
  const b = (base ?? "").trim();
  if (!b) return targetUrl;
  if (b.includes("{url}")) return b.replace("{url}", encodeURIComponent(targetUrl));
  const u = new URL(targetUrl);
  return b.replace(/\/$/, "") + u.pathname + u.search;
}

export function proxied(targetUrl: string, env: { YT_PROXY_URL?: string }): string {
  return viaProxy(targetUrl, env.YT_PROXY_URL);
}

/**
 * Picks the proxy for media (googlevideo) requests.
 *
 * googlevideo signs the minting IP into the stream URL, so a download only
 * succeeds when it leaves from the same address that minted it. Proxying only
 * the InnerTube call makes that worse, not better — the URL would be signed for
 * the relay while the media still left from Cloudflare. Both have to go through
 * the same relay.
 *
 * Only a {url}-template proxy can carry media, because a path-mirroring base
 * cannot express arbitrary googlevideo hostnames.
 */
export function mediaProxyBase(env: {
  YT_PROXY_URL?: string;
  YT_MEDIA_PROXY_URL?: string;
}): string | undefined {
  const explicit = (env.YT_MEDIA_PROXY_URL ?? "").trim();
  if (explicit) return explicit;
  const shared = (env.YT_PROXY_URL ?? "").trim();
  return shared.includes("{url}") ? shared : undefined;
}

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const PLAYER_URL =
  "https://www.youtube.com/youtubei/v1/player?key=" +
  INNERTUBE_KEY +
  "&prettyPrint=false";

export interface RawFormat {
  itag: number;
  url?: string;
  signatureCipher?: string;
  mimeType?: string;
  bitrate?: number;
  averageBitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  qualityLabel?: string;
  contentLength?: string;
  audioQuality?: string;
  audioSampleRate?: string;
  audioChannels?: number;
  approxDurationMs?: string;
}

export interface PlayerResponse {
  playabilityStatus?: {
    status?: string;
    reason?: string;
    messages?: string[];
  };
  streamingData?: {
    expiresInSeconds?: string;
    formats?: RawFormat[];
    adaptiveFormats?: RawFormat[];
    hlsManifestUrl?: string;
  };
  videoDetails?: {
    videoId?: string;
    title?: string;
    lengthSeconds?: string;
    author?: string;
    channelId?: string;
    viewCount?: string;
    shortDescription?: string;
    isLiveContent?: boolean;
    thumbnail?: { thumbnails?: { url: string; width: number; height: number }[] };
  };
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

/** Accepts any YouTube URL shape, or a bare 11-character video ID. */
export function parseVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[\w-]{11}$/.test(raw)) return raw;

  let url: URL;
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

  // /shorts/ID, /embed/ID, /live/ID, /v/ID
  const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

async function callPlayer(
  client: ClientProfile,
  videoId: string,
  env: { YT_PROXY_URL?: string },
): Promise<PlayerResponse> {
  const context: Record<string, unknown> = {
    client: {
      clientName: client.clientName,
      clientVersion: client.clientVersion,
      hl: "en",
      gl: "US",
      ...(client.extraContext ?? {}),
    },
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
      contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" },
    },
  });

  const target = proxied(PLAYER_URL, env);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": client.userAgent,
    "X-YouTube-Client-Name": client.clientId,
    "X-YouTube-Client-Version": client.clientVersion,
    Origin: "https://www.youtube.com",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // Note: X-Forwarded-For was tried here to make YouTube mint the URL against
  // the Worker's IPv6 egress. YouTube ignores it — the signed `ip` came back
  // unchanged — so it was removed rather than left as cargo cult.
  const res = await fetch(target, { method: "POST", headers, body });

  if (!res.ok) {
    throw new ExtractionError(
      `YouTube rejected the ${client.name} request`,
      502,
      `HTTP ${res.status}`,
    );
  }
  return (await res.json()) as PlayerResponse;
}

function hasUsableStreams(pr: PlayerResponse): boolean {
  const sd = pr.streamingData;
  if (!sd) return false;
  const all = [...(sd.formats ?? []), ...(sd.adaptiveFormats ?? [])];
  return all.some((f) => !!f.url);
}

/**
 * Walks the client list until one returns playable streams.
 * Throws an ExtractionError carrying YouTube's own reason when all fail, so the
 * UI can show something better than "something went wrong".
 */
/**
 * A transport failure (429, 5xx) is not a verdict about the client — it is
 * usually YouTube throttling this server for a moment. Falling straight through
 * to the next client turns a temporary rate-limit into a permanent-looking
 * "bot check", because the fallback clients genuinely are bot-checked. So the
 * same client is retried briefly before moving on.
 */
async function callPlayerWithRetry(
  client: ClientProfile,
  videoId: string,
  env: { YT_PROXY_URL?: string },
  attempts = 3,
): Promise<PlayerResponse> {
  let lastErr: unknown;
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

export async function fetchPlayer(
  videoId: string,
  env: { YT_PROXY_URL?: string },
  opts?: { fresh?: boolean },
): Promise<{ player: PlayerResponse; client: string }> {
  // Short-lived cache for metadata. The watch page and /api/info would
  // otherwise each hit YouTube, which is what invites the throttling.
  //
  // Downloads must pass fresh:true. googlevideo bakes the requesting IP into
  // the URL it hands back, so a URL minted during one request and fetched
  // during another is answered with 403 — the stream has to be minted by the
  // same request that goes on to read it.
  const cacheKey = new Request(`https://player.sagetube.internal/${videoId}`);
  const cache = caches.default;
  if (!opts?.fresh) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const cached = (await hit.json()) as {
          player: PlayerResponse;
          client: string;
        };
        if (cached?.player) return cached;
      }
    } catch {
      // A cache miss or parse failure just means we fetch it fresh.
    }
  }

  const failures: string[] = [];
  let transportOnly = true;

  for (const client of CLIENTS) {
    let pr: PlayerResponse;
    try {
      pr = await callPlayerWithRetry(client, videoId, env);
    } catch (err) {
      failures.push(`${client.name}: ${(err as Error).message}`);
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
              "Cache-Control": "max-age=240",
            },
          }),
        );
      } catch {
        // Caching is an optimisation; failing to store must not fail the call.
      }
      return result;
    }

    // A real answer from YouTube, so the run is no longer purely transport
    // failures — the message below can speak about the video, not throttling.
    transportOnly = false;

    const reason =
      pr.playabilityStatus?.reason ??
      pr.playabilityStatus?.messages?.join(" ") ??
      (status === "OK" ? "no direct stream URLs returned" : status);
    failures.push(`${client.name}: ${reason}`);

    // These are verdicts about the video itself, not the client — retrying
    // other clients cannot change them.
    if (status === "ERROR" && /unavailable|private|removed|terminated/i.test(reason)) {
      throw new ExtractionError(reason, 404);
    }
  }

  const joined = failures.join(" | ");

  // Every client failed at the transport layer: throttling, not a bot verdict.
  // Saying "blocked" here sent people chasing the wrong problem.
  if (transportOnly) {
    throw new ExtractionError(
      "YouTube is rate-limiting this server right now. Wait a few seconds and try again.",
      503,
      joined,
    );
  }

  // The primary client only ever reports a bot check when it is genuinely
  // gated; the fallbacks report it constantly, so they must not decide this.
  if (/sign in|bot|confirm you/i.test(failures[0] ?? "")) {
    throw new ExtractionError(
      "YouTube wants a signed-in session for this particular video, so it " +
        "cannot be fetched. Most other videos still work.",
      429,
      joined,
    );
  }
  throw new ExtractionError("No playable streams found for this video.", 502, joined);
}
