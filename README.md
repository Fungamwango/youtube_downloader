# SageTube

A VidMate-style YouTube browser and downloader that runs entirely on Cloudflare
Workers. Browse or search YouTube, open any video, and download it as MP4 (up to
4K) or as audio (M4A / MP3).

**Live:** https://sagetube.sagetech386.workers.dev

---

## How it works

### Extraction (`src/innertube.ts`)

`yt-dlp` cannot run here — Workers are a V8 isolate with no subprocesses, no
Python, and no `eval`. So extraction talks to YouTube's InnerTube API directly.

The catch is signature ciphering: the `WEB` client receives `signatureCipher`
blobs that can only be unscrambled by executing YouTube's `player.js`, which is
impossible in an isolate. Mobile and TV clients are handed direct URLs instead.
Three are tried in order, first playable response wins:

| Client | Why it is in the list |
| --- | --- |
| `ANDROID_VR` | Primary. Un-ciphered, un-throttled URLs, no PO token required. |
| `IOS` | Fallback when ANDROID_VR is refused. |
| `TVHTML5_SIMPLY_EMBEDDED_PLAYER` | Last resort for embed/age-gated videos. |

### Formats (`src/formats.ts`)

YouTube publishes exactly **one** ready-made file containing both picture and
sound: 360p (itag 18). Everything above it is a separate video track and audio
track.

So the quality list is split into:

- **Direct** — 360p video, and all audio-only streams. Streamed straight to the
  browser with a proper filename.
- **Merge** — 480p through 4K. Both tracks are downloaded and joined in the
  browser (see below).

Formats are de-duplicated to one entry per resolution, preferring H.264 (plays
everywhere, remuxes without re-encoding). Audio collapses to distinct tiers —
YouTube ships a near-identical AAC and Opus version of each, and listing both is
noise.

### Merging (`public/app.js`)

Merging runs client-side with `ffmpeg.wasm`, loaded lazily from a CDN only when
a merge or MP3 conversion is first requested (~32 MB, one time). The merge is a
stream copy (`-c copy`), so it is fast and lossless — nothing is re-encoded, and
no media is ever stored server-side.

### Downloads (`src/stream.ts`)

`googlevideo` URLs expire in about 6 hours, so raw URLs are never handed to the
browser. Every download re-mints the URL server-side and streams it through the
Worker as a pass-through `ReadableStream` — memory stays flat whether it is a
3 MB song or a 4K video. `Range` headers are forwarded, so downloads resume and
seek.

---

## SEO

Every page is server-rendered (`src/render.ts`). Googlebot does execute JS, but
on a delayed second pass that is skipped for low-priority pages entirely, and no
other crawler runs it at all — so the grid, video metadata and quality table are
all in the initial HTML. `app.js` only enhances what is already there.

Included:

- Per-page `<title>`, meta description, canonical URL, OpenGraph + Twitter cards
- JSON-LD: `VideoObject`, `WebSite` + `SearchAction`, `WebApplication`,
  `BreadcrumbList`, `FAQPage`, `HowTo`
- Clean URLs: `/watch/<id>`, `/category/<id>`, `/youtube-to-mp3`
- `robots.txt` and a dynamic `sitemap.xml` (static pages, categories, and the
  current trending videos)
- Keyword landing pages, each with unique copy, schema and a working converter:
  `/youtube-to-mp3`, `/youtube-to-mp4`, `/4k-video-downloader`,
  `/youtube-shorts-downloader`
- Search result pages are `noindex, follow` (thin and duplicative), and `/api/`
  and `/search` are disallowed in robots.txt as crawl traps

### To actually get organic traffic

1. **Put it on a real domain.** `*.workers.dev` is a shared subdomain that Google
   treats as low-trust, and it cannot be verified as a property in Search
   Console. Add a custom domain in the Cloudflare dashboard (Workers → sagetube
   → Settings → Domains & Routes). This is the single biggest lever.
2. Verify the domain in Google Search Console and submit `/sitemap.xml`.
3. Be aware of the ceiling: Google actively demotes YouTube-downloader sites
   under sustained DMCA pressure, and the queries are dominated by established
   domains. Clean markup is necessary but is not sufficient to rank here.

---

## Development

```bash
npm install
npm run dev        # http://127.0.0.1:8787
npm run typecheck
npm run deploy
```

### Config

`wrangler.jsonc`:

- `assets` — `./public` holds only `styles.css` and `app.js`. There is
  deliberately **no `index.html`**: every HTML page is server-rendered, so
  unmatched paths must fall through to the Worker rather than be answered by the
  asset layer (`not_found_handling: "none"`).
- `YT_PROXY_URL` — optional. Base URL of an HTTP proxy for InnerTube calls, for
  if YouTube starts refusing Cloudflare's ranges. Empty means call YouTube
  directly.

### API

| Route | Purpose |
| --- | --- |
| `GET /api/info?v=<id>` | Metadata plus the video/audio format lists |
| `GET /api/search?q=` | Search results |
| `GET /api/feed?category=` | Category feed |
| `GET /api/download?v=&itag=&title=` | Stream as an attachment |
| `GET /api/stream?v=&itag=` | Same, inline — used by the in-browser merger |

---

## Known limitations

### Extraction is IP-blocked from Cloudflare (the big one)

YouTube rejects most InnerTube player requests coming from cloud hosting with
`LOGIN_REQUIRED` — "Sign in to confirm you're not a bot". Measured on the
deployed Worker, roughly **1 video in 6** succeeds. The same requests from a
residential IP succeed for every video tested.

This is not a bug that can be coded around, and it was verified rather than
assumed:

- **It is deterministic, not flaky.** Six videos × three attempts: five failed
  all three times, one succeeded all three. Retrying does not help.
- **It is not the client choice.** A matrix of 11 client contexts was tested.
  From a residential IP, `IOS` returns direct URLs for every video; `ANDROID_VR`
  for one in four; `ANDROID`, both music clients, `WEB_CREATOR`, `MWEB` and both
  embedded-player clients fail outright. The client order in `innertube.ts`
  reflects those measurements. From Cloudflare, even `IOS` is mostly refused.
- **`visitorData` does not help.** Minting a visitor token and attaching it to
  the context changed nothing.
- **Browser-side extraction is impossible.** YouTube's InnerTube endpoints
  answer cross-origin preflights with `403` and send no `Access-Control-*`
  headers, so the page cannot call them directly from the visitor's own IP.

**The fix is to make extraction leave from a non-datacenter IP**, via
`YT_PROXY_URL` (see Config). Two shapes are supported: a `{url}` template for
scraping APIs, or a reverse-proxy origin — for example a small service on a home
connection or VPS that mirrors `youtube.com` paths. Workers' `fetch()` cannot
use a classic CONNECT proxy, so a plain `host:port` proxy string will not work.

Note that search, browse, the whole UI and the download/merge pipeline are all
unaffected — only the player-metadata call is blocked.

### Other limitations

- **Intermittent empty searches.** YouTube answers roughly one search in three
  from Cloudflare's ranges with a well-formed but result-free payload — a soft
  bot check with nothing to catch. Mitigated by retrying up to 3 times, plus an
  edge-cached last-known-good feed so the home page is never empty.
- **4K merges are memory-hungry.** Both tracks are held in browser memory. A
  long 2160p video can exhaust it; 1440p is much lighter.
- **Live streams** are not downloadable (HLS manifests are not handled).
- Some age-restricted videos resolve via the TV client, some do not.

## Legal

Intended for videos you own, openly licensed material, or content you have
permission to save. Downloading copyrighted material without permission may
breach YouTube's Terms of Service and local copyright law.
