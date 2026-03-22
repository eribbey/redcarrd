# Stream Resolution Redesign

## Problem

Redcarrd's streaming architecture was rewritten (Jan 2026) to use CDP video capture — Chrome DevTools Protocol screencast frames piped through FFmpeg. This approach:

1. **Fails on modest hardware** — keeping a full Chromium instance open per stream and re-encoding JPEG frames is too resource-intensive for NAS/small server deployments
2. **Streams never start** — the capture pipeline often fails before producing usable HLS segments
3. **Embed pages fail to load** — Playwright can't render embed pages reliably, even when the URLs are correct

The previous approach (intercepting HLS/DASH URLs from network traffic) was replaced because its detection logic was unreliable. The fix should be making detection more robust, not replacing it with a 10x heavier approach.

## Design

### Core Principle

**Playwright is a tool for discovering stream URLs, not for streaming.** Use the browser briefly to detect manifest URLs, then close it and proxy the stream with pure HTTP.

### Architecture Overview

```
Scraper (events + embed URLs)
    ↓
StreamResolver (short-lived Playwright → detect manifest URL)
    ↓
    ├── HLS source → HLS Proxy (pure HTTP relay, no FFmpeg)
    └── Non-HLS source → Transmuxer (FFmpeg → HLS)
    ↓
IPTV Client
```

### Stream Resolution Flow

1. Scraper finds events and embed URLs (unchanged)
2. For each channel needing hydration, launch a short-lived Playwright browser context
3. Navigate to the embed page, intercept network requests for 15-30 seconds
4. Detect HLS/DASH/video URLs from network traffic
5. Close the browser context immediately
6. Store the resolved manifest URL + required headers on the channel, along with `streamMode` (`hls` or `transmux`)
7. Serve the stream via HLS proxy or transmuxer based on `streamMode`

### New Module: `streamResolver.js` (~200-300 lines)

Refactored from existing detection logic in `restream.js` (lines 368-487: `waitForHlsUrl`, `detectFromPlayerConfig`). This is not greenfield code — the working detection patterns (network interception, JWPlayer config inspection, dialog dismissal, Cloudflare handling) are extracted and consolidated from `restream.js`.

Replaces the `src/streaming/` directory (4 files, ~1,500 lines) and absorbs the detection portions of `restream.js`.

**Detection strategy (ordered by reliability):**

1. **Network interception** (from `restream.js:waitForHlsUrl`) — listen to all network responses via `page.on('response')`. Match URLs containing `.m3u8`, `.mpd`, `.mp4`, or known CDN patterns. Filter out ads/tracking. Prioritize by content-type (`application/vnd.apple.mpegurl`, `application/dash+xml`, `video/*`).

2. **Player config extraction** (from `restream.js:detectFromPlayerConfig`) — many embed pages load a JSON config containing the stream URL before the player starts. Look for common patterns: `source:`, `file:`, `streamUrl:`, `hlsUrl:` in script tags or XHR responses. Includes JWPlayer-specific inspection.

3. **Video element inspection** — after page loads, query the DOM for `<video>` elements and check their `src` or `<source>` children.

**Cloudflare solver integration** (from `restream.js` lines 107-202):
- Import `createSolverClientFromEnv` from `solverClient.js`
- Pre-launch: fetch solver cookies before navigating to embed page
- Post-navigation: detect Cloudflare challenge page, retry with solver if detected
- Retry flow: solver fetch → set cookies → re-navigate → re-detect
- This is the most failure-prone part of the pipeline and must be preserved carefully

**Resilience:**
- Try up to 3 user agents on failure
- Configurable page load timeout (default 20s)
- Set proper `Referer` header matching the embed page's parent site
- Store the detection method that worked per-channel, try that method first on refresh

**Browser resource management:**
- Single shared browser instance (not per-channel)
- One context per resolution attempt, destroyed after
- `--disable-gpu`, `--no-sandbox`, minimal Chromium flags for low memory
- Launch browser on first need, close after idle timeout tied to rebuild interval (default: `rebuildIntervalMinutes` or 60 minutes, whichever is less)
- Max concurrent resolutions controlled by `HYDRATION_CONCURRENCY`

### Hydration Call Chain

The integration between `channelManager.js` and the new resolver:

```
channelManager.hydrateStreams()
    → for each channel: channelManager.resolveStream(channel)
        → streamResolver.resolve(embedUrl, { solverCookies, userAgent, referer })
        → returns { url, type: 'hls'|'dash'|'mp4', headers }
        → channel.streamUrl = url
        → channel.streamHeaders = headers
        → channel.streamMode = (type === 'hls') ? 'hls' : 'transmux'
```

`channelManager.js` calls `streamResolver` directly — `restreamer.js` is removed entirely (see below).

### `streamMode` Routing in `server.js`

Currently `server.js` has a three-way branch: `isRestreamChannel` → `isHlsChannel` → transmuxed. This simplifies to two modes:

| `streamMode` | Behavior |
|---|---|
| `hls` | Proxy upstream manifest + segments (pure HTTP relay) |
| `transmux` | Pipe source through FFmpeg → HLS, serve generated segments |

`server.js` routing changes:
- Remove `isRestreamChannel` branch entirely
- `channel.streamMode === 'hls'` → existing HLS proxy path
- `channel.streamMode === 'transmux'` → transmuxer path (new wiring, see below)

### HLS Proxying & Manifest Rewriting

`channelManager.js` already has this logic. Changes needed:

- Store resolved stream URL + original embed page headers (Referer, Origin) per channel
- On client request for `/hls/{channelId}/manifest.m3u8`:
  1. Fetch upstream master manifest from resolved URL
  2. Rewrite variant/segment URLs to point through server: `/hls/{channelId}/segment?url=...`
  3. Forward original Referer/Origin headers on all upstream requests
- On 403/410 from upstream, trigger automatic re-resolution of that channel's stream URL

### Transmuxer Integration (New Wiring)

`transmuxer.js` exists but is **not currently wired** into `channelManager.js` — the `ensureTransmuxed()` method is a stub that returns `null`. This must be completed:

- When `streamMode === 'transmux'`, call `transmuxer.start(streamUrl, channelId)`
- Transmuxer spawns FFmpeg to convert source → HLS in a temp directory
- Serve generated `.m3u8` and `.ts` segments from the temp directory
- Add concurrency limit for transmuxer jobs via new `FFMPEG_MAX_CONCURRENT` env var (default: 3)
- Clean up temp directories when channel expires or stream is re-resolved

### Stream URL Lifecycle

- Resolved URLs get a TTL (default: 30 minutes, configurable via `STREAM_URL_TTL_MINUTES`)
- Proactive re-resolution at 80% of TTL to avoid client-visible interruption during active playback
- On 403/410 from upstream, trigger immediate re-resolution
- If re-resolution fails after `RESTREAM_MAX_ATTEMPTS` (default 4), mark channel as unavailable
- Channel-level cooldown: don't re-resolve the same channel more than once per 2 minutes to prevent thrashing

### Browser Crash Recovery

- If the shared Playwright browser instance dies, respawn on next resolution request
- Don't hold a persistent browser — close after idle timeout

## Files to Remove

- `src/streaming/StreamManager.js` (230 lines)
- `src/streaming/BrowserStreamCapture.js` (486 lines)
- `src/streaming/FFmpegProcessManager.js` (504 lines)
- `src/streaming/StreamPipeline.js` (277 lines)
- `src/restream.js` (549 lines) — worker child process, detection logic extracted to `streamResolver.js`
- `src/restreamer.js` (390 lines) — child process orchestrator, no longer needed; hydration calls resolver directly

**Net: ~2,436 lines removed**

## Files to Simplify

### `scraper.js` (1,461 lines → ~400 lines split)
Split into focused modules:
- `scraper.js` — event discovery from the streamed.pk API (fetching event lists, parsing categories, building event objects)
- `embedResolver.js` — embed URL extraction logic (iframe detection, URL normalization, Playwright/axios embed page loading)
- Stream URL detection moves to `streamResolver.js`

### `channelManager.js` (451 lines)
- Add: `resolveStream(channel)` method calling `streamResolver`
- Add: store resolved stream URL + headers + streamMode per channel
- Add: auto-re-resolve on 403/410 from upstream
- Add: proactive TTL-based re-resolution
- Add: transmuxer integration for non-HLS channels
- Remove: references to old streaming pipeline and restreamer
- Remove: `ensureRestreamed()` method

### `server.js` (370 lines)
- Simplify stream routing from three branches to two (`hls` / `transmux`)
- Remove restream-related endpoints and references

## New Files

| File | Lines (est.) | Purpose |
|------|------|---------|
| `src/streamResolver.js` | ~200-300 | Stream URL detection via Playwright (extracted from `restream.js`) |
| `src/embedResolver.js` | ~200 | Embed URL extraction (split from `scraper.js`) |

## Environment Variables

### New

| Variable | Default | Purpose |
|----------|---------|---------|
| `STREAM_URL_TTL_MINUTES` | `30` | How long a resolved stream URL is considered valid |
| `FFMPEG_MAX_CONCURRENT` | `3` | Max simultaneous FFmpeg transmuxer processes |

### Existing (unchanged)

- `HYDRATION_CONCURRENCY` — limits parallel resolutions
- `RESTREAM_MAX_ATTEMPTS` — retry limit for resolution

## Error Handling & Logging

- Log each resolution attempt: channel ID, embed URL, detection method, success/failure, duration
- Log upstream proxy failures: channel ID, upstream URL, HTTP status
- Keep existing EventEmitter logger for frontend SSE stream
- Never swallow errors silently — structured logging with metadata on all catch blocks

## Deployment Notes

This is a breaking architectural change. **A container restart is required** after deploying — there is no graceful migration from the old CDP capture to the new URL resolution approach. Any in-flight streaming jobs from the old architecture will be orphaned on restart; this is expected and acceptable.

## Testing Plan

- Unit tests for `streamResolver.js` — mock Playwright page, verify detection logic for HLS, DASH, and direct video URLs. Test solver cookie flow and Cloudflare retry.
- Unit tests for updated `channelManager.js` — verify re-resolution triggers on 403/410, TTL-based proactive re-resolution, transmuxer fallback
- Unit tests for `embedResolver.js` — embed URL extraction from various iframe patterns
- Integration test for full flow: scrape → resolve → proxy
- Update existing tests to remove references to deleted modules

## Expected Outcome

- ~2,400 lines of code removed, ~400-500 lines added (net ~-2,000)
- Streams served via HTTP relay instead of re-encoding — dramatically lower CPU/memory
- Browser only runs briefly during URL detection, not during streaming
- Clearer module responsibilities and fewer moving parts
- Two-mode routing (`hls`/`transmux`) instead of three-way branching
