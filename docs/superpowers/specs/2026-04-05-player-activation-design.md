# Stream Detection: Robust Player Activation

**Date**: 2026-04-05
**Status**: Approved

## Problem

Streams never load because the embed player (`embedsports.top`) uses a WASM-based wrapper (`lock.wasm`) with a custom play button. The actual stream uses standard HLS.js, but the `.m3u8` requests only appear in network traffic **after** the play button is clicked.

The current stream resolver fails because:
1. It navigates with `waitUntil: 'domcontentloaded'` — WASM hasn't loaded yet when interaction is attempted
2. Play button click uses only 5 hardcoded CSS selectors that don't match this player
3. `_waitForIframesAndAutoplay` burns ~8s on iframe waits before attempting clicks, eating the 20s detection timeout

## Evidence

From production logs (2026-04-05):
- 10/10 stream detection attempts timed out
- Only 4 network requests captured per attempt: ad tracker, two `/fetch` calls (body: "ok"), and `lock.wasm`
- No `.m3u8` ever seen in network traffic
- Config fallback found no known player instances (JWPlayer, Clappr, HLS.js, video elements)

User confirmed: opening the same embed URL in Chrome and clicking play produces `.m3u8` requests to `lb1.modifiles.fans`, served by `provider.hlsjs.js` (HLS.js).

## Design

All changes are in `src/streamResolver.js`. No other modules change.

### A. Page Load Strategy

In `_resolveWithContext`, change navigation to wait for full page load:

```javascript
await page.goto(embedUrl, {
  waitUntil: 'load',  // was: 'domcontentloaded'
  timeout: Math.min(timeout * 2, 90000),
});
```

After inner-iframe navigation (if any), add a 2s wait for WASM initialization before starting network detection.

### B. New `_activatePlayer(page)` Method

Replaces the click logic currently spread across `_waitForIframesAndAutoplay`. Fires multiple strategies sequentially, with ~1s yields between groups to let the player react. Does NOT stop after first click — keeps trying since we can't know which click worked until a stream URL appears.

**Strategy order:**

1. **Programmatic video play** — `document.querySelector('video')?.play()` (cheapest)
2. **Click largest video/canvas element** — WASM players render to canvas; click center of the largest one found
3. **Click center of viewport** — catches full-page overlays
4. **Click visible overlays** — find divs positioned over video/canvas (absolute/fixed, high z-index, large area)
5. **Specific selectors** — keep existing 5 selectors as final fallback: `.play-button`, `.vjs-big-play-button`, `[aria-label="Play"]`, `button.play`, `.jw-icon-display`
6. **Keyboard events** — dispatch Space and Enter keypresses (many players bind these to play)

### C. HLS.js Source Interception

Add to `ANTI_DETECTION_SCRIPT`:

```javascript
// Capture HLS.js stream URL when loadSource is called
Object.defineProperty(window, '__capturedStreamUrl', { value: null, writable: true });
let _hlsPatched = false;
new MutationObserver(() => {
  if (!_hlsPatched && window.Hls) {
    _hlsPatched = true;
    const origLoad = window.Hls.prototype.loadSource;
    window.Hls.prototype.loadSource = function(src) {
      window.__capturedStreamUrl = src;
      return origLoad.call(this, src);
    };
  }
}).observe(document, { childList: true, subtree: true });
```

This stores the URL in a global that the config fallback can read.

### D. Update `_detectFromPlayerConfig`

Add `window.__capturedStreamUrl` as the first check, before JWPlayer/Clappr/HLS.js/video element inspection:

```javascript
// Check for HLS.js-intercepted URL first
if (window.__capturedStreamUrl) {
  const url = window.__capturedStreamUrl;
  const type = /\.m3u8/i.test(url) ? 'hls' : /\.mpd/i.test(url) ? 'dash' : 'mp4';
  return { url, type };
}
```

### E. Simplify `_waitForIframesAndAutoplay`

Rename to `_waitForIframes`. Remove all play/click logic from it (moved to `_activatePlayer`). It now only handles:
- Waiting for embed iframes to load
- Logging frame state

### F. Restructured Flow in `_resolveWithContext`

```
1. Navigate to embed page (waitUntil: 'load')
2. Check for inner iframe → navigate if found
3. Wait 2s for WASM init
4. Start network listener (_waitForStreamUrl)  ← timeout starts here
5. Wait for iframes (_waitForIframes)
6. Activate player (_activatePlayer)           ← clicks happen here
7. Network listener catches .m3u8
   OR timeout → config fallback reads __capturedStreamUrl
8. Return result
```

## What Doesn't Change

- `channelManager.js`, `scraper.js`, `embedResolver.js`, `solverClient.js` — untouched
- Network detection patterns (`.m3u8`/`.mpd`/`.mp4` regexes) — already correct
- Browser lifecycle, solver cookie flow, anti-detection fingerprinting
- Existing tests pass (mock-based, don't depend on click internals)

## New Tests

- `_activatePlayer` clicks video/canvas elements
- HLS.js interception in init script captures stream URLs
- `_detectFromPlayerConfig` checks `__capturedStreamUrl` first
- Integration: simulated HLS.js loadSource triggers stream detection via intercepted URL

## Files Modified

- `src/streamResolver.js` — all changes
- `src/__tests__/streamResolver.test.js` — new tests
