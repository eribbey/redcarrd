# Stream Resolver Simplification

**Date:** 2026-04-18
**Status:** Approved for planning
**Owner:** Evan

## Context

`src/streamResolver.js` has grown to ~1000 lines as a series of fixes piled up for WASM-based embed players, anti-bot countermeasures, and multi-provider detection quirks. Each fix added another fallback strategy, another network hook, or another activation path. The system now has so many moving parts that failures are hard to attribute and each new provider change requires a research session.

In practice, the app is used almost exclusively with "Admin"-provided streams from streamed.pk, which funnel through a single embed provider: `embedsports.top`. The generic multi-provider apparatus is paying for flexibility that the product doesn't use.

## Goal

Reduce `streamResolver.js` from ~1000 lines to ~150 by tuning it for the single real-world provider, while preserving its public API so the rest of the app is unaffected.

## Non-goals

- Changing the three-loop channel lifecycle (event refresh / resolution / health check)
- Changing channel statuses, rapid-fail tracking, or the resolved→healthy promotion behavior
- Changing HLS proxying, FFmpeg transmuxing, or serving paths
- Changing the scraper, frontend UI, or SSE logging
- Removing the solver client (still potentially needed for streamed.pk's Cloudflare challenges during scraping)
- Reverse-engineering embedsports.top's stream URL endpoint to skip Playwright entirely (possible future project, not this one)
- Performance benchmarking or canary rollout

## Public API contract (preserved)

```js
const resolver = new StreamResolver({ logger });
const result = await resolver.resolve(embedUrl, options);
// result: { streamUrl, headers, contentType }
```

Callers in `src/channelManager.js` (specifically `resolveStream()`) do not change.

## Architecture: the new `streamResolver.js`

Single linear flow, ~150 lines:

```
resolve(embedUrl, options):
  1. Launch fresh Playwright chromium (no reuse across calls)
  2. Create context:
     - Fixed modern desktop UA (no rotation pool)
     - Minimal anti-automation launch args:
         --disable-blink-features=AutomationControlled
         --autoplay-policy=no-user-gesture-required
         --mute-audio
     - Random viewport from a small preset list
     - Attach ANTI_DETECTION_SCRIPT (fingerprint-evasion portion only, see below)
  3. Install network response listener BEFORE navigation:
     - Match: URL ends in `.m3u8` (with optional query string)
     - Exclude: ad-domain patterns from a trimmed AD_URL_PATTERNS list
     - First match wins; capture URL + request headers
  4. page.goto(embedUrl, { waitUntil: 'load' })
  5. Wait STREAM_DETECT_WASM_SETTLE_MS (default 1500) for WASM init
  6. Ad-dismissal click loop:
     - Click viewport center every ~800ms
     - Stop on m3u8 capture OR after STREAM_DETECT_CLICK_COUNT clicks (default 12)
  7. Wait up to STREAM_DETECT_TIMEOUT_MS (default 45000) for match
  8. Capture matched-URL's request headers (referer, origin, UA, sec-fetch-*)
  9. Close context + browser in a finally block
  10. Return { streamUrl, headers, contentType: 'application/vnd.apple.mpegurl' }
```

### Error modes

- Navigation error → throw; resolution loop retries via existing failed/retry logic
- No `.m3u8` captured inside timeout → throw `STREAM_NOT_DETECTED`
- Browser crash → throw; resolution loop retries
- All failure paths close context/browser in a `finally` block

### Environment variables

Kept:
- `STREAM_DETECT_TIMEOUT_MS` (default 45000, unchanged from current implementation)

New:
- `STREAM_DETECT_CLICK_COUNT` (default 12) — ad-dismissal aggressiveness
- `STREAM_DETECT_WASM_SETTLE_MS` (default 1500) — delay after page `load` before clicking

Removed: any `streamResolver`-specific env vars keying on deleted code paths (enumerated during planning).

## `ANTI_DETECTION_SCRIPT` split

The existing `ANTI_DETECTION_SCRIPT` does two unrelated jobs. We keep one, delete the other.

**Keep — fingerprint evasion:**
- `navigator.webdriver` override
- Chrome runtime / permissions spoofing
- Plugins, languages, platform overrides
- WebGL renderer spoofing

Rationale: deleting this without evidence is reckless given recent detection failures. Cost of carrying it is negligible.

**Delete — stream-URL capture hooks:**
- HLS.js `loadSource` interception
- `window.__capturedStreamUrl` stashing

Rationale: the new resolver captures `.m3u8` URLs purely from Playwright's network response events. JS-level hooks are redundant.

## What gets deleted

### From `src/streamResolver.js`

- Multi-UA rotation pool and retry-with-different-UA loop
- WebSocket network hooks
- Stream-URL-capture portion of `ANTI_DETECTION_SCRIPT` (keep fingerprint portion)
- `__capturedStreamUrl` polling / fallback logic
- Player config inspection / fallback
- Multi-strategy player activation tree (keyboard events, iframe re-navigation, button scoring)
- Generic MP4 scoring and `NON_STREAM_MP4_PATTERNS` (m3u8-only now)
- JS bundle sniffing inside Playwright
- Cookie capture across all context domains (only the matched URL's request headers now)
- Internal retry loops inside `resolve()` (resolution loop handles retries)

### From `src/embedResolver.js`

Audit-and-delete approach: inventory runtime usage in `scraper.js`, then remove any of these that are only re-exported for tests (not actually called at runtime):

- `extractHlsStreamsFromSource`
- `extractHlsStreamsFromJwPlayerBundle`
- `isProbablePlayerBundleScript`
- `collectStreamCandidates`
- `parseEmbedPage`
- `resolveStreamFromEmbed`

Expectation: all of the above are deletable. Confirm during the planning phase.

**Keep:** `normalizeUrl`, `normalizeStreamUrl`, `guessMimeTypeFromUrl`, `extractUrlFromOnclick`, `normalizeOnclickTarget`, `resolveEmbedFromOnclick`, `collectOptions`, `buildDefaultStreamHeaders` — these are used by scraper for embed-URL extraction.

### From tests

- `src/__tests__/embedResolver.test.js` — delete test blocks for any deleted helpers; if file becomes empty, delete it
- `src/__tests__/scraper.test.js`, `scraper.playwright.test.js`, `scraper.playwright.integration.test.js` — delete tests referencing deleted helpers
- No existing tests for `streamResolver.js`; new ones added per Testing section

## Testing

### New unit tests for `streamResolver.js`

Small surface — the value comes from end-to-end, not unit isolation:

- Pure-function tests for `isAdUrl`, m3u8-match predicate, header-capture picker
- Resolver shape test: mock Playwright at the chromium-launch boundary, assert that given a fake network response matching `*.m3u8`, the resolver returns the expected `{ streamUrl, headers, contentType }` shape and closes browser/context cleanly (including in error paths)

Do not attempt to mock-test the click loop, WASM settle, or anti-bot scripts. Those are load-bearing only against real pages.

### Opt-in integration test

One gated test that hits a real embedsports.top embed URL, skipped unless `RESOLVER_INTEGRATION=1`. Not run in CI. Purpose: local `npm run test:resolver` command for validating the resolver after a provider change.

### Contract preservation

`channelManager.test.js` already covers lifecycle interaction with the resolver (via mocked `StreamResolver`). These tests should pass unchanged. If they fail, the new resolver has broken the public API.

## Rollout

1. Branch `simplify-stream-resolver` off `main`
2. Implement per this spec
3. `npm test` green
4. Merge to `main`

## Items to verify during planning

- Confirm which `embedResolver.js` helpers are dead code at runtime (scraper imports them but may not call them in the live code path — some may be test-only re-exports)
- Enumerate the exact `streamResolver`-specific env vars to remove alongside deleted code paths
- Identify the correct click target for ad-dismissal (viewport center vs. a specific selector) based on recent working implementation
