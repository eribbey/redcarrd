# Stream Resolver Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `src/streamResolver.js` from ~1000 lines to ~150 by tuning it for the single real-world provider (embedsports.top), while preserving the `.resolve(embedUrl, options)` public API. Delete dead stream-resolution helpers from `src/embedResolver.js`. Spec: `docs/superpowers/specs/2026-04-18-stream-resolver-simplification-design.md`.

**Architecture:** Replace the current multi-strategy resolver with a single linear flow: launch fresh Playwright chromium → install network listener for `*.m3u8` → navigate → wait for WASM → click-dismiss ads → return first captured URL + request headers. Keep the fingerprint-evasion portion of `ANTI_DETECTION_SCRIPT`; delete the HLS.js/`__capturedStreamUrl` portion. No browser reuse across calls. Each task drives the old code out via TDD where feasible; where Playwright orchestration isn't unit-testable, we rely on existing `channelManager.test.js` contract tests to catch regressions.

**Tech Stack:** Node.js, Playwright 1.57.0, Jest 30.2.0. CommonJS modules. Existing project conventions (2-space indent, single quotes, semicolons).

---

## Pre-flight

Before starting, confirm:
- `git status` shows a clean working tree (commit, stash, or discard any pending unrelated changes)
- `npm test` passes on `main` — if it doesn't, stop and fix baseline first
- `docs/superpowers/specs/2026-04-18-stream-resolver-simplification-design.md` is the authority; when in doubt, follow the spec

## File structure

**Modified:**
- `src/streamResolver.js` — rewritten from ~1000 lines to ~150
- `src/embedResolver.js` — remove dead stream-resolution helpers; keep URL/onclick helpers and the two functions used by scraper at runtime (`extractHlsStreamsFromSource`, `isProbablePlayerBundleScript`)
- `src/scraper.js` — remove imports of deleted helpers
- `src/__tests__/embedResolver.test.js` — delete test blocks for removed helpers
- `src/__tests__/scraper.test.js` — delete test blocks referencing removed helpers
- `src/__tests__/scraper.playwright.test.js` — delete test blocks referencing removed helpers
- `src/__tests__/scraper.playwright.integration.test.js` — delete test blocks referencing removed helpers
- `package.json` — add `test:resolver` script

**Created:**
- `src/__tests__/streamResolver.test.js` — new unit test file

---

### Task 1: Create feature branch

**Files:**
- No file changes yet

- [ ] **Step 1: Branch from main**

Run:
```bash
git checkout -b simplify-stream-resolver
```

Expected: `Switched to a new branch 'simplify-stream-resolver'`

- [ ] **Step 2: Verify baseline is green**

Run: `npm test`
Expected: all suites pass. If anything fails, STOP and investigate before proceeding.

---

### Task 2: Audit `embedResolver.js` dead-code candidates

**Files:**
- Read: `src/scraper.js`, `src/embedResolver.js`
- No code changes

**Purpose:** confirm which `embedResolver.js` exports are only test-consumed (safe to delete) vs. live in `scraper.js` runtime paths.

- [ ] **Step 1: Grep for every call site of the candidates in `src/` (excluding tests)**

Run:
```bash
grep -n -E 'extractHlsStreamsFromJwPlayerBundle|collectStreamCandidates|parseEmbedPage|\b_resolveStreamFromEmbed\b|\bresolveStreamFromEmbed\b' src/*.js
```

Known from prior audit:
- `extractHlsStreamsFromSource`, `isProbablePlayerBundleScript` → called in `scraper.js` around line 342–345 at runtime → **KEEP**
- `normalizeUrl`, `normalizeStreamUrl`, `guessMimeTypeFromUrl`, `extractUrlFromOnclick`, `normalizeOnclickTarget`, `resolveEmbedFromOnclick`, `collectOptions`, `buildDefaultStreamHeaders` → used by scraper → **KEEP**
- `extractHlsStreamsFromJwPlayerBundle`, `collectStreamCandidates`, `parseEmbedPage`, `resolveStreamFromEmbed` (and its `_resolveStreamFromEmbed` alias) → candidates for deletion

For each candidate:
- If grep shows a call site *inside `src/` but outside `src/__tests__/`* that is NOT just a re-export (i.e., `scraper.js` actually invokes the function), KEEP it and note the call site.
- If grep shows only imports/re-exports in `src/scraper.js` and call sites only in `src/__tests__/`, mark for DELETION.

- [ ] **Step 2: Record audit results in a short comment at the top of the plan-execution checklist**

Note which candidates will be deleted vs. kept. Example (typical expected outcome):

```
Deletion confirmed: extractHlsStreamsFromJwPlayerBundle, collectStreamCandidates, parseEmbedPage, resolveStreamFromEmbed
Kept (runtime use): extractHlsStreamsFromSource, isProbablePlayerBundleScript, plus all URL/header helpers
```

- [ ] **Step 3: No commit**

Audit is observation only.

---

### Task 3: Add failing unit tests for pure helpers in new `streamResolver.js`

**Files:**
- Create: `src/__tests__/streamResolver.test.js`

**Purpose:** TDD the pure helpers (`isAdUrl`, m3u8-match predicate, header picker) before rewriting the class.

- [ ] **Step 1: Create the test file**

Write `src/__tests__/streamResolver.test.js`:

```javascript
'use strict';

const {
  isAdUrl,
  isHlsManifestUrl,
  pickCapturedHeaders,
} = require('../streamResolver');

describe('streamResolver pure helpers', () => {
  describe('isAdUrl', () => {
    test('returns true for known ad domains', () => {
      expect(isAdUrl('https://doubleclick.net/ads/abc')).toBe(true);
      expect(isAdUrl('https://pagead2.googlesyndication.com/x')).toBe(true);
      expect(isAdUrl('https://cdn.example.com/tracking/pixel.gif')).toBe(true);
    });

    test('returns false for likely-stream URLs', () => {
      expect(isAdUrl('https://cdn.example.com/stream/index.m3u8')).toBe(false);
      expect(isAdUrl('https://netanyahu.modifiles.fans/secure/TOKEN/1/2/name/index.m3u8')).toBe(false);
    });
  });

  describe('isHlsManifestUrl', () => {
    test('matches .m3u8 with or without query string', () => {
      expect(isHlsManifestUrl('https://host/path/index.m3u8')).toBe(true);
      expect(isHlsManifestUrl('https://host/path/index.m3u8?token=abc')).toBe(true);
      expect(isHlsManifestUrl('https://host/path/tracks-v1a1/mono.ts.m3u8')).toBe(true);
    });

    test('rejects non-HLS URLs', () => {
      expect(isHlsManifestUrl('https://host/path/video.mp4')).toBe(false);
      expect(isHlsManifestUrl('https://host/path/stream.mpd')).toBe(false);
      expect(isHlsManifestUrl('https://host/m3u8')).toBe(false);
      expect(isHlsManifestUrl('')).toBe(false);
      expect(isHlsManifestUrl(null)).toBe(false);
    });
  });

  describe('pickCapturedHeaders', () => {
    test('extracts only the stream-relevant headers', () => {
      const raw = {
        'user-agent': 'Mozilla/5.0 (...) Chrome/131',
        referer: 'https://embedsports.top/embed/x',
        origin: 'https://embedsports.top',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-dest': 'empty',
        'accept-language': 'en-US',
        cookie: 'should-not-leak',
        'x-random-tracker': 'ignore',
      };
      const picked = pickCapturedHeaders(raw);
      expect(picked).toEqual({
        'user-agent': 'Mozilla/5.0 (...) Chrome/131',
        referer: 'https://embedsports.top/embed/x',
        origin: 'https://embedsports.top',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-dest': 'empty',
      });
    });

    test('returns empty object when input is empty', () => {
      expect(pickCapturedHeaders({})).toEqual({});
      expect(pickCapturedHeaders(undefined)).toEqual({});
    });
  });
});
```

- [ ] **Step 2: Run the test file to confirm it fails**

Run: `npx jest src/__tests__/streamResolver.test.js -v`
Expected: FAIL. Reason: current `streamResolver.js` does not export `isHlsManifestUrl` or `pickCapturedHeaders`. (The `isAdUrl` tests may pass, but the require destructuring will throw — the whole suite is red.)

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/__tests__/streamResolver.test.js
git commit -m "Add failing tests for simplified streamResolver helpers"
```

---

### Task 4: Write the shape test for `StreamResolver.resolve()`

**Files:**
- Modify: `src/__tests__/streamResolver.test.js`

**Purpose:** TDD a single end-to-end shape test using an injectable mock `chromium` so we don't need real Playwright.

- [ ] **Step 1: Append the shape test to the test file**

Append to `src/__tests__/streamResolver.test.js`:

```javascript
const { StreamResolver } = require('../streamResolver');

function makeFakeChromium({ onM3u8 }) {
  const listeners = { response: [] };
  const closedThings = [];

  const fakeRequest = {
    allHeaders: async () => ({
      'user-agent': 'Mozilla/5.0 fake',
      referer: 'https://embedsports.top/embed/x',
      origin: 'https://embedsports.top',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-dest': 'empty',
      cookie: 'should-not-leak',
    }),
  };

  const fakeResponse = {
    url: () => 'https://netanyahu.modifiles.fans/secure/TOKEN/1/2/team/index.m3u8',
    request: () => fakeRequest,
  };

  const page = {
    on: (evt, cb) => { if (listeners[evt]) listeners[evt].push(cb); },
    addInitScript: async () => {},
    goto: async () => {
      // Simulate a matching m3u8 response shortly after navigation
      if (onM3u8 === 'emit') {
        setImmediate(() => listeners.response.forEach((cb) => cb(fakeResponse)));
      }
    },
    waitForTimeout: async () => {},
    mouse: { click: async () => {} },
    viewportSize: () => ({ width: 1280, height: 720 }),
    close: async () => { closedThings.push('page'); },
  };

  const context = {
    newPage: async () => page,
    addInitScript: async () => {},
    close: async () => { closedThings.push('context'); },
  };

  const browser = {
    newContext: async () => context,
    close: async () => { closedThings.push('browser'); },
    isConnected: () => true,
    on: () => {},
  };

  const chromium = {
    launch: async () => browser,
  };

  return { chromium, closedThings };
}

describe('StreamResolver.resolve', () => {
  test('returns streamUrl + headers + contentType when a .m3u8 is seen', async () => {
    const { chromium, closedThings } = makeFakeChromium({ onM3u8: 'emit' });
    const resolver = new StreamResolver({ logger: { info() {}, warn() {}, error() {}, debug() {} }, chromium });

    const result = await resolver.resolve('https://embedsports.top/embed/test');

    expect(result.streamUrl).toMatch(/\.m3u8/);
    expect(result.contentType).toBe('application/vnd.apple.mpegurl');
    expect(result.headers).toMatchObject({
      referer: 'https://embedsports.top/embed/x',
      origin: 'https://embedsports.top',
    });
    expect(result.headers.cookie).toBeUndefined();
    expect(closedThings).toEqual(expect.arrayContaining(['context', 'browser']));
  });

  test('throws STREAM_NOT_DETECTED when timeout elapses with no m3u8', async () => {
    const { chromium, closedThings } = makeFakeChromium({ onM3u8: 'never' });
    const resolver = new StreamResolver({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      chromium,
      detectTimeoutMs: 50,
      wasmSettleMs: 5,
      clickCount: 2,
    });

    await expect(resolver.resolve('https://embedsports.top/embed/test')).rejects.toThrow(/STREAM_NOT_DETECTED/);
    expect(closedThings).toEqual(expect.arrayContaining(['context', 'browser']));
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx jest src/__tests__/streamResolver.test.js -v`
Expected: FAIL. The class will attempt to launch a real chromium (ignores the injected mock) and/or the API shape doesn't match.

- [ ] **Step 3: Commit the failing shape tests**

```bash
git add src/__tests__/streamResolver.test.js
git commit -m "Add failing shape tests for StreamResolver.resolve"
```

---

### Task 5: Rewrite `src/streamResolver.js`

**Files:**
- Modify: `src/streamResolver.js` (full rewrite)

**Purpose:** make all tests from Task 3 + Task 4 pass; preserve the `new StreamResolver({ logger })` + `.resolve(embedUrl, options)` public contract; delete everything the spec calls out as dead.

- [ ] **Step 1: Replace the entire file contents**

Write `src/streamResolver.js` (full contents — approximately 180 lines):

```javascript
'use strict';

const { chromium: defaultChromium } = require('playwright');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PLAYWRIGHT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--disable-blink-features=AutomationControlled',
];

const AD_URL_PATTERNS = [
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
  /googleadservices\.com/i,
  /facebook\.com\/tr/i,
  /\/analytics\//i,
  /\/adserver\//i,
  /\/tracking\//i,
  /\/pixel\//i,
  /\/beacon\//i,
  /\/ads\//i,
  /\/ad\//i,
  /popunder/i,
  /popads/i,
  /vastserv/i,
  /prebid/i,
];

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 810 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

const HEADER_ALLOWLIST = [
  'user-agent',
  'referer',
  'origin',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-dest',
];

// Fingerprint-evasion only. The HLS.js loadSource / __capturedStreamUrl hooks
// from the previous implementation are intentionally removed: the new resolver
// reads m3u8 URLs directly from Playwright's network response events.
const ANTI_DETECTION_SCRIPT = `
(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

  const originalPlugins = navigator.plugins;
  Object.defineProperty(navigator, 'plugins', {
    get: () => originalPlugins && originalPlugins.length ? originalPlugins : [1, 2, 3, 4, 5],
  });

  const origQuery = navigator.permissions && navigator.permissions.query;
  if (origQuery) {
    navigator.permissions.query = (params) =>
      params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery.call(navigator.permissions, params);
  }

  window.chrome = window.chrome || { runtime: {} };

  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, param);
  };
})();
`;

function isAdUrl(url) {
  if (!url) return false;
  return AD_URL_PATTERNS.some((re) => re.test(url));
}

function isHlsManifestUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /\.m3u8(\?.*)?$/i.test(url);
}

function pickCapturedHeaders(raw) {
  if (!raw) return {};
  const out = {};
  for (const name of HEADER_ALLOWLIST) {
    if (raw[name] !== undefined) out[name] = raw[name];
  }
  return out;
}

function pickViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

class StreamResolver {
  constructor({ logger, chromium, detectTimeoutMs, wasmSettleMs, clickCount } = {}) {
    this.logger = logger || console;
    this.chromium = chromium || defaultChromium;
    this.detectTimeoutMs =
      detectTimeoutMs != null
        ? detectTimeoutMs
        : parseInt(process.env.STREAM_DETECT_TIMEOUT_MS, 10) || 45000;
    this.wasmSettleMs =
      wasmSettleMs != null
        ? wasmSettleMs
        : parseInt(process.env.STREAM_DETECT_WASM_SETTLE_MS, 10) || 1500;
    this.clickCount =
      clickCount != null
        ? clickCount
        : parseInt(process.env.STREAM_DETECT_CLICK_COUNT, 10) || 12;
  }

  async resolve(embedUrl, _options = {}) {
    const logger = this.logger;
    logger.info('Resolving stream', { embedUrl });

    const browser = await this.chromium.launch({
      headless: true,
      args: PLAYWRIGHT_LAUNCH_ARGS,
    });

    let context;
    try {
      context = await browser.newContext({
        userAgent: DEFAULT_USER_AGENT,
        viewport: pickViewport(),
      });
      await context.addInitScript(ANTI_DETECTION_SCRIPT);

      const page = await context.newPage();

      let captured = null;
      const deferred = createDeferred();

      page.on('response', async (response) => {
        if (captured) return;
        const url = response.url();
        if (!isHlsManifestUrl(url)) return;
        if (isAdUrl(url)) return;
        try {
          const rawHeaders = await response.request().allHeaders();
          captured = {
            streamUrl: url,
            headers: pickCapturedHeaders(rawHeaders),
            contentType: 'application/vnd.apple.mpegurl',
          };
          logger.info('Captured stream URL', { streamUrl: url });
          deferred.resolve(captured);
        } catch (err) {
          logger.warn('Failed to read request headers', { error: err.message });
        }
      });

      await page.goto(embedUrl, { waitUntil: 'load', timeout: this.detectTimeoutMs });
      await page.waitForTimeout(this.wasmSettleMs);

      // Ad-dismissal click loop. Runs in parallel with the timeout race.
      const clicking = this._runClickLoop(page, deferred);
      const timing = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('STREAM_NOT_DETECTED')), this.detectTimeoutMs)
      );

      const result = await Promise.race([deferred.promise, timing]);
      clicking.cancel();
      return result;
    } finally {
      if (context) {
        try { await context.close(); } catch (err) { logger.warn('context close failed', { error: err.message }); }
      }
      try { await browser.close(); } catch (err) { logger.warn('browser close failed', { error: err.message }); }
    }
  }

  _runClickLoop(page, deferred) {
    let cancelled = false;
    (async () => {
      const viewport = page.viewportSize ? page.viewportSize() : null;
      const cx = viewport ? Math.floor(viewport.width / 2) : 640;
      const cy = viewport ? Math.floor(viewport.height / 2) : 360;
      for (let i = 0; i < this.clickCount; i += 1) {
        if (cancelled || deferred.settled) return;
        try {
          await page.mouse.click(cx, cy, { delay: 20 });
        } catch (err) {
          // Page may have navigated/closed — safe to stop
          return;
        }
        await page.waitForTimeout(800);
      }
    })().catch(() => {});
    return { cancel: () => { cancelled = true; } };
  }
}

function createDeferred() {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  const deferred = {
    promise,
    settled: false,
    resolve(v) { deferred.settled = true; resolveFn(v); },
    reject(e) { deferred.settled = true; rejectFn(e); },
  };
  return deferred;
}

module.exports = {
  StreamResolver,
  isAdUrl,
  isHlsManifestUrl,
  pickCapturedHeaders,
  AD_URL_PATTERNS,
  PLAYWRIGHT_LAUNCH_ARGS,
  ANTI_DETECTION_SCRIPT,
  DEFAULT_USER_AGENT,
};
```

- [ ] **Step 2: Run the new test file**

Run: `npx jest src/__tests__/streamResolver.test.js -v`
Expected: all tests PASS (helpers + both resolver shape tests).

- [ ] **Step 3: Run the full test suite to check for contract regressions**

Run: `npm test`
Expected: all suites PASS. If `channelManager.test.js` fails, the public API contract is broken — fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add src/streamResolver.js
git commit -m "Rewrite streamResolver for single-provider simplicity

Drops multi-UA rotation, WebSocket hooks, HLS.js interception,
player config fallback, multi-strategy activation, MP4 scoring,
JS bundle sniffing, browser reuse, and the __capturedStreamUrl
path. Retains fingerprint-evasion init script. Public API
(new StreamResolver({ logger }) / .resolve(embedUrl)) unchanged."
```

---

### Task 6: Delete confirmed-dead helpers from `embedResolver.js`

**Files:**
- Modify: `src/embedResolver.js`

**Purpose:** remove functions the Task 2 audit confirmed are not used at runtime.

Assumed audit result (adjust per Task 2 findings): delete `extractHlsStreamsFromJwPlayerBundle`, `collectStreamCandidates`, `parseEmbedPage`, `resolveStreamFromEmbed`. Keep everything else.

- [ ] **Step 1: Remove each function definition and its `module.exports` entry**

In `src/embedResolver.js`:
- Delete the `function extractHlsStreamsFromJwPlayerBundle(...)` definition and any helper constants only it uses.
- Delete the `function collectStreamCandidates(...)` definition.
- Delete the `function parseEmbedPage(...)` definition.
- Delete the `async function resolveStreamFromEmbed(...)` definition.
- In `module.exports`, remove the keys: `extractHlsStreamsFromJwPlayerBundle`, `collectStreamCandidates`, `parseEmbedPage`, `resolveStreamFromEmbed`.

If any of the other kept helpers (e.g., `normalizeStreamUrl`) turn out to only be used by the deleted functions, delete them too. Verify by grepping `src/` before deleting:
```bash
grep -n 'normalizeStreamUrl' src/*.js
```

- [ ] **Step 2: Do not touch `extractHlsStreamsFromSource` or `isProbablePlayerBundleScript`**

These are called from `scraper.js` at runtime (around line 342–345). They stay.

- [ ] **Step 3: No commit yet** — commit after imports are updated in Task 7 so the working tree stays green.

---

### Task 7: Update `scraper.js` imports

**Files:**
- Modify: `src/scraper.js`

**Purpose:** remove imports and re-exports of helpers deleted in Task 6 so `require('./embedResolver')` still resolves cleanly.

- [ ] **Step 1: Trim the destructured import at the top of `src/scraper.js`**

Remove these lines from the `require('./embedResolver')` destructuring block:
- `extractHlsStreamsFromJwPlayerBundle,`
- `collectStreamCandidates,`
- `parseEmbedPage,`
- `resolveStreamFromEmbed: _resolveStreamFromEmbed,`

Keep the other names.

- [ ] **Step 2: Remove the `resolveStreamFromEmbed` wrapper function (around line 928)**

Delete the function:
```javascript
async function resolveStreamFromEmbed(embedUrl, logger, options = {}) {
  return _resolveStreamFromEmbed(embedUrl, logger, {
    ...
  });
}
```

- [ ] **Step 3: Remove the corresponding entries from `scraper.js` `module.exports`**

Delete any `module.exports` entries that reference the deleted functions: `parseEmbedPage`, `resolveStreamFromEmbed`, `extractHlsStreamsFromJwPlayerBundle`, `collectStreamCandidates`.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: the non-embedResolver, non-scraper-test-of-deleted-helpers suites PASS. Tests that exercise the deleted helpers will still be failing at this point — that's fine, Task 8 cleans them up.

- [ ] **Step 5: Commit the embedResolver and scraper changes together**

```bash
git add src/embedResolver.js src/scraper.js
git commit -m "Remove dead static-HTML stream extraction from embedResolver/scraper

Tests that referenced the deleted helpers are pruned in the next commit."
```

---

### Task 8: Prune tests that reference deleted helpers

**Files:**
- Modify: `src/__tests__/embedResolver.test.js`
- Modify: `src/__tests__/scraper.test.js`
- Modify: `src/__tests__/scraper.playwright.test.js`
- Modify: `src/__tests__/scraper.playwright.integration.test.js`

- [ ] **Step 1: Strip imports and test blocks referencing deleted names**

In each of the four test files, delete:
- Any import/destructured require entries for: `parseEmbedPage`, `resolveStreamFromEmbed`, `extractHlsStreamsFromJwPlayerBundle`, `collectStreamCandidates`.
- Any `describe(...)` or `test(...)` blocks whose body references only those names.

For `src/__tests__/embedResolver.test.js` specifically: the `describe('extractHlsStreamsFromSource', ...)` and `describe('isProbablePlayerBundleScript', ...)` blocks stay — those helpers are still in the module.

If after pruning, `embedResolver.test.js` is empty (only comments / stray imports), delete the whole file:
```bash
git rm src/__tests__/embedResolver.test.js
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: ALL suites PASS. If any fail, investigate — either a test still references a deleted helper, or the rewrite broke the contract.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__
git commit -m "Prune tests for deleted static-HTML stream helpers"
```

---

### Task 9: Add opt-in integration test + `npm run test:resolver`

**Files:**
- Create: `src/__tests__/streamResolver.integration.test.js`
- Modify: `package.json`

**Purpose:** provide a local command to verify the resolver against a real embedsports.top URL when the provider changes their player. Skipped by default so CI and `npm test` aren't flaky.

- [ ] **Step 1: Create the integration test file**

Write `src/__tests__/streamResolver.integration.test.js`:

```javascript
'use strict';

const { StreamResolver } = require('../streamResolver');

const runWhenEnabled = process.env.RESOLVER_INTEGRATION === '1' ? describe : describe.skip;

runWhenEnabled('StreamResolver integration (opt-in)', () => {
  jest.setTimeout(90_000);

  test('resolves a real embedsports.top embed URL to an .m3u8', async () => {
    const embedUrl = process.env.RESOLVER_INTEGRATION_EMBED_URL;
    if (!embedUrl) {
      throw new Error('Set RESOLVER_INTEGRATION_EMBED_URL to a live embedsports.top embed URL');
    }

    const resolver = new StreamResolver({
      logger: { info: console.log, warn: console.warn, error: console.error, debug: () => {} },
    });
    const result = await resolver.resolve(embedUrl);

    expect(result.streamUrl).toMatch(/\.m3u8/);
    expect(result.contentType).toBe('application/vnd.apple.mpegurl');
    expect(result.headers.referer).toBeDefined();
  });
});
```

- [ ] **Step 2: Add the `test:resolver` script to `package.json`**

Open `package.json`, find the `"scripts"` section, and add:
```json
"test:resolver": "RESOLVER_INTEGRATION=1 jest src/__tests__/streamResolver.integration.test.js --runInBand"
```

(Keep existing scripts; just add this one.)

- [ ] **Step 3: Verify the opt-in guard works**

Run: `npm test`
Expected: PASS. The integration suite reports as skipped, not executed.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/streamResolver.integration.test.js package.json
git commit -m "Add opt-in integration test + npm run test:resolver"
```

---

### Task 10: Final green + merge to main

**Files:**
- None (git operations only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: ALL suites PASS, integration suite skipped.

- [ ] **Step 2: Review the diff as a whole**

Run:
```bash
git diff main --stat
```

Sanity check: `src/streamResolver.js` should be ~800+ lines smaller. `src/embedResolver.js` should be meaningfully smaller. `src/__tests__/streamResolver.test.js` should be new.

- [ ] **Step 3: Merge to main**

```bash
git checkout main
git merge --no-ff simplify-stream-resolver -m "Simplify streamResolver for single-provider use"
```

- [ ] **Step 4: Delete the feature branch**

```bash
git branch -d simplify-stream-resolver
```

---

## Spec-coverage self-check

- Public API `new StreamResolver({ logger }) / .resolve(embedUrl, options)` preserved → Task 5 exports and constructor.
- Fresh browser per call, no reuse → Task 5 `resolve()` launches inside method, closes in `finally`.
- Fingerprint-evasion script kept; HLS.js/__capturedStreamUrl portion removed → Task 5 `ANTI_DETECTION_SCRIPT` constant.
- m3u8-only detection → Task 5 `isHlsManifestUrl`.
- Ad URL filtering → Task 5 `isAdUrl` + trimmed `AD_URL_PATTERNS`.
- Click-dismissal loop (default 12 clicks, 800ms interval) → Task 5 `_runClickLoop`.
- WASM settle delay after load → Task 5 `wasmSettleMs` / `STREAM_DETECT_WASM_SETTLE_MS`.
- Error modes (navigation / timeout / browser crash) throw and close in finally → Task 5 `resolve()` + shape tests Task 4.
- `embedResolver.js` audit-and-delete of non-runtime-consumed helpers → Tasks 2, 6, 7.
- Scraper's use of `extractHlsStreamsFromSource` / `isProbablePlayerBundleScript` preserved → Task 6 Step 2.
- Unit tests for pure helpers → Task 3.
- Shape test with mocked Playwright → Task 4.
- Opt-in integration test + `npm run test:resolver` → Task 9.
- Branch → implement → tests green → merge rollout → Tasks 1, 5–10.
