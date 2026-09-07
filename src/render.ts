/**
 * Server-side rendering.
 *
 * Every page is rendered to real HTML here rather than being filled in by JS
 * on the client. Googlebot will execute JS, but it does so on a second pass
 * that can lag by days and is skipped for low-priority pages entirely — and
 * every other crawler (Bing, social unfurlers, LLM fetchers) sees only the
 * markup we ship. So the grid, the video metadata and the quality table are
 * all in the initial response, and app.js only enhances what is already there.
 */

import type { FeedItem } from "./search";
import type { UiFormat } from "./formats";
import { CATEGORIES } from "./search";

export const SITE_NAME = "GrabTube";
export const SITE_TAGLINE = "YouTube Video & Audio Downloader";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON embedded in a <script> must not be able to close the tag. */
function safeJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/ /g, "\\u2028")
    .replace(/ /g, "\\u2029");
}

/** Seconds -> ISO 8601 duration, which is what schema.org expects. */
export function isoDuration(seconds?: number): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s ? `${s}S` : ""}`;
}

export interface LayoutOptions {
  title: string;
  description: string;
  canonical: string;
  origin: string;
  body: string;
  activeNav?: string;
  ogImage?: string;
  ogType?: string;
  jsonLd?: unknown[];
  initial?: unknown;
  /** Keeps thin or duplicative pages (search results) out of the index. */
  noindex?: boolean;
  searchValue?: string;
}

function navHtml(active?: string): string {
  const items = CATEGORIES.map(
    (c) => `<a class="side-item${active === c.id ? " active" : ""}" href="/category/${c.id}">
      <span>${esc(c.label)}</span></a>`,
  ).join("");
  return `
    <a class="side-item${!active ? " active" : ""}" href="/"><span>Home</span></a>
    <div class="side-sep"></div>
    ${items}
    <div class="side-sep"></div>
    <a class="side-item" href="/how-to-download"><span>How it works</span></a>
    <a class="side-item" href="/faq"><span>FAQ</span></a>
    <p class="side-note">Download content you own or that is licensed for reuse. Respect copyright and YouTube's Terms of Service.</p>`;
}

function chipsHtml(active?: string): string {
  const chips = [
    `<a class="chip${!active ? " active" : ""}" href="/">All</a>`,
    ...CATEGORIES.map(
      (c) =>
        `<a class="chip${active === c.id ? " active" : ""}" href="/category/${c.id}">${esc(c.label)}</a>`,
    ),
  ];
  return `<nav class="chips" aria-label="Categories">${chips.join("")}</nav>`;
}

export function layout(o: LayoutOptions): string {
  const ogImage = o.ogImage ?? `${o.origin}/og.png`;
  const jsonLd = (o.jsonLd ?? [])
    .map((b) => `<script type="application/ld+json">${safeJson(b)}</script>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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
    <span class="brand-text">Grab<span>Tube</span></span>
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
    <button class="icon-btn" id="drawerClose" aria-label="Close">
      <svg viewBox="0 0 24 24"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
    </button>
  </div>
  <div class="drawer-body" id="drawerBody"><p class="empty">Nothing downloading yet.</p></div>
</aside>

<div class="toast-stack" id="toasts"></div>

<script>window.__INITIAL__=${safeJson(o.initial ?? {})};</script>
<script src="/app.js" defer></script>
</body>
</html>`;
}

const DL_ICON = `<svg viewBox="0 0 24 24"><path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-5.7 1.4-1.4L12 13.6V3zM5 19h14v2H5z"/></svg>`;

export function cardHtml(v: FeedItem, eager = false): string {
  const dur = v.live
    ? `<span class="dur live">LIVE</span>`
    : v.duration
      ? `<span class="dur">${esc(v.duration)}</span>`
      : "";
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

export function gridHtml(items: FeedItem[]): string {
  if (!items.length) {
    return `<div class="state"><h2>Nothing to show</h2><p>YouTube returned no results for this request. Try a different search or category.</p></div>`;
  }
  return `<div class="grid" id="grid">${items.map((v, i) => cardHtml(v, i < 4)).join("")}</div>`;
}

/** The quality table, rendered server-side so it is indexable content. */
export function formatTableHtml(
  videoId: string,
  title: string,
  video: UiFormat[],
  audio: UiFormat[],
): string {
  const row = (f: UiFormat) => {
    const direct = !f.needsMux;
    const pill = direct
      ? `<span class="pill direct">Direct</span>`
      : `<span class="pill merge">Merge</span>`;
    const detail = direct
      ? `${f.ext.toUpperCase()} &middot; ${f.codec}${f.kind === "progressive" ? " &middot; with audio" : ""}`
      : `${f.ext.toUpperCase()} &middot; ${f.codec} &middot; merged with best audio in your browser`;
    return `<button class="fmt" data-itag="${f.itag}" data-kind="${f.kind}"
      data-mux="${f.needsMux ? 1 : 0}" data-audio-itag="${f.muxAudioItag ?? ""}"
      data-label="${esc(f.label)}" data-ext="${esc(f.ext)}">
      <span class="fmt-q">${esc(f.label)}</span>
      <span class="fmt-info"><b>${esc(detail)}</b>${f.sizeText ? esc(f.sizeText) : ""}</span>
      ${pill}
    </button>`;
  };

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
