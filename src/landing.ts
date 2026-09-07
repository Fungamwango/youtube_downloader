/**
 * Keyword landing pages.
 *
 * The home and watch pages cannot rank for the queries that actually carry
 * search volume ("youtube to mp3", "4k video downloader", ...) because a single
 * page can only target one intent. Each entry below is a distinct page with its
 * own title, H1, copy and schema, cross-linked to the others so the set builds
 * internal link equity instead of competing with itself.
 *
 * Every page carries the working converter box, so the traffic lands on
 * something usable rather than a doorway page — which is also what keeps this
 * inside Google's guidelines rather than tripping the doorway-page filter.
 */

export interface LandingPage {
  slug: string;
  /** <title> */
  title: string;
  h1: string;
  description: string;
  intro: string;
  sections: { h2: string; body: string }[];
  faq: { q: string; a: string }[];
}

export const LANDING_PAGES: LandingPage[] = [
  {
    slug: "youtube-to-mp3",
    title: "YouTube to MP3 Converter - Free, No Sign-Up",
    h1: "YouTube to MP3 converter",
    description:
      "Convert any YouTube video to MP3 at 192 kbps, or grab the original M4A audio. Runs in your browser, no software and no account.",
    intro:
      "Paste a YouTube link below to pull the audio out of any video. You can take the untouched AAC (M4A) track straight from YouTube, or convert it to MP3 for players that need the older format. The conversion runs inside your browser, so the file never touches a server.",
    sections: [
      {
        h2: "M4A or MP3 - which should you pick?",
        body: "M4A is the audio YouTube actually stores, so downloading it is a straight copy with nothing lost and nothing re-encoded. MP3 has to be converted from that track, which costs a little quality but plays on virtually every device, car stereo and DJ program ever made. If your player supports M4A, take it. Otherwise take MP3 at 192 kbps.",
      },
      {
        h2: "Why the audio quality tops out around 128 kbps",
        body: "YouTube does not store a lossless master for public playback. The best audio stream it serves is roughly 128 kbps AAC, so that is the ceiling for any downloader, including this one. A tool promising 320 kbps MP3 from YouTube is upscaling a 128 kbps source, which adds file size without adding detail.",
      },
      {
        h2: "Good for podcasts, lectures and mixes",
        body: "Audio-only downloads are a fraction of the size of the video. A two-hour podcast is a few dozen megabytes as M4A instead of a gigabyte or more as 1080p, which makes it practical to keep offline on a phone.",
      },
    ],
    faq: [
      {
        q: "Does converting to MP3 reduce the quality?",
        a: "Slightly, because it re-encodes an already compressed track. Choose M4A instead if your device supports it - that download is a bit-for-bit copy.",
      },
      {
        q: "Is there a length limit?",
        a: "No fixed limit. Very long files use more browser memory during MP3 conversion, so for multi-hour recordings the direct M4A download is more reliable.",
      },
    ],
  },
  {
    slug: "youtube-to-mp4",
    title: "YouTube to MP4 Downloader - 1080p, 720p, 480p",
    h1: "YouTube to MP4 downloader",
    description:
      "Download YouTube videos as MP4 in 480p, 720p or 1080p. No watermark, no sign-up, nothing installed.",
    intro:
      "Save any YouTube video as a standard MP4 that plays on phones, TVs and every editor. Pick the resolution you want and the file downloads straight to your device.",
    sections: [
      {
        h2: "Which resolution should you choose?",
        body: "720p is the practical default: it looks sharp on a phone or tablet and keeps files small enough to share over messaging apps. Choose 1080p when the video will be viewed on a laptop or TV, or when you plan to edit it. Below 480p the file gets noticeably soft on any modern screen.",
      },
      {
        h2: "Why higher resolutions take an extra step",
        body: "YouTube only publishes one ready-made file that already contains both picture and sound, and it is 360p. Every resolution above that arrives as a separate video track and audio track. This site downloads both and joins them in your browser before saving. The streams are copied rather than re-encoded, so the result is identical in quality to the source and the join takes seconds rather than minutes.",
      },
      {
        h2: "H.264 for maximum compatibility",
        body: "Where YouTube offers a choice of codecs, the H.264 version is preferred here. It is the format Premiere, Final Cut, DaVinci Resolve, PowerPoint and older TVs all understand. VP9 and AV1 are more efficient but far pickier about where they will play.",
      },
    ],
    faq: [
      {
        q: "Will the MP4 have a watermark?",
        a: "No. The file is exactly what YouTube serves, with nothing overlaid or appended.",
      },
      {
        q: "Can I open the file in a video editor?",
        a: "Yes. MP4 files using H.264 video and AAC audio import into every mainstream editor without conversion.",
      },
    ],
  },
  {
    slug: "4k-video-downloader",
    title: "4K Video Downloader - Save YouTube in 2160p",
    h1: "4K video downloader",
    description:
      "Download YouTube videos in 4K (2160p) and 1440p, straight from your browser. No desktop app required.",
    intro:
      "When a video is published in 4K, this page will save it at full 2160p resolution. Pick the quality you want and the video and audio tracks are fetched and joined locally.",
    sections: [
      {
        h2: "Check that the source is really 4K",
        body: "A downloader cannot add detail that was never uploaded. If 2160p does not appear in the quality list, the creator did not publish a 4K version, and the highest entry shown is genuinely the best available. Upscaled 1080p offered as 4K elsewhere is just a bigger file of the same picture.",
      },
      {
        h2: "Expect large files and a real merge step",
        body: "A few minutes of 2160p can run to several hundred megabytes, and 4K on YouTube is usually VP9 or AV1 rather than H.264. Both tracks are downloaded in full and merged in your browser, which needs enough free memory to hold them. On a machine with limited RAM, 1440p is a far lighter download that still looks excellent on most displays.",
      },
      {
        h2: "1440p is the underrated option",
        body: "1440p carries most of the visible benefit of 4K at roughly a third of the file size, and it is far quicker to merge. Unless you are viewing on a genuine 4K panel, it is usually the better trade.",
      },
    ],
    faq: [
      {
        q: "Why is 4K slower than 1080p?",
        a: "The file is several times larger, so both the download and the merge take proportionally longer. Nothing is being re-encoded - it is simply more data.",
      },
      {
        q: "My browser ran out of memory on a 4K video.",
        a: "The merge holds both tracks in memory. Close other tabs and retry, or choose 1440p, which needs far less.",
      },
    ],
  },
  {
    slug: "youtube-shorts-downloader",
    title: "YouTube Shorts Downloader - Save Shorts as MP4",
    h1: "YouTube Shorts downloader",
    description:
      "Download YouTube Shorts as MP4 without a watermark. Paste the Shorts link and save it in seconds.",
    intro:
      "Shorts links work exactly like any other YouTube URL here. Paste a /shorts/ address and it resolves to the video, with the full set of qualities available.",
    sections: [
      {
        h2: "Shorts are small and quick",
        body: "A Short is a minute or less, so even the highest quality is a small file and the merge for HD finishes almost instantly. Vertical video keeps its original 9:16 framing - nothing is cropped, padded or re-scaled.",
      },
      {
        h2: "No watermark added",
        body: "The saved file is the stream YouTube serves, so there is no overlay from this site. Note that if the creator uploaded a clip that already carried a watermark from another platform, that mark is part of the video itself and cannot be removed by any downloader.",
      },
    ],
    faq: [
      {
        q: "Do Shorts URLs work directly?",
        a: "Yes. Paste the /shorts/ link into the search box and it opens the video's download page automatically.",
      },
    ],
  },
];

export function findLanding(slug: string): LandingPage | undefined {
  return LANDING_PAGES.find((p) => p.slug === slug);
}
