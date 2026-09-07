/**
 * Worker entrypoint: server-rendered pages + JSON API + SEO surfaces.
 *
 * Static files (styles.css, app.js) are served by Cloudflare's asset layer
 * before this runs. Everything else lands here so pages can be rendered with
 * real metadata instead of an empty SPA shell.
 */

import { fetchPlayer, parseVideoId, ExtractionError } from "./innertube";
import { extractFormats } from "./formats";
import { streamFormat } from "./stream";
import { search, feed, CATEGORIES } from "./search";
import {
  layout,
  gridHtml,
  cardHtml,
  formatTableHtml,
  esc,
  isoDuration,
  SITE_NAME,
  SITE_TAGLINE,
} from "./render";

export interface Env {
  ASSETS: Fetcher;
  YT_PROXY_URL?: string;
}

/* ------------------------------------------------------------------ utils */

const json = (data: unknown, status = 200, maxAge = 300) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
    },
  });

const html = (body: string, status = 200, maxAge = 600) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control":
        status === 200 ? `public, max-age=${maxAge}, s-maxage=${maxAge}` : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });

function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/* ------------------------------------------------------------------ pages */

async function homePage(origin: string, env: Env, categoryId?: string) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  const items = await feed(cat?.id ?? "trending", env).catch(() => []);

  const heading = cat
    ? `${cat.label} videos to download`
    : `Download YouTube videos in MP4 and MP3`;
  const intro = cat
    ? `Browse ${cat.label.toLowerCase()} videos and save any of them as MP4 video or M4A/MP3 audio, in the quality you choose.`
    : `Search YouTube, preview any video, and download it as MP4 up to 4K or extract the audio as MP3. No app to install, no account, nothing uploaded to a server.`;

  const canonical = cat ? `${origin}/category/${cat.id}` : `${origin}/`;

  const body = `
    <div class="page-head">
      <h1>${esc(heading)}</h1>
      <p>${esc(intro)}</p>
    </div>
    ${gridHtml(items)}
    ${cat ? "" : homeSeoProse()}`;

  return html(
    layout({
      title: cat
        ? `${cat.label} Videos - Download MP4 & MP3 | ${SITE_NAME}`
        : `${SITE_NAME} - ${SITE_TAGLINE} (MP4, 1080p, 4K, MP3)`,
      description: intro,
      canonical,
      origin,
      activeNav: cat?.id,
      initial: { page: cat ? "category" : "home", category: cat?.id ?? null, items },
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
              urlTemplate: `${origin}/search?q={search_term_string}`,
            },
            "query-input": "required name=search_term_string",
          },
        },
        {
          "@context": "https://schema.org",
          "@type": "WebApplication",
          name: SITE_NAME,
          url: `${origin}/`,
          applicationCategory: "MultimediaApplication",
          operatingSystem: "Any (web browser)",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        },
      ],
    }),
  );
}

function homeSeoProse(): string {
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

async function watchPage(videoId: string, origin: string, env: Env) {
  const { player } = await fetchPlayer(videoId, env);
  const { video, audio } = extractFormats(player);
  const d = player.videoDetails;

  const title = d?.title ?? "Untitled";
  const channel = d?.author ?? "Unknown";
  const seconds = Number(d?.lengthSeconds ?? 0);
  const description = (d?.shortDescription ?? "").slice(0, 5000);
  const views = d?.viewCount ? Number(d.viewCount).toLocaleString("en-US") : undefined;
  const thumb = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  const canonical = `${origin}/watch/${videoId}`;

  const best = video[0]?.label ?? "HD";
  const metaDesc =
    `Download "${title}" by ${channel} as MP4 up to ${best}, or extract the audio as MP3. ` +
    `Free, no sign-up, straight from your browser.`;

  // Related videos come from a title search; failure here must not break the
  // page, so it degrades to an empty rail.
  const relatedItems = await search(
    title.split(/\s+/).slice(0, 6).join(" "),
    env,
    12,
  ).catch(() => []);
  const related = relatedItems.filter((r) => r.id !== videoId).slice(0, 8);

  const body = `
  <div class="watch">
    <div>
      <iframe class="player" src="https://www.youtube-nocookie.com/embed/${esc(videoId)}"
        title="${esc(title)}" loading="lazy" allowfullscreen
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"></iframe>
      <h1>${esc(title)}</h1>
      <p class="watch-meta">${esc(channel)}${views ? ` &middot; ${esc(views)} views` : ""}${
        seconds ? ` &middot; ${esc(fmtDuration(seconds))}` : ""
      }</p>
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
            `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          ],
          duration: isoDuration(seconds),
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
          contentUrl: `https://www.youtube.com/watch?v=${videoId}`,
          uploadDate: undefined,
          author: { "@type": "Person", name: channel },
          interactionStatistic: d?.viewCount
            ? {
                "@type": "InteractionCounter",
                interactionType: { "@type": "WatchAction" },
                userInteractionCount: Number(d.viewCount),
              }
            : undefined,
        },
        {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: `${origin}/` },
            { "@type": "ListItem", position: 2, name: title, item: canonical },
          ],
        },
      ],
    }),
  );
}

async function searchPage(q: string, origin: string, env: Env) {
  const items = q ? await search(q, env).catch(() => []) : [];
  const body = `
    <div class="page-head">
      <h1>${esc(q ? `Download videos for "${q}"` : "Search")}</h1>
      <p>${items.length} result${items.length === 1 ? "" : "s"}. Pick any video to choose a quality.</p>
    </div>
    ${gridHtml(items)}`;

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
      body,
    }),
  );
}

const FAQ = [
  {
    q: "Is GrabTube free to use?",
    a: "Yes. There is no account, no subscription and no download limit.",
  },
  {
    q: "Why does 1080p need to be merged?",
    a: "YouTube only serves a ready-made video-plus-audio file at 360p. Every higher resolution is delivered as a separate video track and audio track, so the two must be joined before the file will play with sound. GrabTube does that inside your browser.",
  },
  {
    q: "Does merging re-encode and lose quality?",
    a: "No. The tracks are stream-copied into an MP4 container, so the video and audio data are bit-for-bit identical to what YouTube served.",
  },
  {
    q: "Do my videos get uploaded to a server?",
    a: "No. The merge and any MP3 conversion run locally in your browser with WebAssembly. Nothing is stored on our side.",
  },
  {
    q: "Can I download age-restricted or private videos?",
    a: "Private videos are never accessible. Some age-restricted videos work and some do not, depending on how YouTube gates them.",
  },
  {
    q: "Is downloading YouTube videos legal?",
    a: "It depends on the content and where you live. Downloading your own uploads or openly licensed material is generally fine. Saving copyrighted content without permission may breach YouTube's Terms of Service and copyright law. Use the tool responsibly.",
  },
];

function faqPage(origin: string) {
  const body = `
    <div class="page-head"><h1>Frequently asked questions</h1>
    <p>How ${SITE_NAME} works, and what it can and cannot do.</p></div>
    <section class="seo" style="margin-top:16px;border-top:0;padding-top:0">
      ${FAQ.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join("")}
    </section>`;

  return html(
    layout({
      title: `FAQ - YouTube Downloader Questions | ${SITE_NAME}`,
      description:
        "Answers about downloading YouTube videos as MP4 or MP3: quality, merging, privacy and legality.",
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
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        },
      ],
    }),
  );
}

function howToPage(origin: string) {
  const steps = [
    { name: "Find the video", text: "Search from the bar at the top, or paste a full YouTube link." },
    { name: "Open it", text: "Select the video to open its page, or press Get on any card." },
    { name: "Pick a quality", text: "Choose an MP4 resolution from the Video tab, or an audio format from the Audio tab." },
    { name: "Save the file", text: "Direct qualities download immediately. Higher resolutions are merged in your browser first, then saved." },
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
      description:
        "Step-by-step: search or paste a YouTube link, choose a quality, and save the video as MP4 or the audio as MP3.",
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
            text: s.text,
          })),
        },
      ],
    }),
  );
}

/* ------------------------------------------------------------- SEO files */

function robots(origin: string) {
  // /api/ and /search are crawl traps: no unique content, unbounded URL space.
  return new Response(
    `User-agent: *
Allow: /$
Allow: /watch/
Allow: /category/
Disallow: /api/
Disallow: /search

Sitemap: ${origin}/sitemap.xml
`,
    { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } },
  );
}

async function sitemap(origin: string, env: Env) {
  const urls: { loc: string; priority: string; changefreq: string }[] = [
    { loc: `${origin}/`, priority: "1.0", changefreq: "hourly" },
    { loc: `${origin}/how-to-download`, priority: "0.6", changefreq: "monthly" },
    { loc: `${origin}/faq`, priority: "0.6", changefreq: "monthly" },
    ...CATEGORIES.map((c) => ({
      loc: `${origin}/category/${c.id}`,
      priority: "0.8",
      changefreq: "daily",
    })),
  ];

  // Include currently trending videos so there are real watch URLs to crawl.
  const trending = await feed("trending", env).catch(() => []);
  for (const v of trending.slice(0, 40)) {
    urls.push({ loc: `${origin}/watch/${v.id}`, priority: "0.7", changefreq: "weekly" });
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url><loc>${esc(u.loc)}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`,
  )
  .join("\n")}
</urlset>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function notFound(origin: string) {
  return html(
    layout({
      title: `Page not found | ${SITE_NAME}`,
      description: "That page does not exist.",
      canonical: `${origin}/`,
      origin,
      noindex: true,
      body: `<div class="state"><h2>Page not found</h2><p>That link does not point anywhere. <a href="/" style="color:#3ea6ff">Go back home</a>.</p></div>`,
    }),
    404,
  );
}

function errorPage(origin: string, err: unknown) {
  const message =
    err instanceof ExtractionError ? err.message : "Something went wrong loading that video.";
  const status = err instanceof ExtractionError ? err.status : 500;
  return html(
    layout({
      title: `Unavailable | ${SITE_NAME}`,
      description: message,
      canonical: `${origin}/`,
      origin,
      noindex: true,
      body: `<div class="state"><h2>Cannot load this video</h2><p>${esc(message)}</p>
        <p style="margin-top:12px"><a href="/" style="color:#3ea6ff">Back to home</a></p></div>`,
    }),
    status >= 500 ? 502 : status,
  );
}

/* ------------------------------------------------------------------ API */

async function handleInfo(url: URL, env: Env): Promise<Response> {
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
    duration: seconds ? fmtDuration(seconds) : undefined,
    views: d?.viewCount ? Number(d.viewCount).toLocaleString("en-US") : undefined,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    extractedWith: client,
    video,
    audio,
  });
}

async function handleDownload(
  url: URL,
  request: Request,
  env: Env,
  inline: boolean,
): Promise<Response> {
  const videoId = parseVideoId(url.searchParams.get("v") ?? url.searchParams.get("url") ?? "");
  const itag = Number(url.searchParams.get("itag"));
  if (!videoId || !Number.isFinite(itag)) {
    return json({ error: "Missing video id or itag." }, 400);
  }
  return streamFormat(
    { videoId, itag, inline, filename: url.searchParams.get("title") ?? undefined },
    request,
    env,
  );
}

/* ---------------------------------------------------------------- router */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    // ---- API ----
    if (path.startsWith("/api/")) {
      try {
        switch (path) {
          case "/api/categories":
            return json(CATEGORIES.map(({ id, label }) => ({ id, label })));
          case "/api/feed":
            return json({ items: await feed(url.searchParams.get("category") ?? "trending", env) });
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
        return json({ error: (err as Error).message ?? "Unexpected error" }, 500);
      }
    }

    // ---- SEO files ----
    if (path === "/robots.txt") return robots(origin);
    if (path === "/sitemap.xml") return sitemap(origin, env);

    // ---- pages ----
    try {
      if (path === "/") return await homePage(origin, env);
      if (path === "/faq") return faqPage(origin);
      if (path === "/how-to-download") return howToPage(origin);
      if (path === "/search") return await searchPage((url.searchParams.get("q") ?? "").trim(), origin, env);

      const cat = path.match(/^\/category\/([\w-]+)$/);
      if (cat) {
        if (!CATEGORIES.some((c) => c.id === cat[1])) return notFound(origin);
        return await homePage(origin, env, cat[1]);
      }

      const watch = path.match(/^\/watch\/([\w-]{11})$/);
      if (watch) return await watchPage(watch[1], origin, env);

      // Legacy/YouTube-style /watch?v=ID -> canonical path.
      if (path === "/watch") {
        const id = parseVideoId(url.searchParams.get("v") ?? "");
        if (id) return Response.redirect(`${origin}/watch/${id}`, 301);
      }

      return notFound(origin);
    } catch (err) {
      return errorPage(origin, err);
    }
  },
};
