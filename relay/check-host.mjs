#!/usr/bin/env node
/**
 * Pre-flight check for a candidate relay host.
 *
 * Run this ON the machine you are considering, BEFORE wiring anything up. It
 * answers the only two questions that matter, in about ten seconds:
 *
 *   1. Will Google serve this IP at all?  (Render's free tier fails here —
 *      it answers the InnerTube call with a "Sorry..." abuse page.)
 *   2. Can this IP download the media URL it just minted?  (googlevideo signs
 *      the minting IP into the URL, so both halves must agree.)
 *
 * A host has to pass BOTH. Passing 1 and failing 2 means something between the
 * two calls is changing your outbound address.
 *
 * Usage, on the candidate host:
 *   node check-host.mjs
 *   docker run --rm -v "$PWD:/w" -w /w node:22-alpine node check-host.mjs
 *
 * Requires Node 18+. No dependencies, writes nothing, downloads only 4 KB.
 */

const KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const UA =
  "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X; en_US)";

// Two videos: one ordinary, one carrying the stricter `pcm2` protection that
// enforces the IP binding hardest. A host that manages both is safe.
const VIDEOS = ["dQw4w9WgXcQ", "9bZkp7q19f0"];

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

async function publicIp() {
  for (const url of ["https://api64.ipify.org?format=json", "https://ifconfig.co/json"]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.ip) return j.ip;
    } catch {
      /* try the next one */
    }
  }
  return "unknown";
}

async function mint(videoId) {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        "X-YouTube-Client-Name": "5",
        "X-YouTube-Client-Version": "20.10.4",
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "IOS",
            clientVersion: "20.10.4",
            deviceMake: "Apple",
            deviceModel: "iPhone16,2",
            osName: "iPhone",
            osVersion: "18.3.2.22D82",
            hl: "en",
            gl: "US",
          },
        },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
      signal: AbortSignal.timeout(30000),
    },
  );

  const text = await res.text();
  if (!res.ok) {
    const blocked = /Sorry|unusual traffic|captcha/i.test(text);
    return {
      error: blocked
        ? `HTTP ${res.status} — Google served its abuse page. This IP is blocked.`
        : `HTTP ${res.status}`,
    };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "Response was not JSON (likely an interstitial page)." };
  }

  const status = data?.playabilityStatus?.status;
  const reason = data?.playabilityStatus?.reason ?? "";
  const all = [
    ...(data?.streamingData?.formats ?? []),
    ...(data?.streamingData?.adaptiveFormats ?? []),
  ].filter((f) => f.url);

  if (!all.length) {
    return { error: `${status}${reason ? ` — ${reason}` : ""}` };
  }

  const audio = all.find((f) => f.itag === 140) ?? all[0];
  const signedIp = new URL(audio.url).searchParams.get("ip");
  return { url: audio.url, itag: audio.itag, signedIp };
}

async function fetchMedia(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Range: "bytes=0-4095" },
    signal: AbortSignal.timeout(30000),
  });
  const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
  return { status: res.status, bytes: buf.byteLength };
}

console.log("\nSageTube relay host check\n" + "=".repeat(46));
const ip = await publicIp();
console.log(`Outbound IP: ${ip}\n`);

let passes = 0;
for (const v of VIDEOS) {
  process.stdout.write(`${v}  `);

  const minted = await mint(v);
  if (minted.error) {
    console.log(`${bad("FAIL")} — mint rejected\n         ${dim(minted.error)}`);
    continue;
  }
  process.stdout.write(`mint ${ok("ok")} (itag ${minted.itag})  `);

  const media = await fetchMedia(minted.url);
  const matches = minted.signedIp === ip;
  if (media.status === 206 || media.status === 200) {
    console.log(`download ${ok("ok")} (${media.bytes} bytes)`);
    passes++;
  } else {
    console.log(`download ${bad("FAIL")} (HTTP ${media.status})`);
    console.log(
      `         ${dim(`URL signed for ${minted.signedIp}, this host is ${ip}` + (matches ? " — addresses match, so the block is elsewhere" : " — MISMATCH: outbound address changed between calls"))}`,
    );
  }
}

console.log("=".repeat(46));
if (passes === VIDEOS.length) {
  console.log(ok(`PASS — ${passes}/${VIDEOS.length}. This host can run the relay.\n`));
  process.exit(0);
} else {
  console.log(
    bad(`FAIL — ${passes}/${VIDEOS.length}. Do not use this host; try another provider or region.\n`),
  );
  process.exit(1);
}
