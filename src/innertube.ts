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
 * Order matters. ANDROID_VR is first because as of now it is the only client
 * that reliably returns un-throttled, un-ciphered URLs *and* does not demand a
 * PO token. IOS is a close second but its HLS-only responses are more common.
 * The TV client is the last resort — it works for age-gated/embed-restricted
 * videos that the other two refuse.
 */
export const CLIENTS: ClientProfile[] = [
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
    name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
    clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
    clientVersion: "2.0",
    clientId: "85",
    userAgent:
      "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
    thirdParty: true,
  },
];

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

  const target = env.YT_PROXY_URL
    ? `${env.YT_PROXY_URL.replace(/\/$/, "")}/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`
    : PLAYER_URL;

  const res = await fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": client.userAgent,
      "X-YouTube-Client-Name": client.clientId,
      "X-YouTube-Client-Version": client.clientVersion,
      Origin: "https://www.youtube.com",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body,
  });

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
export async function fetchPlayer(
  videoId: string,
  env: { YT_PROXY_URL?: string },
): Promise<{ player: PlayerResponse; client: string }> {
  const failures: string[] = [];

  for (const client of CLIENTS) {
    let pr: PlayerResponse;
    try {
      pr = await callPlayer(client, videoId, env);
    } catch (err) {
      failures.push(`${client.name}: ${(err as Error).message}`);
      continue;
    }

    const status = pr.playabilityStatus?.status ?? "UNKNOWN";
    if (status === "OK" && hasUsableStreams(pr)) {
      return { player: pr, client: client.name };
    }

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
  if (/sign in|bot|confirm you/i.test(joined)) {
    throw new ExtractionError(
      "YouTube demanded a bot check for this request.",
      429,
      joined,
    );
  }
  throw new ExtractionError("No playable streams found.", 502, joined);
}
