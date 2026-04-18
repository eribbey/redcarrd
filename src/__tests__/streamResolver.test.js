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
      if (onM3u8 === 'emit') {
        const noisyResponse = {
          url: () => 'https://doubleclick.net/tracking/pixel.gif',
          request: () => fakeRequest,
        };
        setImmediate(() => {
          listeners.response.forEach((cb) => cb(noisyResponse));
          listeners.response.forEach((cb) => cb(fakeResponse));
        });
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

    expect(result.streamUrl).toBe('https://netanyahu.modifiles.fans/secure/TOKEN/1/2/team/index.m3u8');
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
