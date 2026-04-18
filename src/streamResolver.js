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
