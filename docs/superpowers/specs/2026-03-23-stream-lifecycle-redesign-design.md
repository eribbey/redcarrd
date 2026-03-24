# Stream Lifecycle Redesign: Proactive Keep-Alive with Health Checks

**Date**: 2026-03-23
**Status**: Approved

## Problem

The current architecture resolves all stream URLs at rebuild time, then serves a static playlist. This causes:

1. **Stale channels**: Stream URLs expire (403/410) before the next rebuild, leaving broken channels in the playlist.
2. **Wasted hydration**: Playwright resolves streams for every live event upfront, even those nobody watches. With ~20 channels and short-lived URLs, most are dead by the time an IPTV client requests them.
3. **Broken playback**: Channels appear playable in the IPTV guide but fail on tune-in. Zero out of ~20 channels typically work.

The user runs an always-on IPTV client and expects the playlist to be a live, accurate view of what's actually streamable. Only verified-playable channels should appear.

## Design

Replace the monolithic scrape-build-hydrate-all rebuild cycle with three independent, continuously running loops.

### Architecture Overview

```
Event Loop (every 10 min)         Resolution Loop (continuous)       Health Check Loop (every 30s)
        |                                   |                                   |
  Scrape API                      Pick highest-priority               HEAD request each
  Build/reconcile channels        channel needing resolution          resolved channel
  (no stream resolution)          Resolve via Playwright              |
        |                         Update channel status               Pass -> status: healthy
  Channels: status=pending              |                             Fail -> status: unhealthy
                                  Success -> status: resolved               -> queue re-resolve
                                  Failure -> backoff + retry
                                                                    Playlist = healthy channels only
```

### Channel Status Lifecycle

```
pending --> resolved --> healthy --> (in playlist)
              |                        |
              v                        v
            failed               unhealthy --> pending (re-resolve)
              |                        |
              v                        v
         dead (after 5             dead (after 3 rapid
         consecutive               healthy->unhealthy
         failures)                 cycles in 10 min)

         dead channels reset to pending on next event loop refresh
```

### Section 1: Event Loop (Channel Discovery)

Replaces the current `rebuildChannels()` scrape + build + hydrate-all approach.

**Behavior**:
- Runs every 10 minutes (configurable via `EVENT_POLL_INTERVAL_MINUTES`)
- Calls `fetchMatchesFromApi` + `buildEventsFromApi` + `fetchStreamsForSource` (same as today)
- Reconciles against existing channels:
  - New events: add channel with `streamUrl: null`, `status: 'pending'`
  - Existing events still in API: preserve resolved stream URL and status. Exception: `dead` channels are reset to `status: 'pending'` with `failCount: 0` to give them a fresh chance.
  - Events no longer in API: remove channel, clean up transmux jobs
- Does **not** trigger hydration. Resolution is handled by the resolution loop.
- After reconciliation, the resolution loop picks up new pending channels automatically.

**Key change**: `buildChannels()` no longer triggers `hydrateStreams()`. The playlist is always servable (possibly empty on first boot).

### Section 2: Resolution Loop (Stream URL Worker)

A continuously running worker that resolves stream URLs one channel at a time.

**Priority order**:
1. Pending channels (newly discovered, no stream URL) — newest first
2. Failed channels (last attempt failed) — with exponential backoff
3. Expiring channels (stream URL approaching 80% of TTL) — re-resolve before stale

**Behavior**:
- Continuous `while(true)` loop with 1-2 second sleep between iterations
- Each iteration: pick highest-priority channel, call `streamResolver.resolve()`, update channel
- On success: set `streamUrl`, `resolvedAt`, `status: 'resolved'`
- On failure: set `status: 'failed'`, increment `failCount`, set `nextRetryAt` with exponential backoff (30s, 1m, 2m, 5m, capped at 10m)
- Channels with 5+ consecutive failures: `status: 'dead'`, excluded from resolution until next event loop refresh resets them

**Resolution latency**: A single `streamResolver.resolve()` call can take up to 100+ seconds (4 attempts x 20s timeout + 5s autoplay delay each). The loop processes one channel at a time; on cold start with 20 pending channels, it may take 30+ minutes to attempt all channels if many fail. This is acceptable — channels appear in the playlist as soon as each one individually resolves and passes health check, rather than waiting for all to complete.

**Cooldown removal**: The existing 2-minute `resolveStream()` cooldown (`COOLDOWN_MS`) is removed. The resolution loop's own backoff logic replaces it, and since resolution is centralized in this loop (no more inline re-resolution from `fetchStream()`), concurrent resolution attempts on the same channel cannot occur.

**Key change**: No more `hydrateStreams()` doing all channels in parallel. No more inline re-resolution from `fetchStream()`. Resolution is a steady background trickle.

### Section 3: Health Check Loop

The key new component ensuring playlist accuracy.

**Behavior**:
- Runs every 30 seconds (configurable via `HEALTH_CHECK_INTERVAL_SECONDS`)
- Checks channels with `status: 'resolved'` or `status: 'healthy'`
- Health check method depends on stream type:
  - **HLS channels** (`.m3u8`): Fetch the manifest using `buildStreamHeaders()` (which merges `requestHeaders`, `streamHeaders`, and cookies — all three are required to avoid 403s). Verify the response is a valid HLS manifest containing `#EXTINF` segment entries. An empty or non-HLS response body is a failure even if the HTTP status is 200 (CDNs can cache stale 200s).
  - **Non-HLS channels** (transmux targets): HTTP HEAD request with full `buildStreamHeaders()`. A 2xx response is sufficient since these are direct media URLs.
- Pass: `status: 'healthy'`, update `lastHealthCheck`. Channel included in playlist.
- Fail (403, 404, 410, timeout, network error, empty manifest): `status: 'unhealthy'`, remove from playlist immediately, clear `streamUrl`, set `status: 'pending'` for re-resolution
- Checks run sequentially (~500ms each, ~10s for 20 channels) to avoid slamming upstream
- Channels cycling healthy -> unhealthy -> re-resolved -> unhealthy 3 times within 10 minutes: `status: 'dead'`

### Section 4: Playlist Generation

The playlist becomes a dynamic filtered view.

**Changes**:
- `generatePlaylist()` filters to only `status: 'healthy'` channels
- Remove `playlistReady` and `hydrationInProgress` flags entirely
- Playlist is always servable (valid M3U8, possibly empty)
- EPG generation follows same filter: only healthy channels get programme entries. Programmes are filtered by joining on `channelId` against healthy channel IDs (the programme objects don't have a status field themselves).
- IPTV client's natural playlist refresh picks up changes automatically

**API changes**:
- `GET /playlist.m3u8`: no more 503 "not ready". Always returns valid M3U8.
- `GET /api/channels`: add `status` field for web UI visibility
- `POST /api/rebuild`: triggers event loop only. Resolution and health checks continue independently.

### Section 5: Channel Schema Changes

New fields added to channel objects:

```javascript
{
  // Existing fields (unchanged)
  id, category, title, embedUrl, streamUrl, streamMimeType,
  requestHeaders, streamHeaders, sourceOptions, qualityOptions,
  cookies, selectedSource, streamMode, expiresAt,

  // New fields
  status: 'pending' | 'resolved' | 'healthy' | 'unhealthy' | 'failed' | 'dead',
  resolvedAt: null,        // (already exists) timestamp of last successful resolution
  lastHealthCheck: null,   // timestamp of last health check attempt
  failCount: 0,            // consecutive resolution failures
  nextRetryAt: null,       // backoff timer for failed resolutions
  healthFailCount: 0,      // tracks rapid healthy->unhealthy cycles for dead detection
}
```

**Where loops live**: All three loops start from `server.js` at boot. They are `async` functions with `while(true)` + sleep (not intervals) to prevent overlapping executions.

```
server.js boot:
  1. Start Express server
  2. Run initial event loop (scrape + build channels)
  3. Start resolution loop (background)
  4. Start health check loop (background)
  5. Schedule event loop on timer
```

**Where the logic lives**:
- Event loop: `server.js` (replaces `rebuildChannels`)
- Resolution loop: new method on `ChannelManager`
- Health check loop: new method on `ChannelManager`
- No new files needed

**Updated methods**:
- `selectSource()` and `selectQuality()`: replace `playlistReady = false` with `status: 'pending'` to queue re-resolution via the resolution loop

**Removed**:
- `hydrateStreams()`
- `playlistReady` / `hydrationInProgress` flags
- `needsReResolution()`
- Inline re-resolution from `fetchStream()`
- `resolveStream()` cooldown (`COOLDOWN_MS`) — replaced by resolution loop backoff

### Section 6: Error Handling & Edge Cases

**Startup with empty playlist**: On first boot, playlist is valid but empty. Resolution loop starts working through pending channels. First healthy channels appear within 1-2 minutes.

**All streams dead**: Playlist goes empty. Next event loop refresh (10 min) resets dead channels to pending, giving them a fresh chance.

**Upstream API down**: Event loop logs error and retries next interval. Existing channels are preserved (no wipe on failed scrape).

**Playwright crashes mid-resolution**: Resolution loop catches error, marks channel as failed with backoff, moves to next channel. Browser reconnects on next attempt.

**Health check during active playback**: Active HLS proxy continues serving as long as upstream responds. Channel disappears from playlist on next client refresh, but active playback isn't interrupted.

**Transmux lifecycle**: Transmux jobs cleaned up when channel goes unhealthy. New job starts on first client request after re-resolution.

**Graceful shutdown**: On SIGTERM/SIGINT, set a `running = false` flag checked by all three loops. The resolution loop finishes its current `streamResolver.resolve()` call (which handles its own Playwright context cleanup), then exits. Health check and event loops exit at their next iteration check.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `EVENT_POLL_INTERVAL_MINUTES` | 10 | How often to scrape API for live events |
| `HEALTH_CHECK_INTERVAL_SECONDS` | 30 | How often to validate resolved stream URLs |
| `RESOLUTION_LOOP_SLEEP_MS` | 2000 | Sleep between resolution attempts |
| `RESOLUTION_MAX_FAILURES` | 5 | Consecutive failures before marking dead |
| `HEALTH_RAPID_FAIL_THRESHOLD` | 3 | Rapid healthy->unhealthy cycles before dead |
| `HEALTH_RAPID_FAIL_WINDOW_MS` | 600000 | Window (10 min) for rapid fail detection |
| `STREAM_URL_TTL_MINUTES` | 30 | (existing) TTL for resolved URLs |
| `STREAM_DETECT_TIMEOUT_MS` | 20000 | (existing) Playwright detection timeout |
