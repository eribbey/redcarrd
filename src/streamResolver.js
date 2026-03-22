'use strict';

const { chromium } = require('playwright');

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

const PLAYWRIGHT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-notifications',
  '--mute-audio',
  '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
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

/**
 * Anti-detection init script injected into every browser context.
 * Overrides webdriver property, spoofs plugins, disables popups, etc.
 */
const ANTI_DETECTION_SCRIPT = () => {
  window.open = () => null;
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4] });
  window.chrome = window.chrome || { runtime: {} };
  const originalQuery = window.navigator.permissions?.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters?.name === 'notifications'
        ? Promise.resolve({ state: 'denied' })
        : originalQuery(parameters);
  }
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

    this.detectTimeoutMs = parseInt(process.env.STREAM_DETECT_TIMEOUT_MS, 10) || 20000;
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

      context = await browser.newContext({
        userAgent,
        viewport,
        ignoreHTTPSErrors: true,
        bypassCSP: true,
        locale: 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          ...(referer ? { Referer: referer } : {}),
          ...(origin ? { Origin: origin } : {}),
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
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeout * 2, 90000),
      });

      // Start network detection and autoplay in parallel
      const streamUrlPromise = this._waitForStreamUrl(page, timeout, {
        enableConfigFallback: this.enableConfigFallback,
      });

      await this._autoplayVideo(page);

      const streamInfo = await streamUrlPromise;

      if (!streamInfo) {
        return null;
      }

      // Collect cookies for the detected stream URL
      const cookies = await context.cookies(streamInfo.url).catch(() => []);
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

      const headers = {
        Referer: embedUrl,
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

      const finish = (err, info) => {
        if (done) return;
        done = true;
        page.removeListener('response', onResponse);
        clearTimeout(timer);
        if (err) return reject(err);
        resolve(info);
      };

      const timer = setTimeout(async () => {
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

      function onResponse(response) {
        try {
          const status = response.status();
          if (status < 200 || status >= 400) return;

          const url = response.url();

          // Filter out ad/tracking URLs
          if (isAdUrl(url)) return;

          if (/\.m3u8(\?|$)/i.test(url)) {
            finish(null, { type: 'hls', url });
          } else if (/\.mpd(\?|$)/i.test(url)) {
            finish(null, { type: 'dash', url });
          } else if (/\.(mp4)(\?|$)/i.test(url)) {
            finish(null, { type: 'mp4', url });
          }
        } catch (_) {}
      }

      page.on('response', onResponse);
    });
  }

  /**
   * Fall back to inspecting player configuration (JWPlayer, HTML5 video elements).
   */
  async _detectFromPlayerConfig(page) {
    const info = await page.evaluate(() => {
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
   * Try to autoplay the video in the page by clicking play buttons
   * and calling play() on video elements.
   */
  async _autoplayVideo(page) {
    // Give page scripts a moment to set up the player
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      function tryPlay() {
        try {
          // HTML5 <video>
          const vid = document.querySelector('video');
          if (vid) {
            vid.muted = true;
            const p = vid.play();
            if (p && p.catch) p.catch(() => {});
          }

          // JWPlayer global API
          if (typeof window.jwplayer === 'function') {
            try {
              let player;
              try {
                player = window.jwplayer();
              } catch (_) {
                const jwElem =
                  document.querySelector('.jwplayer, [id^="jwplayer"], [id^="vplayer"]');
                if (jwElem) {
                  player = window.jwplayer(jwElem);
                }
              }
              if (player) {
                player.setMute(true);
                player.play();
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      tryPlay();
      document.body.addEventListener('click', tryPlay, { once: true });
      document.body.addEventListener('keydown', tryPlay, { once: true });
    });

    // Click common play button selectors
    const playSelectors = [
      '.play-button',
      '.vjs-big-play-button',
      '[aria-label="Play"]',
      'button.play',
      '.jw-icon-display',
    ];

    for (const selector of playSelectors) {
      try {
        const el = await page.$(selector);
        if (el) {
          await el.click({ timeout: 1000 }).catch(() => {});
        }
      } catch (_) {}
    }

    await page.waitForTimeout(3000);
  }
}

module.exports = {
  StreamResolver,
  // Exported for testing
  isAdUrl,
  AD_URL_PATTERNS,
  DEFAULT_USER_AGENTS,
  PLAYWRIGHT_LAUNCH_ARGS,
  ANTI_DETECTION_SCRIPT,
};
