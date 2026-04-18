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
