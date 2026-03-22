# Plan Review: Stream Resolution Redesign

**Reviewer:** Claude Code
**Date:** 2026-03-22
**Verdict:** ISSUES FOUND -- fixable, no structural problems

---

## Summary

The plan is well-structured, covers the spec's requirements, and follows a sound task ordering. However, there are several concrete issues that would block or confuse an implementer.

---

## Critical Issues (must fix)

### 1. Wrong method name in Task 6 server.js routing code
**Plan line 990:** `channelManager.findChannelById(req.params.id)` -- this method does not exist. The actual method is `channelManager.getChannelById()` (see `channelManager.js:281`). This would cause a runtime crash.

### 2. Wrong line references for restream.js detection logic
**Plan line 47/52:** References `restream.js:368-487` for `waitForHlsUrl` and `detectFromPlayerConfig`. The actual locations are:
- `waitForHlsUrl`: line 368-422 (correct start, wrong end)
- `detectFromPlayerConfig`: line 424-487 (close enough)
- Solver integration: lines 107-202 referenced as 107-202, but the actual solver code spans 107-202 within `main()`. This is approximately correct.

The bigger issue: the plan says to extract from `restream.js` but then writes entirely new code in `streamResolver.js` that doesn't actually copy the existing patterns closely. For example, the existing `waitForHlsUrl` listens on `page.on('request')` (line 420), while the plan's `streamResolver` uses `page.on('response')`. Both could work, but the spec says to "extract and consolidate" existing logic, not rewrite it. The implementer should decide which approach is better and document why.

### 3. `handleHlsResponse` signature mismatch in Task 6
**Plan line 1000:** `handleHlsResponse(req, res, channel)` -- the actual function signature at `server.js:202` is `handleHlsResponse(req, res, targetUrl, channel, isRootManifest)`. The plan's routing code omits the required `targetUrl` and `isRootManifest` parameters.

---

## Important Issues (should fix)

### 4. Missing `addInitScript` in streamResolver.js
The existing `restream.js` (lines 139-153) has anti-detection init scripts (webdriver override, plugins spoofing, etc.). The plan's `streamResolver.js` omits this entirely. Since the spec says to preserve the working detection patterns, this should be included.

### 5. Missing `autoplayVideo` in streamResolver.js
The existing `restream.js` (lines 494-546) has autoplay logic that triggers video playback, which is often required for network interception to capture stream URLs. The plan's streamResolver never triggers playback -- it only navigates and waits. Many embeds won't emit stream requests without a play trigger.

### 6. Task 2 (embedResolver) is underspecified
The plan acknowledges this: "The exact code depends on reading scraper.js at implementation time." The test file tests `extractIframeUrls` and `normalizeUrl`, but scraper.js exports `parseEmbedPage` and `resolveStreamFromEmbed` -- neither matches the test's expected API. The implementer will need to design this module from scratch despite the plan suggesting it's an extraction.

### 7. Task 3 line numbers will drift
Task 3 references specific line numbers (e.g., `channelManager.js:412-432`) that will be wrong after Task 1-2 modifications. Since Tasks 1-2 don't modify channelManager.js, these are currently correct, but the plan should note that line numbers are based on the pre-modification state.

### 8. No test for Cloudflare solver integration in streamResolver
The spec explicitly calls out solver integration as "the most failure-prone part of the pipeline." Task 1's test file has no test for solver cookie flow or Cloudflare retry. There should be at least one test verifying that solver cookies are applied to the context and that a Cloudflare challenge triggers a solver retry.

### 9. Missing cleanup of `streamResolver` on server shutdown
The spec mentions browser crash recovery and idle timeout, and the plan implements idle timeout. But there's no graceful shutdown hook (`process.on('SIGTERM')`) to close the shared browser when the server stops. The old `restream.js` had this.

### 10. Task ordering: Task 7 (remove files) before Task 8 (update tests)
Removing files in Task 7 will cause test failures for `restreamer.test.js` that imports the deleted module. Task 8 should be done before or merged with Task 7, or Task 7's "run all tests" step will fail.

---

## Suggestions (nice to have)

### 11. scraper.js line count discrepancy
The spec says `scraper.js` is 1,461 lines. The actual file ends at line 1,462. Minor, but worth noting for accuracy.

### 12. Plan references `channel.referer` which doesn't exist
In Task 3's `resolveStream()` implementation (plan line 692): `channel.referer` is not a field on the channel object (see `createOrUpdateChannel` at `channelManager.js:127-149`). Should use `this.frontPageUrl` or derive from `channel.embedUrl`.

### 13. `streamMode: 'restream'` default should change
In `channelManager.js:147`, new channels default to `streamMode: 'restream'`. After the redesign, this default should be `null` or `'hls'` since 'restream' mode is being removed. The plan's Task 3 doesn't mention updating `createOrUpdateChannel`.

### 14. `selectSource` and `selectQuality` still set `streamMode: 'restream'`
Lines 212 and 226 in `channelManager.js` set `streamMode: 'restream'` when sources/qualities change. These need updating too. Not mentioned in the plan.

---

## Completeness Check vs Spec

| Spec Requirement | Plan Coverage |
|---|---|
| streamResolver.js module | Task 1 -- covered |
| embedResolver.js module | Task 2 -- covered (underspecified) |
| channelManager integration | Task 3 -- covered |
| Transmuxer wiring | Task 4 -- covered |
| Stream URL TTL | Task 5 -- covered |
| Server routing simplification | Task 6 -- covered (has bugs) |
| File removal | Task 7 -- covered |
| Test cleanup | Task 8 -- covered |
| Documentation update | Task 9 -- covered |
| Smoke test | Task 10 -- covered |
| Browser crash recovery | Partially covered (idle timeout yes, crash respawn in getBrowser yes, no shutdown hook) |
| Proactive re-resolution at 80% TTL | Task 5 -- covered |
| 403/410 re-resolution | Task 5 -- covered |
| Channel cooldown | Task 5 -- covered |
| FFMPEG_MAX_CONCURRENT | Task 4 -- covered |
| STREAM_URL_TTL_MINUTES | Task 5 -- covered |
| Single shared browser instance | Task 1 -- covered |
| Store detection method per channel | NOT covered in plan |
| Scraper.js split to ~400 lines | Task 2 -- underspecified |

---

## What Was Done Well

- Clear task decomposition with each task independently committable
- Test-first approach (write failing test, implement, verify)
- Good use of dependency injection for testability (mock resolver/transmuxer)
- Correct identification of the stub at `ensureTransmuxed()` that needs wiring
- Proper handling of concurrent resolution limits
- The streamResolver class design (shared browser, per-resolution contexts) matches the spec well
