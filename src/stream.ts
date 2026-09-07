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

import { fetchPlayer, ExtractionError } from "./innertube";
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
  env: { YT_PROXY_URL?: string },
): Promise<Response> {
  const { player } = await fetchPlayer(opts.videoId, env);
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
  const upstreamHeaders: Record<string, string> = {
    "User-Agent":
      "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en_US; Quest 3) gzip",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const range = request.headers.get("Range");
  if (range) upstreamHeaders.Range = range;

  const upstream = await fetch(fmt.url, { headers: upstreamHeaders });
  if (!upstream.ok && upstream.status !== 206) {
    throw new ExtractionError(
      "The media host refused the download.",
      502,
      `HTTP ${upstream.status}`,
    );
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
