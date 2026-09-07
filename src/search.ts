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

export interface SearchResult {
  items: FeedItem[];
  /** Opaque token that fetches the next page. Absent when there is no more. */
  continuation?: string;
}

/**
 * Pulls the "load more" token out of a response. Like the result cards, it sits
 * at a path that InnerTube reshuffles, so it is located by walking the tree
 * rather than by a fixed path.
 */
function findContinuation(node: unknown, depth = 0): string | undefined {
  if (depth > 30 || !node) return undefined;
  if (Array.isArray(node)) {
    for (const v of node) {
      const t = findContinuation(v, depth + 1);
      if (t) return t;
    }
    return undefined;
  }
  if (typeof node !== "object") return undefined;
  const n = node as AnyObj;
  const cc = n.continuationCommand as AnyObj | undefined;
  if (cc && typeof cc.token === "string") return cc.token;
  for (const v of Object.values(n)) {
    const t = findContinuation(v, depth + 1);
    if (t) return t;
  }
  return undefined;
}

/**
 * YouTube intermittently answers searches from Cloudflare's ranges with a
 * well-formed but result-free payload — a soft bot check rather than an error,
 * so there is nothing to catch. Measured at roughly one request in three, and
 * the same query succeeds on an immediate retry, so retrying is what makes the
 * feed dependable.
 */
export async function searchFull(
  query: string,
  env: { YT_PROXY_URL?: string },
  limit = 30,
  opts?: { excludeLive?: boolean },
): Promise<SearchResult> {
  let lastErr: unknown;
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

/** Fetches the next page for a token returned by searchFull/continueSearch. */
export async function continueSearch(
  token: string,
  env: { YT_PROXY_URL?: string },
  limit = 30,
  opts?: { excludeLive?: boolean },
): Promise<SearchResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await innertube("search", { continuation: token }, env);
      const items = parseResults(data, limit, opts?.excludeLive);
      if (items.length) {
        return { items, continuation: findContinuation(data) };
      }
    } catch {
      // fall through to the retry
    }
    if (attempt < 1) await new Promise((r) => setTimeout(r, 150));
  }
  return { items: [] };
}

/** Items-only convenience wrapper for callers that do not paginate. */
export async function search(
  query: string,
  env: { YT_PROXY_URL?: string },
  limit = 30,
  opts?: { excludeLive?: boolean },
): Promise<FeedItem[]> {
  return (await searchFull(query, env, limit, opts)).items;
}

/**
 * The home grid. YouTube's FEtrending browse id now rejects anonymous WEB
 * requests, so each "category" is a curated search instead — same grid, and it
 * keeps working when the browse surface changes.
 */
/**
 * Each category holds several queries rather than one. A single fixed query
 * returns the same ranked list every time, which made the home page look
 * frozen; rotating the query and shuffling the results gives the changing feed
 * people expect from a browse page.
 */
export const CATEGORIES: { id: string; label: string; queries: string[] }[] = [
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
      "best videos this week",
    ],
  },
  {
    id: "music",
    label: "Music",
    queries: [
      "official music video 2026",
      "new songs 2026",
      "top hits this month",
      "official audio new release",
      "live performance 2026",
    ],
  },
  {
    id: "gaming",
    label: "Gaming",
    queries: [
      "gameplay walkthrough 2026",
      "gaming moments compilation",
      "new game review 2026",
      "speedrun world record",
      "best gaming clips",
    ],
  },
  {
    id: "movies",
    label: "Movies",
    queries: [
      "official movie trailer 2026",
      "new film trailer",
      "movie clips scenes",
      "behind the scenes film",
      "short film award winning",
    ],
  },
  {
    id: "news",
    label: "News",
    queries: [
      "news recap this week",
      "world news explained",
      "top stories this month",
      "news analysis 2026",
      "weekly news roundup",
    ],
  },
  {
    id: "sports",
    label: "Sports",
    queries: [
      "match highlights 2026",
      "best goals compilation",
      "sports top plays",
      "championship highlights",
      "greatest moments sport",
    ],
  },
  {
    id: "learning",
    label: "Learning",
    queries: [
      "documentary explained",
      "how it works explained",
      "science documentary 2026",
      "history documentary",
      "tutorial for beginners",
    ],
  },
  {
    id: "podcasts",
    label: "Podcasts",
    queries: [
      "podcast full episode",
      "interview podcast 2026",
      "best podcast moments",
      "long form interview",
      "podcast highlights",
    ],
  },
];

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Category feed: a random query from the category, results shuffled, and a
 * continuation token so the grid can keep loading as the visitor scrolls.
 *
 * Even with retries a search can come back empty, and an empty home page looks
 * broken, so successful feeds are stashed in the edge cache and replayed when a
 * later fetch yields nothing.
 */
export async function feed(
  categoryId: string,
  env: { YT_PROXY_URL?: string },
): Promise<SearchResult> {
  const cat = CATEGORIES.find((c) => c.id === categoryId) ?? CATEGORIES[0];
  const cacheKey = new Request(`https://feed.sagetube.internal/${cat.id}`);
  const cache = caches.default;
  const query = cat.queries[Math.floor(Math.random() * cat.queries.length)];

  let result: SearchResult = { items: [] };
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
            "Cache-Control": "max-age=1800",
          },
        }),
      );
    } catch {
      // Caching is best-effort.
    }
    return out;
  }

  const stale = await cache.match(cacheKey);
  if (stale) {
    const cached = (await stale.json()) as SearchResult;
    // Reshuffle the fallback too, so a stale feed still looks alive.
    return { items: shuffle(cached.items ?? []), continuation: cached.continuation };
  }
  return { items: [] };
}
