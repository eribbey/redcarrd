'use strict';

// Mock Playwright before requiring the module under test
const mockPage = {
  goto: jest.fn().mockResolvedValue(null),
  on: jest.fn(),
  removeListener: jest.fn(),
  $: jest.fn().mockResolvedValue(null),
  evaluate: jest.fn().mockResolvedValue(null),
  waitForTimeout: jest.fn().mockResolvedValue(null),
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
function simulateRequest(url) {
  const requestHandlers = mockPage.on.mock.calls
    .filter(([event]) => event === 'request')
    .map(([, handler]) => handler);

  const mockRequest = { url: () => url };
  requestHandlers.forEach((handler) => handler(mockRequest));
}

describe('StreamResolver', () => {
  let resolver;
  let logger;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
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
      // Make page.on capture the request handler, then simulate a request
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'request') {
          // Schedule the mock request emission after setup
          setTimeout(() => {
            handler({ url: () => 'https://cdn.example.com/live/stream.m3u8' });
          }, 100);
        }
      });

      jest.useRealTimers();
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
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'request') {
          setTimeout(() => {
            handler({ url: () => 'https://cdn.example.com/live/manifest.mpd' });
          }, 100);
        }
      });

      jest.useRealTimers();
      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
      });

      expect(result).not.toBeNull();
      expect(result.type).toBe('dash');
      expect(result.url).toBe('https://cdn.example.com/live/manifest.mpd');
    });

    test('should filter out ad/tracking URLs and detect real stream', async () => {
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'request') {
          setTimeout(() => {
            // First: ad URL that should be filtered
            handler({ url: () => 'https://ad.doubleclick.net/video.m3u8' });
            // Second: real stream URL
            handler({ url: () => 'https://cdn.example.com/stream.m3u8' });
          }, 100);
        }
      });

      jest.useRealTimers();
      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
      });

      expect(result).not.toBeNull();
      expect(result.url).toBe('https://cdn.example.com/stream.m3u8');
      // The ad URL should have been skipped
      expect(result.url).not.toContain('doubleclick');
    });

    test('should return null when no stream URL detected (timeout)', async () => {
      // Don't emit any request events - let it time out
      mockPage.on.mockImplementation(() => {});

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
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'request') {
          setTimeout(() => {
            handler({ url: () => 'https://cdn.example.com/stream.m3u8' });
          }, 100);
        }
      });

      const solverCookies = [
        { name: 'cf_clearance', value: 'abc123', domain: '.example.com', path: '/' },
      ];

      jest.useRealTimers();
      await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
        solverCookies,
      });

      expect(mockContext.addCookies).toHaveBeenCalledWith(solverCookies);
    });

    test('should retry with different user agents on failure', async () => {
      let attemptCount = 0;
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'request') {
          attemptCount++;
          if (attemptCount >= 2) {
            // Succeed on second attempt
            setTimeout(() => {
              handler({ url: () => 'https://cdn.example.com/stream.m3u8' });
            }, 100);
          }
          // First attempt: no requests emitted (will time out)
        }
      });

      jest.useRealTimers();
      resolver.enableConfigFallback = false;
      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 500,
        maxAttempts: 3,
      });

      expect(result).not.toBeNull();
      expect(result.type).toBe('hls');
      // Verify multiple contexts were created (different user agents)
      expect(mockBrowser.newContext.mock.calls.length).toBeGreaterThanOrEqual(2);
      const ua1 = mockBrowser.newContext.mock.calls[0][0].userAgent;
      const ua2 = mockBrowser.newContext.mock.calls[1][0].userAgent;
      expect(ua1).not.toBe(ua2);
    });

    test('should include cookies in returned headers', async () => {
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'request') {
          setTimeout(() => {
            handler({ url: () => 'https://cdn.example.com/stream.m3u8' });
          }, 100);
        }
      });

      mockContext.cookies.mockResolvedValue([
        { name: 'session', value: 'xyz' },
        { name: 'token', value: '123' },
      ]);

      jest.useRealTimers();
      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
      });

      expect(result.headers.Cookie).toBe('session=xyz; token=123');
    });

    test('should inject anti-detection init scripts', async () => {
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'request') {
          setTimeout(() => {
            handler({ url: () => 'https://cdn.example.com/stream.m3u8' });
          }, 100);
        }
      });

      jest.useRealTimers();
      await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
      });

      expect(mockContext.addInitScript).toHaveBeenCalled();
    });

    test('should set Referer and Origin headers from embed URL', async () => {
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'request') {
          setTimeout(() => {
            handler({ url: () => 'https://cdn.example.com/stream.m3u8' });
          }, 100);
        }
      });

      jest.useRealTimers();
      await resolver.resolve('https://embed.example.com/player?id=123', {
        timeout: 5000,
        maxAttempts: 1,
      });

      const contextOptions = mockBrowser.newContext.mock.calls[0][0];
      expect(contextOptions.extraHTTPHeaders.Referer).toBe('https://embed.example.com/player?id=123');
      expect(contextOptions.extraHTTPHeaders.Origin).toBe('https://embed.example.com');
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

    test('should detect progressive MP4 from network traffic', async () => {
      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'request') {
          setTimeout(() => {
            handler({ url: () => 'https://cdn.example.com/video.mp4' });
          }, 100);
        }
      });

      jest.useRealTimers();
      const result = await resolver.resolve('https://embed.example.com/player', {
        timeout: 5000,
        maxAttempts: 1,
      });

      expect(result).not.toBeNull();
      expect(result.type).toBe('progressive');
      expect(result.url).toBe('https://cdn.example.com/video.mp4');
    });
  });

  describe('browser management', () => {
    test('should reuse browser across resolve calls', async () => {
      const { chromium } = require('playwright');

      mockPage.on.mockImplementation((event, handler) => {
        if (event === 'request') {
          setTimeout(() => {
            handler({ url: () => 'https://cdn.example.com/stream.m3u8' });
          }, 50);
        }
      });

      jest.useRealTimers();
      await resolver.resolve('https://embed1.example.com/player', {
        timeout: 2000,
        maxAttempts: 1,
      });
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
      // No network requests emitted
      mockPage.on.mockImplementation(() => {});

      // Player config returns a stream
      mockPage.evaluate.mockResolvedValue({
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
