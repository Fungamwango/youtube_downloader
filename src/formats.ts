/**
 * Turns InnerTube's raw format list into something a UI can render:
 * a video list and an audio list, each sorted best-first and de-duplicated
 * so the user sees "1080p" once rather than the four codec variants of it.
 */

import type { RawFormat, PlayerResponse } from "./innertube";

export type FormatKind = "progressive" | "video" | "audio";

export interface UiFormat {
  itag: number;
  kind: FormatKind;
  /** "1080p", "720p60", "128 kbps" */
  label: string;
  ext: string;
  codec: string;
  height?: number;
  fps?: number;
  abr?: number;
  bitrate?: number;
  sizeBytes?: number;
  sizeText?: string;
  /** true when the stream has no audio track and must be merged to be useful */
  needsMux: boolean;
  /** itag of the audio track we'd merge with, when needsMux */
  muxAudioItag?: number;
}

const CODEC_RE = /codecs="([^"]+)"/;

function parseMime(mime = ""): { type: string; ext: string; codecs: string[] } {
  const type = mime.split("/")[0] || "";
  const sub = (mime.split("/")[1] || "").split(";")[0] || "";
  const codecs = (mime.match(CODEC_RE)?.[1] ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  // webm audio is opus; mp4 audio is m4a — use the extension people expect.
  let ext = sub;
  if (type === "audio") ext = sub === "mp4" ? "m4a" : sub;
  return { type, ext, codecs };
}

function codecFamily(codecs: string[]): string {
  const c = codecs.join(" ");
  if (/av01/.test(c)) return "AV1";
  if (/vp9|vp09/.test(c)) return "VP9";
  if (/avc1/.test(c)) return "H.264";
  if (/opus/.test(c)) return "Opus";
  if (/mp4a/.test(c)) return "AAC";
  return codecs[0] ?? "";
}

export function humanSize(bytes?: number): string | undefined {
  if (!bytes || bytes <= 0) return undefined;
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Codec preference for picking the single best variant of a given resolution.
 * H.264 wins deliberately: it is the only one that plays everywhere and that
 * ffmpeg.wasm can remux without re-encoding.
 */
function codecScore(family: string): number {
  return { "H.264": 3, VP9: 2, AV1: 1 }[family] ?? 0;
}

function audioScore(family: string): number {
  return { AAC: 2, Opus: 1 }[family] ?? 0;
}

export interface ExtractedFormats {
  video: UiFormat[];
  audio: UiFormat[];
}

export function extractFormats(player: PlayerResponse): ExtractedFormats {
  const sd = player.streamingData;
  const progressive = (sd?.formats ?? []).filter((f) => f.url);
  const adaptive = (sd?.adaptiveFormats ?? []).filter((f) => f.url);

  const toUi = (f: RawFormat, kind: FormatKind): UiFormat | null => {
    const { type, ext, codecs } = parseMime(f.mimeType);
    const size = f.contentLength ? Number(f.contentLength) : undefined;
    const bitrate = f.averageBitrate ?? f.bitrate;

    if (kind === "audio" || (type === "audio" && kind !== "progressive")) {
      const abr = bitrate ? Math.round(bitrate / 1000) : undefined;
      return {
        itag: f.itag,
        kind: "audio",
        label: abr ? `${abr} kbps` : (f.audioQuality ?? "audio"),
        ext,
        codec: codecFamily(codecs),
        abr,
        bitrate,
        sizeBytes: size,
        sizeText: humanSize(size),
        needsMux: false,
      };
    }

    const height = f.height;
    if (!height) return null;
    const fps = f.fps && f.fps > 30 ? f.fps : undefined;
    return {
      itag: f.itag,
      kind,
      label: `${height}p${fps ?? ""}`,
      ext: ext === "webm" ? "webm" : "mp4",
      codec: codecFamily(codecs),
      height,
      fps: f.fps,
      bitrate,
      sizeBytes: size,
      sizeText: humanSize(size),
      needsMux: kind === "video",
    };
  };

  const audio: UiFormat[] = [];
  for (const f of adaptive) {
    if (!f.mimeType?.startsWith("audio/")) continue;
    const ui = toUi(f, "audio");
    if (ui) audio.push(ui);
  }
  // Best audio first, preferring AAC so the common case needs no transcode.
  audio.sort(
    (a, b) =>
      audioScore(b.codec) - audioScore(a.codec) || (b.abr ?? 0) - (a.abr ?? 0),
  );
  const bestAudioItag = audio[0]?.itag;

  const candidates: UiFormat[] = [];
  for (const f of progressive) {
    const ui = toUi(f, "progressive");
    if (ui) candidates.push(ui);
  }
  for (const f of adaptive) {
    if (!f.mimeType?.startsWith("video/")) continue;
    const ui = toUi(f, "video");
    if (ui) {
      ui.muxAudioItag = bestAudioItag;
      candidates.push(ui);
    }
  }

  // Collapse to one entry per resolution: a progressive stream always wins
  // (it needs no merge at all), otherwise the friendliest codec wins.
  const byLabel = new Map<string, UiFormat>();
  for (const c of candidates) {
    const prev = byLabel.get(c.label);
    if (!prev) {
      byLabel.set(c.label, c);
      continue;
    }
    const better =
      (c.kind === "progressive" ? 10 : 0) + codecScore(c.codec) >
      (prev.kind === "progressive" ? 10 : 0) + codecScore(prev.codec);
    if (better) byLabel.set(c.label, c);
  }

  const video = [...byLabel.values()].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0),
  );

  // De-dupe audio down to distinct bitrates, keeping the best codec of each.
  const seenAbr = new Set<number>();
  const audioOut = audio.filter((a) => {
    const key = a.abr ?? 0;
    if (seenAbr.has(key)) return false;
    seenAbr.add(key);
    return true;
  });

  return { video, audio: audioOut };
}

/** Finds a format's fresh URL by itag in a player response. */
export function findFormatUrl(
  player: PlayerResponse,
  itag: number,
): RawFormat | undefined {
  const sd = player.streamingData;
  return [...(sd?.formats ?? []), ...(sd?.adaptiveFormats ?? [])].find(
    (f) => f.itag === itag && f.url,
  );
}
