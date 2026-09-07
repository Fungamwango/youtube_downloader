/**
 * Browse + search, so the app has a YouTube-like feed instead of a bare URL box.
 *
 * The WEB client is used here (unlike the player, which needs a mobile client):
 * search/browse responses are plain metadata with no signed stream URLs, so the
 * WEB context is fine and returns the richest result cards.
 */

import { proxied } from "./innertube";

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const WEB_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20250312.04.00",
  hl: "en",
  gl: "US",
};
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/** Search filter: type=video. Keeps channels/playlists out of the grid. */
const FILTER_VIDEOS_ONLY = "EgIQAQ%3D%3D";

export interface FeedItem {
  id: string;
  title: string;
  channel: string;
  channelId?: string;
  duration?: string;
  durationSeconds?: number;
  views?: string;
  published?: string;
  thumbnail: string;
  live: boolean;
}

interface AnyObj {
  [k: string]: unknown;
}

function runsText(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as AnyObj;
  if (typeof n.simpleText === "string") return n.simpleText;
  if (Array.isArray(n.runs)) {
    return (n.runs as AnyObj[])
      .map((r) => (typeof r.text === "string" ? r.text : ""))
      .join("");
  }
  return undefined;
}

function parseDuration(text?: string): number | undefined {
  if (!text) return undefined;
  const parts = text.split(":").map((p) => Number(p.trim()));
  if (parts.some((p) => Number.isNaN(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/**
 * InnerTube nests result cards differently per surface and reshuffles the
 * wrapper keys often, so rather than walking a fixed path we collect every
 * video renderer anywhere in the tree. This survives layout changes.
 */
function collectRenderers(node: unknown, out: AnyObj[], depth = 0): void {
  if (depth > 30 || !node) return;
  if (Array.isArray(node)) {
    for (const v of node) collectRenderers(v, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const n = node as AnyObj;
  for (const key of ["videoRenderer", "compactVideoRenderer", "gridVideoRenderer"]) {
    const r = n[key];
    if (r && typeof r === "object" && typeof (r as AnyObj).videoId === "string") {
      out.push(r as AnyObj);
    }
  }
  for (const v of Object.values(n)) collectRenderers(v, out, depth + 1);
}

function toFeedItem(r: AnyObj): FeedItem | null {
  const id = r.videoId as string;
  if (!id || !/^[\w-]{11}$/.test(id)) return null;

  const title = runsText(r.title);
  if (!title) return null;

  const thumbs = ((r.thumbnail as AnyObj)?.thumbnails as AnyObj[]) ?? [];
  // Ignore YouTube's own thumbnail URLs in favour of the stable i.ytimg path:
  // the returned ones carry short-lived params and 403 once they expire.
  const thumbnail = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  const badges = JSON.stringify(r.badges ?? "") + JSON.stringify(r.thumbnailOverlays ?? "");
  const live = /LIVE|isLiveNow/i.test(badges);

  const duration =
    runsText(r.lengthText) ??
    (typeof r.lengthSeconds === "string" ? undefined : undefined);

  return {
    id,
    title,
    channel:
      runsText(r.ownerText) ??
      runsText(r.longBylineText) ??
      runsText(r.shortBylineText) ??
      "Unknown",
    channelId: (
      ((r.ownerText as AnyObj)?.runs as AnyObj[])?.[0]?.navigationEndpoint as AnyObj
    )?.browseEndpoint
      ? ((((r.ownerText as AnyObj).runs as AnyObj[])[0].navigationEndpoint as AnyObj)
          .browseEndpoint as AnyObj).browseId as string
      : undefined,
    duration,
    durationSeconds: parseDuration(duration),
    views: runsText(r.viewCountText) ?? runsText(r.shortViewCountText),
    published: runsText(r.publishedTimeText),
    thumbnail,
    live: live && !duration,
  };
}

async function innertube(
  endpoint: string,
  payload: Record<string, unknown>,
  env: { YT_PROXY_URL?: string },
): Promise<unknown> {
  const res = await fetch(
    proxied(
      `https://www.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_KEY}&prettyPrint=false`,
      env,
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": WEB_UA,
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": WEB_CLIENT.clientVersion,
        Origin: "https://www.youtube.com",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: JSON.stringify({ context: { client: WEB_CLIENT }, ...payload }),
    },
  );
  if (!res.ok) throw new Error(`InnerTube ${endpoint} failed: HTTP ${res.status}`);
  return res.json();
}

function parseResults(data: unknown, limit: number, excludeLive?: boolean): FeedItem[] {
  const raw: AnyObj[] = [];
  collectRenderers(data, raw);

  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const r of raw) {
    const item = toFeedItem(r);
    if (!item || seen.has(item.id)) continue;
    // Live and upcoming streams have no duration. They dominate results for
    // broad queries like "news" or "gaming", and they cannot be downloaded
    // anyway (the player returns an HLS manifest, not fixed streams), so the
    // browse feeds drop them. Explicit searches keep them.
    if (excludeLive && (item.live || !item.duration)) continue;
    seen.add(item.id);
    items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * YouTube intermittently answers searches from Cloudflare's ranges with a
 * well-formed but result-free payload — a soft bot check rather than an error,
 * so there is nothing to catch. Measured at roughly one request in three, and
 * the same query succeeds on an immediate retry, so retrying is what makes the
 * feed dependable.
 */
export async function search(
  query: string,
  env: { YT_PROXY_URL?: string },
  limit = 30,
  opts?: { excludeLive?: boolean },
): Promise<FeedItem[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await innertube("search", { query, params: FILTER_VIDEOS_ONLY }, env);
      const items = parseResults(data, limit, opts?.excludeLive);
      if (items.length) return items;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
  }
  if (lastErr) throw lastErr;
  return [];
}

/**
 * The home grid. YouTube's FEtrending browse id now rejects anonymous WEB
 * requests, so each "category" is a curated search instead — same grid, and it
 * keeps working when the browse surface changes.
 */
export const CATEGORIES: { id: string; label: string; query: string }[] = [
  // Queries lean towards produced, finished uploads. Broad terms like "news"
  // or "gaming" return mostly 24/7 live channels, which are filtered out and
  // would otherwise leave the grid nearly empty.
  { id: "trending", label: "Trending", query: "most viewed videos this week" },
  { id: "music", label: "Music", query: "official music video 2026" },
  { id: "gaming", label: "Gaming", query: "gameplay walkthrough 2026" },
  { id: "movies", label: "Movies", query: "official movie trailer 2026" },
  { id: "news", label: "News", query: "news recap this week" },
  { id: "sports", label: "Sports", query: "match highlights 2026" },
  { id: "learning", label: "Learning", query: "documentary explained" },
  { id: "podcasts", label: "Podcasts", query: "podcast full episode" },
];

/**
 * Category feed, with a last-known-good fallback.
 *
 * Even with retries a search can come back empty, and an empty home page looks
 * broken. Successful feeds are stashed in the edge cache and replayed when a
 * later fetch yields nothing, so visitors always see a populated grid.
 */
export async function feed(
  categoryId: string,
  env: { YT_PROXY_URL?: string },
): Promise<FeedItem[]> {
  const cat = CATEGORIES.find((c) => c.id === categoryId) ?? CATEGORIES[0];
  const cacheKey = new Request(`https://feed.sagetube.internal/${cat.id}`);
  const cache = caches.default;

  let items: FeedItem[] = [];
  try {
    items = await search(cat.query, env, 30, { excludeLive: true });
  } catch {
    items = [];
  }

  if (items.length) {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(items), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "max-age=1800",
        },
      }),
    );
    return items;
  }

  const stale = await cache.match(cacheKey);
  if (stale) return (await stale.json()) as FeedItem[];
  return [];
}
