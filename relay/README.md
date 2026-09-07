# SageTube relay

A small forwarder that makes downloads work.

## Why it is needed

googlevideo signs the requesting IP into every stream URL — `ip` is listed in
the URL's own `sparams`, so it is covered by the signature and cannot be edited
out. A download therefore only succeeds when the media request leaves from the
same address that minted the URL.

A Cloudflare Worker cannot do that. It reaches `www.youtube.com` over IPv4 and
`googlevideo.com` over IPv6, so the two addresses never match:

```
HTTP 403 | client=IOS | urlIp=172.69.170.138 | egressIp=2a06:98c0:3600::103
```

Measured on the deployed Worker: **1 of 8 downloads succeeded**. Routing both
halves through one machine: **5 of 5**, including every video that failed.

This is about the two calls sharing *one* IP — not about residential vs
datacenter. A cheap cloud box works fine.

## What it does

Two endpoints, nothing else:

| Route | Purpose |
| --- | --- |
| `GET /health` | Returns `{"ok":true}` |
| `* /fetch?token=…&url=…` | Forwards the request to `url` and streams the reply back |

The Worker calls it for both the InnerTube mint (a POST) and the media fetch (a
ranged GET), so both leave from this machine.

Safety, because this is internet-facing:

- **Host allowlist** — only `youtube.com`, `youtubei.googleapis.com`,
  `googlevideo.com`, `ytimg.com`, `youtu.be`. It cannot be repurposed as an
  open proxy or aimed at machines on your network.
- **Token required** — it refuses to start on a public interface without
  `TOKEN`, so it cannot quietly become free bandwidth for strangers.
- **Streamed, never buffered** — a 4K download does not sit in memory.
- **HTTPS targets only.**

## Deploy

Node 18+ is the only requirement; there are no dependencies.

### Fly.io

```bash
cd relay
fly launch --no-deploy --copy-config --name sagetube-relay
fly secrets set TOKEN=pick-a-long-secret
fly deploy
fly status          # note the hostname, e.g. sagetube-relay.fly.dev
```

### Railway / Render / Koyeb

Point the service at this folder. It builds from the `Dockerfile` with no
further configuration. Set one environment variable:

```
TOKEN = pick-a-long-secret
```

Render's free tier spins services down when idle; the first download after an
idle period will be slow. Any always-on tier avoids that.

### Any VPS with Docker

```bash
cd relay
docker build -t sagetube-relay .
docker run -d --restart unless-stopped -p 8080:8080 \
  -e TOKEN=pick-a-long-secret sagetube-relay
```

### Plain Node (no Docker)

```bash
cd relay
HOST=0.0.0.0 PORT=8080 TOKEN=pick-a-long-secret npm start
```

## Point the Worker at it

Both variables must name the **same** machine. Proxying only the metadata call
makes things worse: the URL would be signed for the relay while the media still
left from Cloudflare.

```bash
npx wrangler secret put YT_PROXY_URL
#   https://sagetube-relay.fly.dev/fetch?token=pick-a-long-secret&url={url}

npx wrangler secret put YT_MEDIA_PROXY_URL
#   https://sagetube-relay.fly.dev/fetch?token=pick-a-long-secret&url={url}
```

`{url}` is a literal placeholder — the Worker substitutes the encoded target.
Leave it exactly as written.

## Check it works

```bash
curl https://sagetube-relay.fly.dev/health
# {"ok":true}

# Should be 403 - proves the allowlist is active
curl "https://sagetube-relay.fly.dev/fetch?token=pick-a-long-secret&url=https://example.com/"

# Then, against the live site - expect HTTP 206
curl -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-2047' \
  "https://sagetube.sagetech386.workers.dev/api/download?v=9bZkp7q19f0&itag=140"
```

`9bZkp7q19f0` is a good test: it fails with 502 without the relay.

## Bandwidth

Every download flows through this box, so it is the one real cost. Metadata is
negligible; media is not. Pick a host with generous or unmetered egress if the
site gets traffic.

## If downloads still fail afterwards

The Worker reports the diagnosis in the error detail:

```bash
curl "https://sagetube.sagetech386.workers.dev/api/download?v=9bZkp7q19f0&itag=140"
```

- `urlIp` and `egressIp` **differ** → the two halves are still not sharing an
  IP. Usually only one of the two secrets is set, or they point at different
  hosts.
- `HTTP 403` with matching IPs → the URL expired (they last ~6h) or the host's
  IP is itself blocked. Redeploy to a different region.
- `Sign in to confirm you're not a bot` → the relay's IP is being bot-checked
  for that video. Try another region or provider.
