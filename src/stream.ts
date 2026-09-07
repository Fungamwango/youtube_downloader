/**
 * The actual download path.
 *
 * googlevideo URLs are short-lived (~6h) and bound to the request that minted
 * them, so we never hand a raw URL to the browser — every download is re-minted
 * server-side and streamed through the Worker. That also lets us attach a real
 * Content-Disposition filename, which a bare redirect cannot do.
 *
 * The body is a pass-through ReadableStream: the Worker never buffers the file,
 * so memory stays flat regardless of whether it is a 3 MB song or a 4K movie.
 */

import {
  fetchPlayer,
  ExtractionError,
  CLIENTS,
  viaProxy,
  mediaProxyBase,
} from "./innertube";
import { findFormatUrl } from "./formats";

/** Strips characters Windows/macOS reject in filenames. */
export function safeFilename(name: string, ext: string): string {
  const cleaned = name
    .replace(/[\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${cleaned || "video"}.${ext}`;
}

/** RFC 5987 encoding so non-ASCII titles survive the header. */
function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  const encoded = encodeURIComponent(filename);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface StreamOptions {
  videoId: string;
  itag: number;
  /** attachment (download) vs inline (fetched by the in-browser muxer) */
  inline?: boolean;
  /** overrides the title from YouTube, used to name merged files */
  filename?: string;
}

export async function streamFormat(
  opts: StreamOptions,
  request: Request,
  env: { YT_PROXY_URL?: string; YT_MEDIA_PROXY_URL?: string },
): Promise<Response> {
  // fresh:true is required — see fetchPlayer. A cached player response carries
  // URLs minted for a different request's IP, which googlevideo answers with 403.
  const { player, client } = await fetchPlayer(opts.videoId, env, { fresh: true });
  const fmt = findFormatUrl(player, opts.itag);
  if (!fmt?.url) {
    throw new ExtractionError(
      "That quality is no longer offered for this video.",
      404,
    );
  }

  const mime = (fmt.mimeType ?? "").split(";")[0] || "application/octet-stream";
  const sub = mime.split("/")[1] ?? "mp4";
  const ext = mime.startsWith("audio/") && sub === "mp4" ? "m4a" : sub;
  const title = opts.filename ?? player.videoDetails?.title ?? opts.videoId;

  // Forward Range verbatim so browsers can resume and seek. googlevideo
  // honours it; without it, large downloads cannot be resumed.
  // googlevideo checks that the caller looks like the client the URL was minted
  // for. The client varies per request (IOS or ANDROID_VR, whichever answers
  // first), so the UA has to be looked up rather than hardcoded — a fixed UA
  // gets a refusal whenever the other client happens to mint the URL.
  const profile = CLIENTS.find((c) => c.name === client);
  const upstreamHeaders: Record<string, string> = {
    "User-Agent": profile?.userAgent ?? CLIENTS[0].userAgent,
    "Accept-Language": "en-US,en;q=0.9",
  };
  const range = request.headers.get("Range");
  if (range) upstreamHeaders.Range = range;

  const upstream = await fetch(viaProxy(fmt.url, mediaProxyBase(env)), {
    headers: upstreamHeaders,
  });
  if (!upstream.ok && upstream.status !== 206) {
    // googlevideo signs the minting IP into the URL (it appears in `sparams`),
    // so a 403 usually means the egress IP moved between minting the URL and
    // fetching it. Report both so that is visible rather than guessed at.
    let diagnostic = `HTTP ${upstream.status}`;
    try {
      const signedIp = new URL(fmt.url).searchParams.get("ip") ?? "?";
      const egress = await fetch("https://api.ipify.org?format=json")
        .then((r) => r.json() as Promise<{ ip?: string }>)
        .then((j) => j.ip ?? "?")
        .catch(() => "?");
      diagnostic += ` | client=${client} | urlIp=${signedIp} | egressIp=${egress}`;
    } catch {
      // Diagnostics are best-effort.
    }
    throw new ExtractionError("The media host refused the download.", 502, diagnostic);
  }

  const headers = new Headers();
  headers.set("Content-Type", mime);
  headers.set(
    "Content-Disposition",
    contentDisposition(safeFilename(title, ext), !!opts.inline),
  );
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "no-store");
  for (const h of ["Content-Length", "Content-Range"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Lets the in-browser muxer read total size for its progress bar.
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");

  return new Response(upstream.body, { status: upstream.status, headers });
}
