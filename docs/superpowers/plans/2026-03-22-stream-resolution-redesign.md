# Stream Resolution Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CDP video capture with lightweight stream URL detection + HLS proxying to fix streams on modest hardware.

**Architecture:** Playwright opens embed pages briefly to detect stream URLs via network interception and player config inspection, then closes. HLS streams are proxied as pure HTTP relay. Non-HLS streams are transmuxed via FFmpeg. No persistent browser instances or video re-encoding.

**Tech Stack:** Node.js (CommonJS), Playwright, Express.js, FFmpeg, Axios

**Spec:** `docs/superpowers/specs/2026-03-22-stream-resolution-redesign.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/streamResolver.js` | Stream URL detection via short-lived Playwright sessions. Extracted from `restream.js` detection logic. |
| `src/embedResolver.js` | Embed URL extraction from event pages. Split from `scraper.js`. |
| `src/__tests__/streamResolver.test.js` | Tests for stream URL detection |
| `src/__tests__/embedResolver.test.js` | Tests for embed URL extraction |

### Modified Files
| File | Changes |
|------|---------|
| `src/channelManager.js` | Replace StreamManager with streamResolver. Add `resolveStream()`, proactive TTL re-resolution, transmuxer wiring. Remove `ensureRestreamed()`. |
| `src/server.js` | Simplify stream routing from 3 branches to 2 (`hls`/`transmux`). Remove restream references. |
| `src/transmuxer.js` | Add concurrency limit via `FFMPEG_MAX_CONCURRENT`. Minor updates. |
| `src/scraper.js` | Extract embed resolution functions to `embedResolver.js`. Slim down. |

### Removed Files
| File | Reason |
|------|--------|
| `src/streaming/StreamManager.js` | Replaced by streamResolver |
| `src/streaming/BrowserStreamCapture.js` | CDP capture removed |
| `src/streaming/FFmpegProcessManager.js` | CDP capture removed |
| `src/streaming/StreamPipeline.js` | CDP capture removed |
| `src/restream.js` | Detection logic extracted to streamResolver |
| `src/restreamer.js` | Child process orchestration no longer needed |

---

## Task 1: Create `streamResolver.js` — Network Interception Detection

This is the core new module. Extract detection logic from `restream.js` lines 368-487 (`waitForHlsUrl`, `detectFromPlayerConfig`) and the solver integration from lines 107-202.

**Files:**
- Create: `src/streamResolver.js`
- Create: `src/__tests__/streamResolver.test.js`
- Reference: `src/restream.js:368-487` (detection logic to extract)
- Reference: `src/restream.js:107-202` (solver integration to extract)
- Reference: `src/solverClient.js` (dependency)

### Step 1: Write failing test for network interception detection

- [ ] **Write test for HLS URL detection via network interception**

```javascript
// src/__tests__/streamResolver.test.js
const StreamResolver = require('../streamResolver');

// Mock Playwright
jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn(),
  },
}));

const { chromium } = require('playwright');

describe('StreamResolver', () => {
  let resolver;
  let mockBrowser;
  let mockContext;
  let mockPage;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPage = {
      on: jest.fn(),
      goto: jest.fn().mockResolvedValue(),
      evaluate: jest.fn().mockResolvedValue(null),
      close: jest.fn().mockResolvedValue(),
      setExtraHTTPHeaders: jest.fn().mockResolvedValue(),
    };

    mockContext = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(),
      addCookies: jest.fn().mockResolvedValue(),
    };

    mockBrowser = {
      newContext: jest.fn().mockResolvedValue(mockContext),
      close: jest.fn().mockResolvedValue(),
      isConnected: jest.fn().mockReturnValue(true),
    };

    chromium.launch.mockResolvedValue(mockBrowser);

    resolver = new StreamResolver({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
  });

  afterEach(async () => {
    await resolver.close();
  });

  describe('resolve()', () => {
    test('should detect HLS manifest URL from network traffic', async () => {
      // Simulate page.on('response') capturing an .m3u8 response
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'response') {
          // Fire the handler after goto is called
          mockPage.goto.mockImplementation(async () => {
            handler({
              url: () => 'https://cdn.example.com/live/stream.m3u8?token=abc',
              headers: () => ({ 'content-type': 'application/vnd.apple.mpegurl' }),
              status: () => 200,
            });
          });
        }
      });

      const result = await resolver.resolve('https://embed.example.com/player/123', {
        referer: 'https://streamed.pk',
      });

      expect(result).toEqual({
        url: 'https://cdn.example.com/live/stream.m3u8?token=abc',
        type: 'hls',
        headers: expect.objectContaining({
          Referer: 'https://embed.example.com/player/123',
        }),
      });
    });

    test('should detect DASH manifest URL from network traffic', async () => {
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'response') {
          mockPage.goto.mockImplementation(async () => {
            handler({
              url: () => 'https://cdn.example.com/live/stream.mpd',
              headers: () => ({ 'content-type': 'application/dash+xml' }),
              status: () => 200,
            });
          });
        }
      });

      const result = await resolver.resolve('https://embed.example.com/player/123', {
        referer: 'https://streamed.pk',
      });

      expect(result).toEqual({
        url: 'https://cdn.example.com/live/stream.mpd',
        type: 'dash',
        headers: expect.objectContaining({
          Referer: 'https://embed.example.com/player/123',
        }),
      });
    });

    test('should filter out ad/tracking URLs', async () => {
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'response') {
          mockPage.goto.mockImplementation(async () => {
            // Fire ad URL first
            handler({
              url: () => 'https://ads.example.com/preroll.m3u8',
              headers: () => ({ 'content-type': 'application/vnd.apple.mpegurl' }),
              status: () => 200,
            });
            // Then real stream
            handler({
              url: () => 'https://cdn.example.com/live/stream.m3u8',
              headers: () => ({ 'content-type': 'application/vnd.apple.mpegurl' }),
              status: () => 200,
            });
          });
        }
      });

      const result = await resolver.resolve('https://embed.example.com/player/123', {
        referer: 'https://streamed.pk',
      });

      // Should pick the non-ad URL
      expect(result.url).toBe('https://cdn.example.com/live/stream.m3u8');
    });

    test('should return null when no stream URL is detected', async () => {
      // No responses fire — timeout
      const result = await resolver.resolve('https://embed.example.com/player/123', {
        referer: 'https://streamed.pk',
        timeout: 500, // Short timeout for test
      });

      expect(result).toBeNull();
    });

    test('should apply solver cookies when provided', async () => {
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'response') {
          mockPage.goto.mockImplementation(async () => {
            handler({
              url: () => 'https://cdn.example.com/stream.m3u8',
              headers: () => ({ 'content-type': 'application/vnd.apple.mpegurl' }),
              status: () => 200,
            });
          });
        }
      });

      const cookies = [
        { name: 'cf_clearance', value: 'abc123', domain: '.example.com', path: '/' },
      ];

      await resolver.resolve('https://embed.example.com/player/123', {
        referer: 'https://streamed.pk',
        solverCookies: cookies,
      });

      expect(mockContext.addCookies).toHaveBeenCalledWith(cookies);
    });

    test('should retry with different user agents on failure', async () => {
      let attemptCount = 0;
      mockPage.goto.mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) throw new Error('Navigation failed');
      });

      // On 3rd attempt, return a result via config fallback
      mockPage.evaluate.mockImplementation(async () => {
        if (attemptCount >= 3) {
          return { url: 'https://cdn.example.com/stream.m3u8', type: 'hls' };
        }
        return null;
      });

      const result = await resolver.resolve('https://embed.example.com/player/123', {
        referer: 'https://streamed.pk',
        maxAttempts: 4,
        timeout: 500,
      });

      expect(attemptCount).toBeGreaterThanOrEqual(3);
    });
  });
});
```

- [ ] **Run test to verify it fails**

Run: `cd /Volumes/containers/redcarrd && npx jest src/__tests__/streamResolver.test.js --no-coverage 2>&1 | head -30`
Expected: FAIL — `Cannot find module '../streamResolver'`

### Step 2: Implement `streamResolver.js` — core detection

- [ ] **Write `streamResolver.js` with network interception and player config detection**

Extract from `restream.js:368-487` and `restream.js:107-202`. Also extract:
- **Autoplay triggering** from `restream.js:494-546` (`autoplayVideo` function) — many embeds won't emit stream URLs until video playback is triggered
- **Anti-detection init scripts** from `restream.js:139-153` — `webdriver` property override, `navigator.plugins` spoofing, etc.

The module should:

```javascript
// src/streamResolver.js
const { chromium } = require('playwright');
const { createSolverClientFromEnv, normalizeSolverCookies } = require('./solverClient');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

const STREAM_URL_PATTERNS = [/\.m3u8/, /\.mpd/, /\.mp4/];
const AD_URL_PATTERNS = [/ads\./, /doubleclick/, /googlesyndication/, /preroll/, /midroll/];

const LAUNCH_ARGS = [
  '--disable-gpu',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-background-networking',
  '--disable-extensions',
];

const DEFAULT_TIMEOUT = parseInt(process.env.STREAM_DETECT_TIMEOUT_MS) || 20000;
const ENABLE_CONFIG_FALLBACK = process.env.RESTREAM_DETECT_CONFIG_FALLBACK !== 'false';

class StreamResolver {
  constructor({ logger }) {
    this.logger = logger;
    this.browser = null;
    this.idleTimer = null;
    this.idleTimeoutMs = (parseInt(process.env.BROWSER_IDLE_TIMEOUT_MINUTES) || 60) * 60 * 1000;
  }

  async getBrowser() {
    if (this.browser && this.browser.isConnected()) {
      this.resetIdleTimer();
      return this.browser;
    }
    this.logger.info('Launching shared Playwright browser');
    this.browser = await chromium.launch({
      args: LAUNCH_ARGS,
      headless: true,
    });
    this.resetIdleTimer();
    return this.browser;
  }

  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleTimeoutMs);
  }

  async close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) { /* already closed */ }
      this.browser = null;
    }
  }

  async resolve(embedUrl, options = {}) {
    const {
      referer = '',
      timeout = DEFAULT_TIMEOUT,
      maxAttempts = parseInt(process.env.RESTREAM_MAX_ATTEMPTS) || 4,
      solverCookies = null,
    } = options;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const userAgent = USER_AGENTS[attempt % USER_AGENTS.length];
      this.logger.info('Resolving stream URL', { embedUrl, attempt: attempt + 1, maxAttempts });

      try {
        const result = await this._attemptResolve(embedUrl, {
          referer,
          timeout,
          userAgent,
          solverCookies,
        });
        if (result) return result;
      } catch (error) {
        this.logger.warn('Resolution attempt failed', {
          embedUrl,
          attempt: attempt + 1,
          error: error.message,
        });
      }
    }

    this.logger.error('All resolution attempts failed', { embedUrl, maxAttempts });
    return null;
  }

  async _attemptResolve(embedUrl, { referer, timeout, userAgent, solverCookies }) {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      viewport: { width: 1280, height: 720 },
    });

    // Apply solver cookies if available (Cloudflare bypass)
    if (solverCookies && solverCookies.length > 0) {
      await context.addCookies(solverCookies);
    }

    const page = await context.newPage();

    try {
      // Anti-detection scripts (from restream.js:139-153)
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        window.chrome = { runtime: {} };
      });

      // Set referer/origin headers
      const embedOrigin = new URL(embedUrl).origin;
      await page.setExtraHTTPHeaders({
        Referer: referer || embedOrigin,
        Origin: referer ? new URL(referer).origin : embedOrigin,
      });

      // Dismiss dialogs automatically
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}));

      // Collect candidate URLs from network traffic
      const candidates = [];

      page.on('response', (response) => {
        try {
          const url = response.url();
          const status = response.status();
          if (status < 200 || status >= 400) return;

          const isStream = STREAM_URL_PATTERNS.some(p => p.test(url));
          if (!isStream) return;

          const isAd = AD_URL_PATTERNS.some(p => p.test(url));
          if (isAd) return;

          const contentType = (response.headers()['content-type'] || '').toLowerCase();
          const type = this._classifyUrl(url, contentType);

          candidates.push({ url, type, contentType });
        } catch (e) { /* ignore response parsing errors */ }
      });

      // Navigate to embed page
      await page.goto(embedUrl, {
        waitUntil: 'domcontentloaded',
        timeout,
      });

      // Trigger autoplay (from restream.js:494-546) — many embeds
      // won't fire stream requests until playback is initiated
      await this._triggerAutoplay(page);

      // Wait for stream URL to appear in network traffic
      const detected = await this._waitForDetection(page, candidates, timeout);

      if (detected) {
        return {
          url: detected.url,
          type: detected.type,
          headers: {
            Referer: embedUrl,
            Origin: embedOrigin,
          },
        };
      }

      // Fallback: try player config extraction
      if (ENABLE_CONFIG_FALLBACK) {
        const configResult = await this._detectFromPlayerConfig(page);
        if (configResult) {
          return {
            url: configResult.url,
            type: configResult.type,
            headers: {
              Referer: embedUrl,
              Origin: embedOrigin,
            },
          };
        }
      }

      return null;
    } finally {
      await context.close().catch(() => {});
    }
  }

  async _waitForDetection(page, candidates, timeout) {
    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeout) {
      // Prefer HLS over DASH over MP4
      const hls = candidates.find(c => c.type === 'hls');
      if (hls) return hls;

      const dash = candidates.find(c => c.type === 'dash');
      if (dash) return dash;

      await new Promise(r => setTimeout(r, pollInterval));
    }

    // After timeout, return best candidate if any
    return candidates.find(c => c.type === 'hls')
      || candidates.find(c => c.type === 'dash')
      || candidates.find(c => c.type === 'mp4')
      || null;
  }

  async _detectFromPlayerConfig(page) {
    // Extracted from restream.js:425-487
    try {
      const result = await page.evaluate(() => {
        // Check JWPlayer
        if (typeof jwplayer === 'function') {
          try {
            const player = jwplayer();
            const playlist = player.getPlaylist();
            if (playlist && playlist.length > 0) {
              for (const item of playlist) {
                if (item.sources) {
                  for (const source of item.sources) {
                    if (source.file) return { url: source.file, type: source.type || 'unknown' };
                  }
                }
                if (item.file) return { url: item.file, type: item.type || 'unknown' };
              }
            }
          } catch (e) { /* JWPlayer not ready */ }
        }

        // Check HTML5 video elements
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          if (video.src && video.src.startsWith('http')) {
            return { url: video.src, type: 'unknown' };
          }
          const sources = video.querySelectorAll('source');
          for (const source of sources) {
            if (source.src && source.src.startsWith('http')) {
              return { url: source.src, type: source.type || 'unknown' };
            }
          }
        }

        return null;
      });

      if (result) {
        return {
          url: result.url,
          type: this._classifyUrl(result.url, result.type),
        };
      }
    } catch (error) {
      this.logger.warn('Player config detection failed', { error: error.message });
    }
    return null;
  }

  async _triggerAutoplay(page) {
    // Extracted from restream.js:494-546
    // Click play buttons, unmute, and interact with common player UIs
    try {
      await page.evaluate(() => {
        // Try clicking common play button selectors
        const playSelectors = [
          '.vjs-big-play-button',
          '.jw-icon-display',
          '[aria-label="Play"]',
          'button.play',
          '.play-button',
          'video',
        ];
        for (const selector of playSelectors) {
          const el = document.querySelector(selector);
          if (el) { el.click(); break; }
        }
        // Try to play video elements directly
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          video.play().catch(() => {});
          video.muted = false;
        }
      });
    } catch (e) { /* autoplay trigger is best-effort */ }
  }

  _classifyUrl(url, contentType = '') {
    if (url.includes('.m3u8') || contentType.includes('mpegurl')) return 'hls';
    if (url.includes('.mpd') || contentType.includes('dash')) return 'dash';
    if (url.includes('.mp4') || contentType.includes('video/mp4')) return 'mp4';
    return 'unknown';
  }
}

module.exports = StreamResolver;
```

- [ ] **Run tests to verify they pass**

Run: `cd /Volumes/containers/redcarrd && npx jest src/__tests__/streamResolver.test.js --no-coverage 2>&1 | tail -20`
Expected: Tests pass (may need minor adjustments to mocks)

- [ ] **Commit**

```bash
git add src/streamResolver.js src/__tests__/streamResolver.test.js
git commit -m "Add streamResolver module for lightweight stream URL detection"
```

---

## Task 2: Create `embedResolver.js` — Extract from `scraper.js`

Split embed URL extraction logic out of the 1,461-line `scraper.js` into a focused module.

**Files:**
- Create: `src/embedResolver.js`
- Create: `src/__tests__/embedResolver.test.js`
- Modify: `src/scraper.js` (remove extracted functions, import from embedResolver)
- Reference: `src/scraper.js` (identify embed-related functions to extract)

### Step 1: Identify functions to extract

- [ ] **Read `scraper.js` and identify all embed-related functions**

Read the full file. Functions related to embed URL extraction (iframe detection, URL normalization, embed page loading) should move to `embedResolver.js`. Event discovery functions (API fetching, event parsing, category handling) stay in `scraper.js`.

Likely candidates based on exports (line 1450-1461):
- `parseEmbedPage()` — extract embed URLs from event pages
- `resolveStreamFromEmbed()` — Playwright stream detection (moving to streamResolver instead)
- Helper functions for iframe detection, URL normalization

### Step 2: Write failing test for embedResolver

- [ ] **Write test for embed URL extraction**

```javascript
// src/__tests__/embedResolver.test.js
const { parseEmbedPage, extractIframeUrls, normalizeUrl } = require('../embedResolver');

describe('embedResolver', () => {
  describe('extractIframeUrls()', () => {
    test('should extract iframe src URLs from HTML', () => {
      const html = `
        <html><body>
          <iframe src="https://embed.example.com/player/abc123"></iframe>
          <iframe src="//cdn.example.com/embed/xyz"></iframe>
        </body></html>
      `;
      const urls = extractIframeUrls(html, 'https://streamed.pk');
      expect(urls).toContain('https://embed.example.com/player/abc123');
      expect(urls).toContain('https://cdn.example.com/embed/xyz');
    });

    test('should filter out ad iframes', () => {
      const html = `
        <html><body>
          <iframe src="https://ads.example.com/banner"></iframe>
          <iframe src="https://embed.example.com/player/abc"></iframe>
        </body></html>
      `;
      const urls = extractIframeUrls(html, 'https://streamed.pk');
      expect(urls).not.toContain('https://ads.example.com/banner');
      expect(urls).toContain('https://embed.example.com/player/abc');
    });
  });

  describe('normalizeUrl()', () => {
    test('should handle protocol-relative URLs', () => {
      expect(normalizeUrl('//cdn.example.com/path', 'https://base.com'))
        .toBe('https://cdn.example.com/path');
    });

    test('should handle relative paths', () => {
      expect(normalizeUrl('/embed/123', 'https://base.com'))
        .toBe('https://base.com/embed/123');
    });

    test('should pass through absolute URLs', () => {
      expect(normalizeUrl('https://cdn.example.com/path', 'https://base.com'))
        .toBe('https://cdn.example.com/path');
    });
  });
});
```

- [ ] **Run test to verify it fails**

Run: `cd /Volumes/containers/redcarrd && npx jest src/__tests__/embedResolver.test.js --no-coverage 2>&1 | head -20`
Expected: FAIL — `Cannot find module '../embedResolver'`

### Step 3: Implement `embedResolver.js`

- [ ] **Extract embed functions from `scraper.js` into `embedResolver.js`**

Read `scraper.js` to identify the exact functions. Create `embedResolver.js` with the extracted logic. Update `scraper.js` to import from `embedResolver.js` instead.

The exact code depends on reading `scraper.js` at implementation time — the functions to extract are those dealing with embed page HTML parsing, iframe URL extraction, and URL normalization. Keep event/API functions in `scraper.js`.

- [ ] **Run all tests to verify nothing breaks**

Run: `cd /Volumes/containers/redcarrd && npx jest --no-coverage 2>&1 | tail -20`
Expected: All existing tests still pass, new embedResolver tests pass

- [ ] **Commit**

```bash
git add src/embedResolver.js src/__tests__/embedResolver.test.js src/scraper.js
git commit -m "Extract embed URL resolution from scraper into embedResolver module"
```

---

## Task 3: Wire `streamResolver` into `channelManager.js`

Replace the StreamManager integration with the new streamResolver. This changes the hydration flow.

**Files:**
- Modify: `src/channelManager.js:9` (change StreamManager import to StreamResolver)
- Modify: `src/channelManager.js:36-57` (constructor — replace StreamManager with StreamResolver)
- Modify: `src/channelManager.js:152-199` (hydrateStreams — call resolveStream instead of ensureRestreamed)
- Modify: `src/channelManager.js:412-432` (replace ensureRestreamed with resolveStream)
- Modify: `src/channelManager.js:397-410` (remove isRestreamChannel, update ensureTransmuxed)
- Modify: `src/__tests__/channelManager.test.js`

### Step 1: Write failing test for new hydration flow

- [ ] **Add test for resolveStream() setting streamMode correctly**

```javascript
// Add to src/__tests__/channelManager.test.js

describe('resolveStream()', () => {
  test('should set streamMode to hls when HLS URL detected', async () => {
    // Mock streamResolver.resolve to return HLS result
    const mockResolver = {
      resolve: jest.fn().mockResolvedValue({
        url: 'https://cdn.example.com/stream.m3u8',
        type: 'hls',
        headers: { Referer: 'https://embed.example.com' },
      }),
      close: jest.fn(),
    };

    // Inject mock resolver into channelManager
    channelManager.streamResolver = mockResolver;

    const channel = { id: 'test-1', embedUrl: 'https://embed.example.com/player/1' };
    await channelManager.resolveStream(channel);

    expect(channel.streamUrl).toBe('https://cdn.example.com/stream.m3u8');
    expect(channel.streamMode).toBe('hls');
    expect(channel.streamHeaders).toEqual({ Referer: 'https://embed.example.com' });
  });

  test('should set streamMode to transmux when non-HLS URL detected', async () => {
    const mockResolver = {
      resolve: jest.fn().mockResolvedValue({
        url: 'https://cdn.example.com/stream.mpd',
        type: 'dash',
        headers: { Referer: 'https://embed.example.com' },
      }),
      close: jest.fn(),
    };

    channelManager.streamResolver = mockResolver;

    const channel = { id: 'test-2', embedUrl: 'https://embed.example.com/player/2' };
    await channelManager.resolveStream(channel);

    expect(channel.streamUrl).toBe('https://cdn.example.com/stream.mpd');
    expect(channel.streamMode).toBe('transmux');
  });
});
```

- [ ] **Run test to verify it fails**

Run: `cd /Volumes/containers/redcarrd && npx jest src/__tests__/channelManager.test.js --no-coverage 2>&1 | tail -20`
Expected: FAIL — `resolveStream is not a function`

### Step 2: Update channelManager.js

- [ ] **Replace StreamManager with StreamResolver in constructor**

In `channelManager.js`:
- Line 9: Change `require('./streaming/StreamManager')` to `require('./streamResolver')`
- Lines 36-57: In constructor, replace `this.streamManager = new StreamManager(...)` with `this.streamResolver = new StreamResolver({ logger: this.logger })`
- Also require Transmuxer: `const Transmuxer = require('./transmuxer')`
- In constructor: `this.transmuxer = new Transmuxer({ logger: this.logger })`

- [ ] **Replace `ensureRestreamed()` with `resolveStream()`**

Replace `channelManager.js:412-432` with:

```javascript
async resolveStream(channel) {
  const result = await this.streamResolver.resolve(channel.embedUrl, {
    referer: channel.referer || process.env.FRONT_PAGE_URL || 'https://streamed.pk',
    maxAttempts: parseInt(process.env.RESTREAM_MAX_ATTEMPTS) || 4,
  });

  if (!result) {
    this.logger.warn('Stream resolution failed', { channelId: channel.id, embedUrl: channel.embedUrl });
    return;
  }

  channel.streamUrl = result.url;
  channel.streamHeaders = result.headers;
  channel.streamMode = result.type === 'hls' ? 'hls' : 'transmux';
  channel.resolvedAt = Date.now();

  this.logger.info('Stream resolved', {
    channelId: channel.id,
    type: result.type,
    streamMode: channel.streamMode,
  });
}
```

- [ ] **Update `hydrateStreams()` to call `resolveStream()`**

In `channelManager.js:152-199`, change the worker function:
- Replace `this.ensureRestreamed(channel)` call (around line 174) with `await this.resolveStream(channel)`
- Remove the lines that set `streamUrl`, `streamMimeType`, `streamMode` from the ensureRestreamed result (lines 176-180) since `resolveStream` sets them directly on the channel

- [ ] **Remove `isRestreamChannel()` and `ensureRestreamed()`**

Delete `channelManager.js:397-399` (`isRestreamChannel`) and `channelManager.js:412-432` (`ensureRestreamed`).

- [ ] **Update all `streamMode: 'restream'` defaults to `streamMode: 'hls'`**

Search for `streamMode` in `channelManager.js` and update:
- `createOrUpdateChannel` (around line 147): change `streamMode: 'restream'` to remove the default (it gets set by `resolveStream`)
- `selectSource` (around line 212): change `streamMode: 'restream'` to `streamMode: null` (will be resolved during hydration)
- `selectQuality` (around line 226): same — change `streamMode: 'restream'` to `streamMode: null`

These lines currently default new/updated channels to `streamMode: 'restream'` which is a mode we're deleting.

- [ ] **Run all tests**

Run: `cd /Volumes/containers/redcarrd && npx jest --no-coverage 2>&1 | tail -20`
Expected: All pass

- [ ] **Commit**

```bash
git add src/channelManager.js src/__tests__/channelManager.test.js
git commit -m "Replace StreamManager with StreamResolver in channelManager"
```

---

## Task 4: Wire transmuxer fallback into `channelManager.js`

The `ensureTransmuxed()` method at line 401-409 is currently a stub returning null. Wire it up to the existing `Transmuxer` class.

**Files:**
- Modify: `src/channelManager.js:401-410` (implement ensureTransmuxed)
- Modify: `src/transmuxer.js` (add FFMPEG_MAX_CONCURRENT support)
- Modify: `src/__tests__/channelManager.test.js`

### Step 1: Write failing test for transmuxer integration

- [ ] **Add test for ensureTransmuxed() wiring**

```javascript
describe('ensureTransmuxed()', () => {
  test('should start transmuxer job for non-HLS channel', async () => {
    const mockTransmuxer = {
      ensureJob: jest.fn().mockResolvedValue({
        manifestPath: '/tmp/transmux-abc/test.m3u8',
        workDir: '/tmp/transmux-abc',
      }),
    };
    channelManager.transmuxer = mockTransmuxer;

    const channel = {
      id: 'test-1',
      streamUrl: 'https://cdn.example.com/stream.mpd',
      streamMode: 'transmux',
      streamHeaders: { Referer: 'https://embed.example.com' },
    };

    const result = await channelManager.ensureTransmuxed(channel);
    expect(result).toBeTruthy();
    expect(mockTransmuxer.ensureJob).toHaveBeenCalledWith(
      'test-1',
      'https://cdn.example.com/stream.mpd',
      { Referer: 'https://embed.example.com' }
    );
  });
});
```

- [ ] **Run test to verify it fails**

Run: `cd /Volumes/containers/redcarrd && npx jest src/__tests__/channelManager.test.js --no-coverage -t "ensureTransmuxed" 2>&1 | tail -20`
Expected: FAIL — returns null (stub)

### Step 2: Implement transmuxer wiring

- [ ] **Replace ensureTransmuxed() stub with real implementation**

In `channelManager.js`, replace the stub at lines 401-410:

```javascript
async ensureTransmuxed(channel) {
  if (!channel.streamUrl) {
    this.logger.warn('No stream URL for transmuxing', { channelId: channel.id });
    return null;
  }

  try {
    const job = await this.transmuxer.ensureJob(
      channel.id,
      channel.streamUrl,
      channel.streamHeaders || {}
    );
    return job;
  } catch (error) {
    this.logger.error('Transmuxing failed', {
      channelId: channel.id,
      streamUrl: channel.streamUrl,
      error: error.message,
    });
    return null;
  }
}
```

- [ ] **Add `FFMPEG_MAX_CONCURRENT` to transmuxer.js**

Read `transmuxer.js` and add a concurrency check at the top of `ensureJob()`:

```javascript
const FFMPEG_MAX_CONCURRENT = parseInt(process.env.FFMPEG_MAX_CONCURRENT) || 3;

// In ensureJob(), before spawning:
const activeJobs = [...this.jobs.values()].filter(j => j.process && !j.process.killed);
if (activeJobs.length >= FFMPEG_MAX_CONCURRENT) {
  this.logger.warn('FFmpeg concurrency limit reached', {
    active: activeJobs.length,
    max: FFMPEG_MAX_CONCURRENT,
  });
  return null;
}
```

- [ ] **Run all tests**

Run: `cd /Volumes/containers/redcarrd && npx jest --no-coverage 2>&1 | tail -20`
Expected: All pass

- [ ] **Commit**

```bash
git add src/channelManager.js src/transmuxer.js src/__tests__/channelManager.test.js
git commit -m "Wire transmuxer fallback for non-HLS streams with concurrency limit"
```

---

## Task 5: Add stream URL TTL and proactive re-resolution

**Files:**
- Modify: `src/channelManager.js`
- Modify: `src/__tests__/channelManager.test.js`

### Step 1: Write failing test for TTL-based re-resolution

- [ ] **Add test for proactive re-resolution**

```javascript
describe('stream URL TTL', () => {
  test('should re-resolve when URL reaches 80% of TTL', async () => {
    const mockResolver = {
      resolve: jest.fn().mockResolvedValue({
        url: 'https://cdn.example.com/new-stream.m3u8',
        type: 'hls',
        headers: { Referer: 'https://embed.example.com' },
      }),
      close: jest.fn(),
    };
    channelManager.streamResolver = mockResolver;

    const channel = {
      id: 'test-1',
      embedUrl: 'https://embed.example.com/player/1',
      streamUrl: 'https://cdn.example.com/old-stream.m3u8',
      streamMode: 'hls',
      resolvedAt: Date.now() - (25 * 60 * 1000), // 25 min ago (past 80% of 30 min TTL)
    };

    const needsRefresh = channelManager.needsReResolution(channel);
    expect(needsRefresh).toBe(true);
  });

  test('should not re-resolve when URL is fresh', () => {
    const channel = {
      id: 'test-2',
      streamUrl: 'https://cdn.example.com/stream.m3u8',
      resolvedAt: Date.now() - (5 * 60 * 1000), // 5 min ago
    };

    const needsRefresh = channelManager.needsReResolution(channel);
    expect(needsRefresh).toBe(false);
  });
});
```

- [ ] **Run test to verify it fails**

Run: `cd /Volumes/containers/redcarrd && npx jest src/__tests__/channelManager.test.js --no-coverage -t "TTL" 2>&1 | tail -20`
Expected: FAIL — `needsReResolution is not a function`

### Step 2: Implement TTL logic

- [ ] **Add `needsReResolution()` and integrate into stream serving**

Add to `channelManager.js`:

```javascript
needsReResolution(channel) {
  if (!channel.resolvedAt || !channel.streamUrl) return true;
  const ttlMs = (parseInt(process.env.STREAM_URL_TTL_MINUTES) || 30) * 60 * 1000;
  const age = Date.now() - channel.resolvedAt;
  return age > ttlMs * 0.8; // Re-resolve at 80% of TTL
}
```

Add re-resolution trigger when serving HLS manifests. In the HLS proxy handler (when fetching upstream manifest), check `needsReResolution()` and trigger background re-resolution:

```javascript
// In the manifest fetch path:
if (this.needsReResolution(channel)) {
  // Background re-resolution — don't block the current request
  this.resolveStream(channel).catch(err =>
    this.logger.warn('Background re-resolution failed', { channelId: channel.id, error: err.message })
  );
}
```

Also add re-resolution on 403/410 response from upstream:

```javascript
// When upstream returns 403 or 410:
if (response.status === 403 || response.status === 410) {
  this.logger.warn('Upstream rejected request, re-resolving', { channelId: channel.id, status: response.status });
  await this.resolveStream(channel);
  // Retry with new URL
}
```

- [ ] **Add channel-level cooldown**

```javascript
// In resolveStream():
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
if (channel.lastResolutionAttempt && Date.now() - channel.lastResolutionAttempt < COOLDOWN_MS) {
  this.logger.warn('Resolution cooldown active', { channelId: channel.id });
  return;
}
channel.lastResolutionAttempt = Date.now();
```

- [ ] **Run all tests**

Run: `cd /Volumes/containers/redcarrd && npx jest --no-coverage 2>&1 | tail -20`
Expected: All pass

- [ ] **Commit**

```bash
git add src/channelManager.js src/__tests__/channelManager.test.js
git commit -m "Add stream URL TTL with proactive re-resolution and cooldown"
```

---

## Task 6: Simplify `server.js` stream routing

Change from 3-way routing (restream/hls/transmux) to 2-way (hls/transmux).

**Files:**
- Modify: `src/server.js:278-355` (stream routing)

### Step 1: Write failing test for simplified routing

- [ ] **Verify current routing behavior in existing tests, then update**

Read existing server tests (if any — check `src/__tests__/` for server-related tests). The routing changes are:
- Remove `isRestreamChannel` branch at line 284
- `channel.streamMode === 'hls'` → HLS proxy path (existing `handleHlsResponse`)
- `channel.streamMode === 'transmux'` → transmuxed manifest path
- Remove `serveRestreamedManifest()` function

### Step 2: Simplify routing

- [ ] **Update `GET /hls/:id` route**

Replace `server.js:278-293`:

Note: Use the correct method names from the actual codebase:
- Channel lookup: `channelManager.getChannelById()` (line 281), NOT `findChannelById`
- HLS handler: `handleHlsResponse(req, res, targetUrl, channel, isRootManifest)` (line 202) — requires the full signature with `targetUrl` and `isRootManifest` params

```javascript
app.get('/hls/:id', async (req, res) => {
  const channel = channelManager.getChannelById(req.params.id);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  if (channel.streamMode === 'transmux') {
    return serveTransmuxedManifest(req, res, channel);
  }

  // Default: HLS proxy — pass the resolved stream URL
  return handleHlsResponse(req, res, channel.streamUrl, channel, true);
});
```

- [ ] **Remove `serveRestreamedManifest()` function and `isRestreamChannel` references**

Search for and remove all references to:
- `serveRestreamedManifest`
- `isRestreamChannel`
- Any local manifest serving from StreamManager work directories

- [ ] **Update segment proxy route**

In `GET /hls/:id/proxy` (lines 295-319), remove the restream channel block (line 303). Transmuxed channels still use `/hls/:id/local/:segment` for local segments.

- [ ] **Run all tests**

Run: `cd /Volumes/containers/redcarrd && npx jest --no-coverage 2>&1 | tail -20`
Expected: All pass

- [ ] **Commit**

```bash
git add src/server.js
git commit -m "Simplify stream routing from 3-way to 2-way (hls/transmux)"
```

---

## Task 7: Clean up tests and remove old modules

Remove test files for deleted modules FIRST, then delete the source files. This ordering prevents broken imports in the test suite.

**Files:**
- Remove: `src/__tests__/restreamer.test.js` (tests old Restreamer class)
- Remove: `src/streaming/StreamManager.js`
- Remove: `src/streaming/BrowserStreamCapture.js`
- Remove: `src/streaming/FFmpegProcessManager.js`
- Remove: `src/streaming/StreamPipeline.js`
- Remove: `src/restream.js`
- Remove: `src/restreamer.js`

### Step 1: Clean up stale tests first

- [ ] **Check what `restreamer.test.js` tests**

Read `src/__tests__/restreamer.test.js` (50 lines). If it only tests the old Restreamer class, delete it. If it tests job management patterns that are still relevant, refactor to test the new flow.

- [ ] **Remove stale test file and any stale imports in other test files**

```bash
# If purely testing old Restreamer:
rm src/__tests__/restreamer.test.js
```

Search all remaining test files for references to removed modules:
```bash
grep -r "require.*restream\|require.*streaming\|StreamManager\|Restreamer" src/__tests__/ --include="*.js"
```

Fix any remaining references.

- [ ] **Verify tests pass before removing source files**

Run: `cd /Volumes/containers/redcarrd && npx jest --no-coverage 2>&1 | tail -20`
Expected: All pass

### Step 2: Verify no remaining source references and remove files

- [ ] **Search for imports of modules to be removed**

```bash
grep -r "require.*streaming" src/ --include="*.js" | grep -v node_modules | grep -v __tests__ | grep -v streaming/
grep -r "require.*restream" src/ --include="*.js" | grep -v node_modules | grep -v __tests__
grep -r "StreamManager\|StreamPipeline\|BrowserStreamCapture\|FFmpegProcessManager\|Restreamer" src/ --include="*.js" | grep -v node_modules | grep -v __tests__ | grep -v streaming/ | grep -v restreamer.js | grep -v restream.js
```

Expected: No references. If any remain, fix them first.

- [ ] **Delete old streaming modules and worker files**

```bash
rm -rf src/streaming/
rm src/restream.js
rm src/restreamer.js
```

- [ ] **Run all tests to verify nothing breaks**

Run: `cd /Volumes/containers/redcarrd && npx jest --no-coverage 2>&1 | tail -20`
Expected: All pass

- [ ] **Commit**

```bash
git add -A
git commit -m "Remove CDP video capture modules, old restream worker, and stale tests"
```

---

## Task 8: Update Dockerfile and documentation

**Files:**
- Modify: `Dockerfile` (if needed — verify FFmpeg and Playwright are still required)
- Modify: `CLAUDE.md` (update module responsibilities, remove streaming/ references)

### Step 1: Verify Dockerfile

- [ ] **Read Dockerfile and check if any changes needed**

The Dockerfile should still use the Playwright base image (for browser automation in streamResolver). FFmpeg is still needed for transmuxer fallback. Likely no changes needed, but verify.

### Step 2: Update CLAUDE.md

- [ ] **Update codebase structure section**

Remove references to:
- `src/streaming/` directory (4 files)
- `src/restream.js`
- `src/restreamer.js`

Add references to:
- `src/streamResolver.js` — Stream URL detection via Playwright
- `src/embedResolver.js` — Embed URL extraction (split from scraper)

Update module responsibilities for `channelManager.js` and `server.js`.

- [ ] **Commit**

```bash
git add Dockerfile CLAUDE.md
git commit -m "Update documentation to reflect stream resolution redesign"
```

---

## Task 9: End-to-end smoke test

**Files:**
- No new files — manual verification

### Step 1: Local smoke test

- [ ] **Start the server and verify basic flow**

```bash
cd /Volumes/containers/redcarrd && npm start
```

In another terminal:
```bash
# Check server responds
curl -s http://localhost:3005/api/config | head -5

# Trigger a rebuild
curl -s -X POST http://localhost:3005/api/rebuild

# Wait for rebuild, then check playlist
sleep 30
curl -s http://localhost:3005/playlist.m3u8 | head -20
```

- [ ] **Verify a channel stream works**

If channels are available in the playlist, try loading one in an IPTV client or VLC to verify HLS proxying works end-to-end.

- [ ] **Check logs for errors**

```bash
curl -s http://localhost:3005/api/logs | jq '.[0:10]'
```

Look for resolution successes/failures, any unhandled errors.

- [ ] **Final commit if any fixes needed**

```bash
git add -A
git commit -m "Fix issues found during smoke testing"
```
