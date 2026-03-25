'use strict';

// Mock Playwright before requiring the module under test
// Event handler store for mockPage.on — allows multiple event types to coexist
const _pageHandlers = {};
const mockPage = {
  goto: jest.fn().mockResolvedValue(null),
  on: jest.fn().mockImplementation((event, handler) => {
    if (!_pageHandlers[event]) _pageHandlers[event] = [];
    _pageHandlers[event].push(handler);
  }),
  removeListener: jest.fn(),
  $: jest.fn().mockResolvedValue(null),
  evaluate: jest.fn().mockResolvedValue(false),
  waitForTimeout: jest.fn().mockResolvedValue(null),
  waitForFunction: jest.fn().mockResolvedValue(null),
  frames: jest.fn().mockReturnValue([{
    url: () => 'about:blank',
    name: () => '',
    evaluate: jest.fn().mockResolvedValue(null),
  }]),
};

const mockContext = {
  newPage: jest.fn().mockResolvedValue(mockPage),
  addCookies: jest.fn().mockResolvedValue(null),
  addInitScript: jest.fn().mockResolvedValue(null),
  cookies: jest.fn().mockResolvedValue([]),
  close: jest.fn().mockResolvedValue(null),
};

const mockBrowser = {
  newContext: jest.fn().mockResolvedValue(mockContext),
  isConnected: jest.fn().mockReturnValue(true),
  close: jest.fn().mockResolvedValue(null),
  on: jest.fn(),
};

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockResolvedValue(mockBrowser),
  },
}), { virtual: true });

const { StreamResolver, isAdUrl } = require('../streamResolver');

function createLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

/**
 * Helper: simulate a network request event on the mock page.
 * When page.on('request', handler) is called, we capture the handler,
 * then invoke it with a mock request object.
 */
function simulateRequest(url, resourceType = 'xhr') {
  const handlers = _pageHandlers['request'] || [];
  const mockRequest = { url: () => url, resourceType: () => resourceType };
  handlers.forEach((handler) => handler(mockRequest));
}

function simulateResponse(url, contentType = 'text/html', status = 200) {
  const handlers = _pageHandlers['response'] || [];
  const mockResponse = {
    url: () => url,
    headers: () => ({ 'content-type': contentType }),
    status: () => status,
    text: () => Promise.resolve(''),
  };
  handlers.forEach((handler) => handler(mockResponse));
}

describe('StreamResolver', () => {
  let resolver;
  let logger;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Clear event handler store
    for (const key of Object.keys(_pageHandlers)) delete _pageHandlers[key];
    // Re-apply default on implementation after clearAllMocks
    mockPage.on.mockImplementation((event, handler) => {
      if (!_pageHandlers[event]) _pageHandlers[event] = [];
      _pageHandlers[event].push(handler);
    });
    logger = createLogger();
    resolver = new StreamResolver({ logger });
    // Reset env overrides
    delete process.env.STREAM_DETECT_TIMEOUT_MS;
    delete process.env.RESTREAM_MAX_ATTEMPTS;
    delete process.env.RESTREAM_DETECT_CONFIG_FALLBACK;
    delete process.env.BROWSER_IDLE_TIMEOUT_MINUTES;
  });

  afterEach(async () => {
    jest.useRealTimers();
    await resolver.closeBrowser();
  });

  describe('isAdUrl', () => {
    test('should detect doubleclick ad URLs', () => {
      expect(isAdUrl('https://ad.doubleclick.net/something')).toBe(true);
    });

    test('should detect googlesyndication ad URLs', () => {
      expect(isAdUrl('https://pagead2.googlesyndication.com/tag')).toBe(true);
    });

    test('should detect generic ad paths', () => {
      expect(isAdUrl('https://example.com/ads/video.m3u8')).toBe(true);
    });

    test('should detect tracking URLs', () => {
      expect(isAdUrl('https://example.com/tracking/pixel.gif')).toBe(true);
    });

    test('should not flag legitimate stream URLs', () => {
      expect(isAdUrl('https://cdn.example.com/live/stream.m3u8')).toBe(false);
    });

    test('should not flag normal page URLs', () => {
      expect(isAdUrl('https://streamed.pk/watch/football')).toBe(false);
    });
  });

  describe('resolve()', () => {
    test('should detect HLS manifest URL from network traffic', async () => {
      jest.useRealTimers();

      // Schedule request simulation after handlers are registered
      setTimeout(() => simulateRequest('https://cdn.example.com/live/stream.m3u8'), 200);

      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
      });

      expect(result).not.toBeNull();
      expect(result.type).toBe('hls');
      expect(result.url).toBe('https://cdn.example.com/live/stream.m3u8');
      expect(result.headers).toBeDefined();
      expect(result.headers.Referer).toBe('https://embed.example.com/player');
    });

    test('should detect DASH manifest URL from network traffic', async () => {
      jest.useRealTimers();

      setTimeout(() => simulateRequest('https://cdn.example.com/live/manifest.mpd'), 200);

      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
      });

      expect(result).not.toBeNull();
      expect(result.type).toBe('dash');
      expect(result.url).toBe('https://cdn.example.com/live/manifest.mpd');
    });

    test('should filter out ad/tracking URLs and detect real stream', async () => {
      jest.useRealTimers();

      setTimeout(() => {
        simulateRequest('https://ad.doubleclick.net/video.m3u8');
        simulateRequest('https://cdn.example.com/stream.m3u8');
      }, 200);

      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
      });

      expect(result).not.toBeNull();
      expect(result.url).toBe('https://cdn.example.com/stream.m3u8');
      expect(result.url).not.toContain('doubleclick');
    });

    test('should return null when no stream URL detected (timeout)', async () => {
      // No network requests emitted — handlers registered but nothing fires

      jest.useRealTimers();

      // Use short timeout to avoid slow test, and disable config fallback
      resolver.enableConfigFallback = false;
      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 500,
        maxAttempts: 1,
      });

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Stream detection attempt failed',
        expect.objectContaining({ attempt: 1 })
      );
    });

    test('should apply solver cookies when provided', async () => {
      jest.useRealTimers();
      setTimeout(() => simulateRequest('https://cdn.example.com/stream.m3u8'), 200);

      const solverCookies = [
        { name: 'cf_clearance', value: 'abc123', domain: '.example.com', path: '/' },
      ];

      await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
        solverCookies,
      });

      expect(mockContext.addCookies).toHaveBeenCalledWith(solverCookies);
    });

    test('should retry with different user agents on failure', async () => {
      jest.useRealTimers();
      let resolveCallCount = 0;
      const origResolve = resolver._resolveWithContext.bind(resolver);
      resolver._resolveWithContext = async (...args) => {
        resolveCallCount++;
        if (resolveCallCount >= 2) {
          // On second attempt, schedule a request
          setTimeout(() => simulateRequest('https://cdn.example.com/stream.m3u8'), 200);
        }
        return origResolve(...args);
      };

      resolver.enableConfigFallback = false;
      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 500,
        maxAttempts: 3,
      });

      expect(result).not.toBeNull();
      expect(result.type).toBe('hls');
      expect(mockBrowser.newContext.mock.calls.length).toBeGreaterThanOrEqual(2);
      const ua1 = mockBrowser.newContext.mock.calls[0][0].userAgent;
      const ua2 = mockBrowser.newContext.mock.calls[1][0].userAgent;
      expect(ua1).not.toBe(ua2);
    });

    test('should include cookies in returned headers', async () => {
      jest.useRealTimers();
      setTimeout(() => simulateRequest('https://cdn.example.com/stream.m3u8'), 200);

      mockContext.cookies.mockResolvedValue([
        { name: 'session', value: 'xyz' },
        { name: 'token', value: '123' },
      ]);

      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
      });

      expect(result.headers.Cookie).toBe('session=xyz; token=123');
    });

    test('should inject anti-detection init scripts', async () => {
      jest.useRealTimers();
      setTimeout(() => simulateRequest('https://cdn.example.com/stream.m3u8'), 200);

      await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
      });

      expect(mockContext.addInitScript).toHaveBeenCalled();
    });

    test('should not set Referer/Origin in extraHTTPHeaders (let browser handle naturally)', async () => {
      jest.useRealTimers();
      setTimeout(() => simulateRequest('https://cdn.example.com/stream.m3u8'), 200);

      await resolver.resolve('https://embed.example.com/player?id=123', {
        timeout: 5000,
        maxAttempts: 1,
      });

      const contextOptions = mockBrowser.newContext.mock.calls[0][0];
      expect(contextOptions.extraHTTPHeaders.Referer).toBeUndefined();
      expect(contextOptions.extraHTTPHeaders.Origin).toBeUndefined();
    });

    test('should close context even on error', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('Navigation failed'));

      jest.useRealTimers();
      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 1000,
        maxAttempts: 1,
      });

      expect(result).toBeNull();
      expect(mockContext.close).toHaveBeenCalled();
    });

    test('should detect MP4 from network traffic after grace period', async () => {
      jest.useRealTimers();
      setTimeout(() => simulateRequest('https://cdn.example.com/video.mp4'), 200);

      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 15000,
        maxAttempts: 1,
      });

      expect(result).not.toBeNull();
      expect(result.type).toBe('mp4');
      expect(result.url).toBe('https://cdn.example.com/video.mp4');
    }, 20000);
  });

  describe('browser management', () => {
    test('should reuse browser across resolve calls', async () => {
      const { chromium } = require('playwright');

      jest.useRealTimers();

      // Schedule requests for both resolve calls
      const scheduleRequest = () => {
        setTimeout(() => simulateRequest('https://cdn.example.com/stream.m3u8'), 200);
      };

      scheduleRequest();
      await resolver.resolve('https://embed1.example.com/player', {
        timeout: 2000,
        maxAttempts: 1,
      });
      scheduleRequest();
      await resolver.resolve('https://embed2.example.com/player', {
        timeout: 2000,
        maxAttempts: 1,
      });

      // Browser launched only once
      expect(chromium.launch).toHaveBeenCalledTimes(1);
    });

    test('should close browser on closeBrowser()', async () => {
      jest.useRealTimers();
      // Force browser launch
      await resolver._getBrowser();
      await resolver.closeBrowser();

      expect(mockBrowser.close).toHaveBeenCalled();
    });
  });

  describe('config fallback', () => {
    test('should fall back to player config when network detection times out', async () => {
      // No network requests emitted — handlers registered normally but nothing fires

      // Player config returns a stream (evaluate is called for iframe check first, then config fallback)
      mockPage.evaluate
        .mockResolvedValueOnce(false) // hasEmbedIframes check
        .mockResolvedValueOnce([]) // iframe srcs in _waitForIframesAndAutoplay
        .mockResolvedValue({ // config fallback
          url: 'https://cdn.example.com/fallback.m3u8',
          type: 'hls',
        });

      jest.useRealTimers();
      resolver.enableConfigFallback = true;
      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 500,
        maxAttempts: 1,
      });

      expect(result).not.toBeNull();
      expect(result.url).toBe('https://cdn.example.com/fallback.m3u8');
      expect(result.type).toBe('hls');
      expect(logger.info).toHaveBeenCalledWith(
        'Located stream via player configuration fallback',
      );
    });
  });

  describe('environment variable defaults', () => {
    test('should use default timeout when env not set', () => {
      const r = new StreamResolver({ logger });
      expect(r.detectTimeoutMs).toBe(20000);
    });

    test('should use STREAM_DETECT_TIMEOUT_MS from env', () => {
      process.env.STREAM_DETECT_TIMEOUT_MS = '15000';
      const r = new StreamResolver({ logger });
      expect(r.detectTimeoutMs).toBe(15000);
      delete process.env.STREAM_DETECT_TIMEOUT_MS;
    });

    test('should use default max attempts when env not set', () => {
      const r = new StreamResolver({ logger });
      expect(r.maxAttempts).toBe(4);
    });

    test('should use default browser idle timeout', () => {
      const r = new StreamResolver({ logger });
      expect(r.browserIdleTimeoutMinutes).toBe(60);
    });
  });
});
