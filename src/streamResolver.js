'use strict';

const { chromium } = require('playwright');

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
];

const PLAYWRIGHT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-notifications',
  '--mute-audio',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-blink-features=AutomationControlled',
  '--disable-site-isolation-trials',
];

/**
 * URL patterns considered ad/tracking that should be ignored during detection.
 */
const AD_URL_PATTERNS = [
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
  /googleadservices\.com/i,
  /facebook\.com\/tr/i,
  /analytics/i,
  /adserver/i,
  /tracking/i,
  /pixel/i,
  /beacon/i,
  /\/ads\//i,
  /\/ad\//i,
  /popunder/i,
  /popads/i,
  /vastserv/i,
  /prebid/i,
];

/**
 * URL patterns for known non-stream MP4 content (promo videos, venue content, etc.)
 * that should be ignored during stream detection.
 */
const NON_STREAM_MP4_PATTERNS = [
  /cosm-cdn\.io/i,
  /promo/i,
  /trailer/i,
  /preview/i,
  /placeholder/i,
  /venue[_-]?events/i,
  /category[_-]?video/i,
  /assets.*\.mp4/i,
];

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function randomDesktopViewport() {
  const widths = [1280, 1366, 1440, 1536, 1920];
  const width = widths[Math.floor(Math.random() * widths.length)];
  const height = Math.floor(width * (9 / 16) + Math.random() * 60);
  return { width, height };
}

function isAdUrl(url) {
  return AD_URL_PATTERNS.some((pattern) => pattern.test(url));
}

function isNonStreamMp4(url) {
  return NON_STREAM_MP4_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Grace period (ms) to wait for HLS/DASH after first MP4 detection before
 * accepting the MP4 as the stream URL.
 */
const MP4_GRACE_PERIOD_MS = parseInt(process.env.MP4_GRACE_PERIOD_MS, 10) || 5000;

/**
 * Anti-detection init script injected into every browser context.
 * Overrides webdriver property, spoofs plugins, disables popups, etc.
 */
const ANTI_DETECTION_SCRIPT = () => {
  // Block popups
  window.open = () => null;

  // Hide webdriver property (primary headless signal)
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Spoof languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // Spoof plugins as realistic PluginArray-like object
  const pluginData = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
  ];
  const pluginArray = Object.create(PluginArray.prototype);
  pluginData.forEach((p, i) => {
    const plugin = Object.create(Plugin.prototype);
    Object.defineProperties(plugin, {
      name: { get: () => p.name },
      filename: { get: () => p.filename },
      description: { get: () => p.description },
      length: { get: () => 0 },
    });
    Object.defineProperty(pluginArray, i, { get: () => plugin });
  });
  Object.defineProperty(pluginArray, 'length', { get: () => pluginData.length });
  Object.defineProperty(pluginArray, 'namedItem', {
    value: (name) => pluginData.find((p) => p.name === name) || null,
  });
  Object.defineProperty(pluginArray, 'item', {
    value: (index) => pluginArray[index] || null,
  });
  Object.defineProperty(navigator, 'plugins', { get: () => pluginArray });

  // Spoof hardware fingerprints
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

  // Chrome runtime object
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.loadTimes = window.chrome.loadTimes || (() => ({}));
  window.chrome.csi = window.chrome.csi || (() => ({}));

  // Remove Playwright/CDP-specific properties from window
  const cdcKeys = Object.keys(window).filter(
    (key) => /^cdc_|^__playwright|^__pwPage/.test(key)
  );
  cdcKeys.forEach((key) => { try { delete window[key]; } catch (_) {} });

  // Override User-Agent Client Hints API
  if (navigator.userAgentData) {
    const brandOverrides = [
      { brand: 'Google Chrome', version: '131' },
      { brand: 'Chromium', version: '131' },
      { brand: 'Not_A Brand', version: '24' },
    ];
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands: brandOverrides,
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: () =>
          Promise.resolve({
            brands: brandOverrides,
            mobile: false,
            platform: 'Windows',
            platformVersion: '15.0.0',
            architecture: 'x86',
            model: '',
            uaFullVersion: '131.0.0.0',
            fullVersionList: brandOverrides.map((b) => ({
              brand: b.brand,
              version: b.version + '.0.0.0',
            })),
          }),
      }),
    });
  }

  // Permissions API
  const originalQuery = window.navigator.permissions?.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters?.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : originalQuery(parameters);
  }

  // WebGL vendor/renderer spoofing to mask headless GPU
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return 'Google Inc. (Intel)';
    if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)';
    return getParameter.call(this, param);
  };
  const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return 'Google Inc. (Intel)';
    if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)';
    return getParameter2.call(this, param);
  };

  // Intercept HLS.js loadSource to capture stream URL
  // WASM-based players load HLS.js dynamically; this patches it when it appears
  if (!('__capturedStreamUrl' in window)) {
    Object.defineProperty(window, '__capturedStreamUrl', { value: null, writable: true });
  }
  let _hlsPatched = false;
  const _hlsObserver = new MutationObserver(() => {
    if (!_hlsPatched && window.Hls && window.Hls.prototype) {
      _hlsPatched = true;
      _hlsObserver.disconnect();
      const origLoadSource = window.Hls.prototype.loadSource;
      window.Hls.prototype.loadSource = function(src) {
        if (src && typeof src === 'string') {
          window.__capturedStreamUrl = src;
        }
        return origLoadSource.call(this, src);
      };
    }
  });
  _hlsObserver.observe(document.documentElement, { childList: true, subtree: true });
};

/**
 * StreamResolver — Detects stream URLs from embed pages using Playwright.
 *
 * Manages a shared browser instance with idle timeout, creates short-lived
 * contexts per resolve() call, and uses network interception + player config
 * fallback to find HLS/DASH/MP4 stream URLs.
 */
class StreamResolver {
  constructor({ logger } = {}) {
    this.logger = logger || console;
    this._browser = null;
    this._idleTimer = null;
    this._launching = null;

    this.detectTimeoutMs = parseInt(process.env.STREAM_DETECT_TIMEOUT_MS, 10) || 45000;
    this.maxAttempts = Math.max(1, parseInt(process.env.RESTREAM_MAX_ATTEMPTS, 10) || 4);
    this.enableConfigFallback = parseBooleanEnv(process.env.RESTREAM_DETECT_CONFIG_FALLBACK, true);
    this.browserIdleTimeoutMinutes = parseInt(process.env.BROWSER_IDLE_TIMEOUT_MINUTES, 10) || 60;
  }

  /**
   * Get or launch the shared browser instance.
   */
  async _getBrowser() {
    if (this._browser?.isConnected()) {
      this._resetIdleTimer();
      return this._browser;
    }

    // Prevent concurrent launches
    if (this._launching) {
      return this._launching;
    }

    this._launching = (async () => {
      try {
        this.logger.info('Launching shared Playwright browser');
        this._browser = await chromium.launch({
          headless: true,
          args: PLAYWRIGHT_LAUNCH_ARGS,
        });

        this._browser.on('disconnected', () => {
          this.logger.warn('Browser disconnected unexpectedly');
          this._browser = null;
          this._clearIdleTimer();
        });

        this._resetIdleTimer();
        return this._browser;
      } finally {
        this._launching = null;
      }
    })();

    return this._launching;
  }

  _resetIdleTimer() {
    this._clearIdleTimer();
    const idleMs = this.browserIdleTimeoutMinutes * 60 * 1000;
    this._idleTimer = setTimeout(() => {
      this.logger.info('Browser idle timeout reached; closing');
      this.closeBrowser();
    }, idleMs);
    // Don't keep the process alive just for the idle timer
    if (this._idleTimer?.unref) {
      this._idleTimer.unref();
    }
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /**
   * Close the shared browser instance.
   */
  async closeBrowser() {
    this._clearIdleTimer();
    if (this._browser) {
      try {
        await this._browser.close();
      } catch (error) {
        this.logger.warn('Error closing browser', { error: error.message });
      }
      this._browser = null;
    }
  }

  /**
   * Resolve a stream URL from an embed page.
   *
   * @param {string} embedUrl - The embed page URL to detect streams from.
   * @param {Object} [options] - Options.
   * @param {Object} [options.solverCookies] - Pre-fetched solver cookies (normalized).
   * @param {number} [options.timeout] - Override detect timeout in ms.
   * @param {number} [options.maxAttempts] - Override max retry attempts.
   * @returns {Promise<{url: string, type: string, headers: Object}|null>}
   */
  async resolve(embedUrl, options = {}) {
    const timeout = options.timeout || this.detectTimeoutMs;
    const maxAttempts = options.maxAttempts || this.maxAttempts;
    const solverCookies = options.solverCookies || null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const userAgent = DEFAULT_USER_AGENTS[attempt % DEFAULT_USER_AGENTS.length];

      try {
        const result = await this._resolveWithContext(embedUrl, {
          userAgent,
          timeout,
          solverCookies,
          attempt,
        });

        if (result) {
          return result;
        }
      } catch (error) {
        this.logger.warn('Stream detection attempt failed', {
          attempt: attempt + 1,
          maxAttempts,
          embedUrl,
          error: error.message,
        });
      }
    }

    this.logger.error('All stream detection attempts exhausted', { embedUrl, maxAttempts });
    return null;
  }

  /**
   * Single detection attempt within a fresh browser context.
   */
  async _resolveWithContext(embedUrl, { userAgent, timeout, solverCookies, attempt }) {
    const browser = await this._getBrowser();
    const viewport = randomDesktopViewport();
    let context = null;

    try {
      // Derive referer/origin from embed URL
      let referer;
      let origin;
      try {
        const parsed = new URL(embedUrl);
        referer = embedUrl;
        origin = parsed.origin;
      } catch (_) {
        referer = embedUrl;
        origin = undefined;
      }

      // Extract Chrome version from user agent for consistent Client Hints
      const chromeVersionMatch = userAgent.match(/Chrome\/(\d+)/);
      const chromeVersion = chromeVersionMatch ? chromeVersionMatch[1] : '131';

      context = await browser.newContext({
        userAgent,
        viewport,
        ignoreHTTPSErrors: true,
        bypassCSP: true,
        locale: 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          // Override sec-ch-ua headers to mask HeadlessChrome
          'sec-ch-ua': `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not(A:Brand";v="24"`,
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
        },
      });

      // Apply solver cookies
      if (solverCookies?.length) {
        try {
          await context.addCookies(solverCookies);
        } catch (error) {
          this.logger.warn('Failed to apply solver cookies', { error: error.message });
        }
      }

      // Anti-detection init scripts
      await context.addInitScript(ANTI_DETECTION_SCRIPT);

      const page = await context.newPage();

      // Dismiss JS dialogs
      page.on('dialog', async (dialog) => {
        try {
          await dialog.dismiss();
        } catch (_) {}
      });

      // Close popup windows
      page.on('popup', async (popup) => {
        try {
          await popup.close();
        } catch (_) {}
      });

      // Navigate to embed page
      this.logger.info('Navigating to embed page', { embedUrl, attempt: attempt + 1 });
      await page.goto(embedUrl, {
        waitUntil: 'load',
        timeout: Math.min(timeout * 2, 90000),
      });

      // Extract inner embed iframe URL (the actual player page)
      const innerEmbedUrl = await page.evaluate(() => {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          const src = iframe.src || '';
          if (src && !src.includes('ad.') && !src.includes('ads.') && !src.includes('google') && !src.includes('about:blank')) {
            return src;
          }
        }
        return null;
      }).catch(() => null);

      // If there's an inner embed iframe, navigate directly to it
      // This avoids nested cross-origin iframe issues that block request interception
      if (innerEmbedUrl) {
        this.logger.info('Found inner embed iframe, navigating directly', { innerEmbedUrl, parentUrl: embedUrl });
        await page.goto(innerEmbedUrl, {
          waitUntil: 'load',
          timeout: Math.min(timeout, 30000),
          referer: embedUrl,
        });
      }

      // Wait for WASM/scripts to initialize after page load
      await page.waitForTimeout(2000);

      // Start network detection
      const streamUrlPromise = this._waitForStreamUrl(page, timeout, {
        enableConfigFallback: this.enableConfigFallback,
      });

      // Wait for iframes to load, then activate the player
      await this._waitForIframes(page, timeout);
      await this._activatePlayer(page);

      const streamInfo = await streamUrlPromise;

      if (!streamInfo) {
        return null;
      }

      // Use the actual page URL as Referer — after iframe navigation this may differ from embedUrl
      const actualPageUrl = page.url();
      let streamReferer;
      try {
        streamReferer = new URL(actualPageUrl).origin !== 'null' ? actualPageUrl : embedUrl;
      } catch (_) {
        streamReferer = embedUrl;
      }

      // Collect ALL cookies from the browser context — embed pages set critical
      // auth cookies on their own domain that must be forwarded to the CDN
      const cookies = await context.cookies().catch(() => []);
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

      const headers = {
        Referer: streamReferer,
        Origin: (() => { try { return new URL(streamReferer).origin; } catch (_) { return undefined; } })(),
        'User-Agent': userAgent,
      };
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }

      this.logger.info('Stream URL detected', {
        type: streamInfo.type,
        url: streamInfo.url,
        attempt: attempt + 1,
      });

      return {
        url: streamInfo.url,
        type: streamInfo.type,
        headers,
      };
    } finally {
      if (context) {
        try {
          await context.close();
        } catch (_) {}
      }
    }
  }

  /**
   * Listen for stream URLs in network traffic, with optional player config fallback.
   *
   * Prioritizes HLS > DASH > MP4. Filters out ad/tracking URLs.
   */
  _waitForStreamUrl(page, timeoutMs, options = {}) {
    const { enableConfigFallback = false } = options;

    return new Promise((resolve, reject) => {
      let done = false;
      let lastConfigError = null;
      let mp4Candidate = null;
      let mp4GraceTimer = null;
      const mediaRequests = []; // diagnostic: track media-related requests

      const finish = (err, info) => {
        if (done) return;
        done = true;
        page.removeListener('request', onRequest);
        page.removeListener('response', onResponse);
        clearTimeout(timer);
        if (mp4GraceTimer) clearTimeout(mp4GraceTimer);
        // Log what we saw during detection
        if (err && mediaRequests.length) {
          this.logger.debug('Media requests seen during detection', { requests: mediaRequests.slice(0, 20) });
        }
        if (err) return reject(err);
        resolve(info);
      };

      const acceptMp4Candidate = () => {
        if (mp4Candidate && !done) {
          this.logger.info('Accepting MP4 candidate after grace period', { url: mp4Candidate.url });
          finish(null, mp4Candidate);
        }
      };

      const timer = setTimeout(async () => {
        if (mp4Candidate) {
          this.logger.info('Timeout reached with MP4 candidate available, accepting it');
          finish(null, mp4Candidate);
          return;
        }

        if (enableConfigFallback) {
          try {
            this.logger.warn('Network sniff timed out; attempting config fallback');
            const fallbackInfo = await this._detectFromPlayerConfig(page);
            if (fallbackInfo) {
              this.logger.info('Located stream via player configuration fallback');
              finish(null, fallbackInfo);
              return;
            }
          } catch (error) {
            lastConfigError = error;
          }
        }

        const timeoutMessage = lastConfigError
          ? `Timed out waiting for stream URL (config fallback failed: ${lastConfigError.message})`
          : 'Timed out waiting for stream URL';
        finish(new Error(timeoutMessage));
      }, timeoutMs);

      const onRequest = (request) => {
        try {
          const url = request.url();
          if (isAdUrl(url)) return;

          const resourceType = request.resourceType();
          // Track media/XHR/fetch requests for diagnostics
          if (['media', 'xhr', 'fetch', 'other'].includes(resourceType)) {
            mediaRequests.push({ url: url.substring(0, 200), type: resourceType });
          }

          if (/\.m3u8(\?|$)/i.test(url)) {
            finish(null, { type: 'hls', url });
          } else if (/\.mpd(\?|$)/i.test(url)) {
            finish(null, { type: 'dash', url });
          } else if (/\.(mp4)(\?|$)/i.test(url)) {
            if (isNonStreamMp4(url)) {
              this.logger.debug('Ignoring non-stream MP4', { url });
              return;
            }
            if (!mp4Candidate) {
              mp4Candidate = { type: 'mp4', url };
              this.logger.debug('MP4 candidate detected, waiting for HLS/DASH', { url });
              mp4GraceTimer = setTimeout(acceptMp4Candidate, MP4_GRACE_PERIOD_MS);
            }
          }
        } catch (_) {}
      };

      // Detect HLS/DASH via response content-type, body, or embedded URLs in JSON responses
      const onResponse = (response) => {
        try {
          const url = response.url();
          if (isAdUrl(url)) return;

          const contentType = (response.headers()['content-type'] || '').toLowerCase();
          const status = response.status();

          // Detect via content-type
          if (/mpegurl/i.test(contentType)) {
            finish(null, { type: 'hls', url });
            return;
          }
          if (/dash\+xml/i.test(contentType)) {
            finish(null, { type: 'dash', url });
            return;
          }

          // Skip JavaScript/CSS files — they contain player code with HLS strings but aren't streams
          if (/javascript|css/i.test(contentType) || /\.(js|css)(\?|$)/i.test(url)) {
            return;
          }

          // For XHR/fetch/JSON/text responses, inspect the body for stream URLs
          // This catches APIs like embedsports.top/fetch that return stream URLs in JSON
          if (status >= 200 && status < 300 && /json|text|html/i.test(contentType)) {
            response.text().then((body) => {
              if (!body || done) return;

              // Log embed-server API responses for diagnostics
              if (/\/fetch\b/i.test(url)) {
                this.logger.debug('Embed API response', {
                  url: url.substring(0, 200),
                  bodyPreview: body.substring(0, 500),
                });
              }

              // Scan for stream URLs in the response body
              const m3u8Match = body.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i);
              if (m3u8Match) {
                this.logger.info('HLS URL found in API response', { url: url.substring(0, 200), streamUrl: m3u8Match[0] });
                finish(null, { type: 'hls', url: m3u8Match[0] });
                return;
              }

              const mpdMatch = body.match(/https?:\/\/[^\s"'<>\\]+\.mpd[^\s"'<>\\]*/i);
              if (mpdMatch) {
                this.logger.info('DASH URL found in API response', { url: url.substring(0, 200), streamUrl: mpdMatch[0] });
                finish(null, { type: 'dash', url: mpdMatch[0] });
                return;
              }

              // Check for HLS manifest content — must start with #EXTM3U (not buried in JS)
              if (/^\s*#EXTM3U/i.test(body)) {
                this.logger.info('HLS manifest found in response body', { url: url.substring(0, 200) });
                finish(null, { type: 'hls', url });
                return;
              }
            }).catch(() => {});
          }

          // Detect via URL patterns that don't use file extensions
          if (/\/(hls|live|stream|playlist)\//i.test(url) && !isAdUrl(url)) {
            if (status >= 200 && status < 300) {
              response.text().then((body) => {
                if (body && /^\s*#EXTM3U/i.test(body)) {
                  this.logger.info('HLS detected via response body inspection', { url: url.substring(0, 200) });
                  finish(null, { type: 'hls', url });
                }
              }).catch(() => {});
            }
          }
        } catch (_) {}
      };

      page.on('request', onRequest);
      page.on('response', onResponse);
    });
  }

  /**
   * Fall back to inspecting player configuration (JWPlayer, HTML5 video elements).
   */
  async _detectFromPlayerConfig(page) {
    const info = await page.evaluate(() => {
      // Check for HLS.js-intercepted URL first (set by ANTI_DETECTION_SCRIPT)
      if (window.__capturedStreamUrl) {
        const url = window.__capturedStreamUrl;
        const type = /\.m3u8(\?|$)/i.test(url) ? 'hls'
          : /\.mpd(\?|$)/i.test(url) ? 'dash' : 'mp4';
        return { url, type };
      }

      function inferType(url, mime) {
        if (!url && !mime) return null;
        const target = (url || '').toLowerCase();
        const mimeType = (mime || '').toLowerCase();

        if (/\.m3u8(\?|$)/i.test(target) || mimeType.includes('application/vnd.apple.mpegurl')) {
          return 'hls';
        }
        if (/\.mpd(\?|$)/i.test(target) || mimeType.includes('dash')) {
          return 'dash';
        }
        if (/\.mp4(\?|$)/i.test(target) || mimeType.includes('mp4')) {
          return 'mp4';
        }
        return null;
      }

      function normalizeCandidate(url, mime) {
        if (!url) return null;
        const type = inferType(url, mime);
        return { url, type: type || 'mp4' };
      }

      const candidates = [];

      // HLS.js instance inspection
      if (typeof window.Hls !== 'undefined') {
        try {
          // Check for attached HLS.js instances on video elements
          document.querySelectorAll('video').forEach((vid) => {
            // HLS.js stores reference on the media element or global
            if (vid._hlsPlayer?.url) {
              candidates.push({ url: vid._hlsPlayer.url, type: 'hls' });
            }
          });
          // Check global Hls instances — some players store them on window
          for (const key of Object.keys(window)) {
            try {
              const obj = window[key];
              if (obj && obj.constructor?.name === 'Hls' && typeof obj.url === 'string' && obj.url) {
                candidates.push({ url: obj.url, type: 'hls' });
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      // Clappr player inspection
      if (typeof window.player !== 'undefined') {
        try {
          const src = window.player?.options?.source || window.player?.options?.src;
          if (src) {
            const candidate = normalizeCandidate(src);
            if (candidate) candidates.push(candidate);
          }
        } catch (_) {}
      }

      // JWPlayer playlist inspection
      if (typeof window.jwplayer === 'function') {
        try {
          const playerInstance = window.jwplayer();
          if (playerInstance && typeof playerInstance.getPlaylist === 'function') {
            const playlist = playerInstance.getPlaylist() || [];
            playlist.forEach((item) => {
              if (item.file) {
                const candidate = normalizeCandidate(item.file, item.type);
                if (candidate) candidates.push(candidate);
              }
              (item.sources || []).forEach((source) => {
                const candidate = normalizeCandidate(source.file, source.type);
                if (candidate) candidates.push(candidate);
              });
            });
          }
        } catch (_) {}
      }

      // HTML5 video elements
      document.querySelectorAll('video').forEach((vid) => {
        const current = normalizeCandidate(vid.currentSrc || vid.src, vid.type || vid.currentType);
        if (current) candidates.push(current);
        vid.querySelectorAll('source').forEach((source) => {
          const candidate = normalizeCandidate(source.src, source.type);
          if (candidate) candidates.push(candidate);
        });
      });

      return candidates.find((c) => c.type !== 'mp4') || candidates[0] || null;
    });

    return info;
  }

  /**
   * Wait for embed iframes to load.
   */
  async _waitForIframes(page, timeout) {
    // Give page scripts a moment to set up iframes
    await page.waitForTimeout(2000);

    // Find embed iframes (skip ad iframes)
    const iframeSrcs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe'))
        .map((f) => f.src || '')
        .filter((src) => src && !src.includes('ad.') && !src.includes('ads.') && !src.includes('google'));
    });

    if (iframeSrcs.length) {
      this.logger.debug('Waiting for embed iframes to load', { iframeSrcs });

      for (const src of iframeSrcs) {
        try {
          const frameLoadTimeout = Math.min(timeout / 2, 10000);
          await page.waitForFunction(
            (targetSrc) => {
              const iframes = document.querySelectorAll('iframe');
              for (const iframe of iframes) {
                if (iframe.src === targetSrc && iframe.contentWindow) {
                  return true;
                }
              }
              return false;
            },
            src,
            { timeout: frameLoadTimeout },
          ).catch(() => {});

          await page.waitForTimeout(1000);
        } catch (_) {}
      }

      const frames = page.frames();
      const loadedFrames = frames.map((f) => ({ url: f.url(), name: f.name() })).filter((f) => f.url);
      this.logger.debug('Frames after wait', { count: frames.length, loaded: loadedFrames });
    }
  }

  /**
   * Attempt to activate the video player using multiple strategies.
   * WASM-based players use custom play buttons that don't match standard selectors.
   *
   * Many embed sites use ad-gated playback: the first click opens a popup ad
   * (which we suppress), and only the second click actually starts the player.
   * We click the center of the viewport multiple times with delays to handle this.
   */
  async _activatePlayer(page) {
    // Log page state for diagnostics
    const pageState = await page.evaluate(() => {
      try {
        return {
          videos: document.querySelectorAll('video').length,
          canvases: document.querySelectorAll('canvas').length,
          iframes: document.querySelectorAll('iframe').length,
          buttons: document.querySelectorAll('button').length,
          title: document.title?.substring(0, 80),
          bodyClasses: document.body?.className?.substring(0, 100),
          hasHls: typeof window.Hls !== 'undefined',
          hasCapturedUrl: Boolean(window.__capturedStreamUrl),
        };
      } catch (_) { return {}; }
    }).catch(() => ({}));
    this.logger.debug('Page state before activation', pageState);

    // --- Phase 1: Initial click burst (handle ad-gated playback) ---
    // Many WASM players require multiple clicks: first click opens a suppressed
    // popup ad, subsequent clicks activate the actual player.
    const viewport = page.viewportSize() || { width: 1280, height: 720 };
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;

    for (let clickRound = 0; clickRound < 3; clickRound++) {
      // Click center of viewport
      try {
        await page.mouse.click(cx, cy);
      } catch (_) {}

      // Brief pause — let the page react (popup opens & gets suppressed, overlay removed, etc.)
      await page.waitForTimeout(1500);

      // Dismiss any popups/overlays that appeared
      await page.evaluate(() => {
        try {
          // Remove common ad/overlay elements that may block the player
          document.querySelectorAll(
            '[class*="overlay"], [class*="popup"], [class*="modal"], [id*="overlay"], [id*="popup"]'
          ).forEach((el) => {
            const style = window.getComputedStyle(el);
            if (style.position === 'fixed' || style.position === 'absolute') {
              el.remove();
            }
          });
        } catch (_) {}
      }).catch(() => {});
    }

    // --- Phase 2: Targeted element clicks ---
    // Programmatic video play
    await page.evaluate(() => {
      try {
        const video = document.querySelector('video');
        if (video) {
          video.muted = true;
          const p = video.play();
          if (p && p.catch) p.catch(() => {});
        }
      } catch (_) {}
    }).catch(() => {});

    // Click the largest video or canvas element
    await page.evaluate(() => {
      try {
        const elements = [...document.querySelectorAll('video, canvas, [class*="player"]')];
        if (!elements.length) return;
        elements.sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return (bRect.width * bRect.height) - (aRect.width * aRect.height);
        });
        const target = elements[0];
        const rect = target.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          target.click();
          target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        }
      } catch (_) {}
    }).catch(() => {});

    await page.waitForTimeout(1000);

    // --- Phase 3: Specific selectors & keyboard ---
    const playSelectors = [
      '.play-button', '.vjs-big-play-button', '[aria-label="Play"]',
      'button.play', '.jw-icon-display', '.btn-play', '.play-icon',
      '.player-poster', '[class*="play"]', '#play', '.overlay',
    ];

    for (const selector of playSelectors) {
      try {
        const el = await page.$(selector);
        if (el) {
          await el.click({ timeout: 1000 }).catch(() => {});
        }
      } catch (_) {}
    }

    try {
      await page.keyboard.press('Space');
      await page.keyboard.press('Enter');
    } catch (_) {}

    // --- Phase 4: Sub-frame activation ---
    const allFrames = page.frames();
    for (const frame of allFrames) {
      try {
        await frame.evaluate(() => {
          try {
            const vid = document.querySelector('video');
            if (vid) {
              vid.muted = true;
              const p = vid.play();
              if (p && p.catch) p.catch(() => {});
            }
            document.querySelectorAll(
              '.play-button, .vjs-big-play-button, [aria-label="Play"], button.play, .jw-icon-display, [class*="play"]'
            ).forEach((btn) => { try { btn.click(); } catch (_) {} });
          } catch (_) {}
        }).catch(() => {});
      } catch (_) {}
    }

    // --- Phase 5: Final click burst after player may have initialized ---
    await page.waitForTimeout(2000);

    // One more round of clicks after the player has had time to fully init
    try { await page.mouse.click(cx, cy); } catch (_) {}
    await page.waitForTimeout(1000);
    try { await page.mouse.click(cx, cy); } catch (_) {}

    // Log post-activation state
    const postState = await page.evaluate(() => {
      try {
        return {
          videos: document.querySelectorAll('video').length,
          videoSrc: document.querySelector('video')?.src?.substring(0, 100) || '',
          videoCurrentSrc: document.querySelector('video')?.currentSrc?.substring(0, 100) || '',
          hasHls: typeof window.Hls !== 'undefined',
          hasCapturedUrl: Boolean(window.__capturedStreamUrl),
          capturedUrl: window.__capturedStreamUrl?.substring(0, 100) || '',
        };
      } catch (_) { return {}; }
    }).catch(() => ({}));
    this.logger.debug('Page state after activation', postState);

    // Final wait for stream fetch to happen
    await page.waitForTimeout(2000);
  }
}

module.exports = {
  StreamResolver,
  // Exported for testing
  isAdUrl,
  isNonStreamMp4,
  AD_URL_PATTERNS,
  NON_STREAM_MP4_PATTERNS,
  DEFAULT_USER_AGENTS,
  PLAYWRIGHT_LAUNCH_ARGS,
  ANTI_DETECTION_SCRIPT,
  MP4_GRACE_PERIOD_MS,
};
