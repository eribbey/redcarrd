const {
  normalizeUrl,
  normalizeStreamUrl,
  guessMimeTypeFromUrl,
  extractUrlFromOnclick,
  normalizeOnclickTarget,
  resolveEmbedFromOnclick,
  collectOptions,
  extractHlsStreamsFromSource,
  extractHlsStreamsFromJwPlayerBundle,
  isProbablePlayerBundleScript,
  collectStreamCandidates,
  buildDefaultStreamHeaders,
  parseEmbedPage,
  resolveStreamFromEmbed,
} = require('../embedResolver');
const cheerio = require('cheerio');

describe('embedResolver', () => {
  describe('normalizeUrl()', () => {
    test('should handle protocol-relative URLs', () => {
      expect(normalizeUrl('//cdn.example.com/stream')).toBe('https://cdn.example.com/stream');
    });

    test('should handle relative paths', () => {
      expect(normalizeUrl('/embed/stream1')).toBe('https://streamed.pk/embed/stream1');
    });

    test('should pass through absolute URLs', () => {
      expect(normalizeUrl('https://example.com/video')).toBe('https://example.com/video');
      expect(normalizeUrl('http://example.com/video')).toBe('http://example.com/video');
    });

    test('should return empty string for empty input', () => {
      expect(normalizeUrl('')).toBe('');
      expect(normalizeUrl()).toBe('');
    });

    test('should handle bare domain names', () => {
      const result = normalizeUrl('example.com/path');
      expect(result).toMatch(/^https:\/\/example\.com\/path/);
    });
  });

  describe('normalizeStreamUrl()', () => {
    test('should handle protocol-relative URLs', () => {
      const result = normalizeStreamUrl('//cdn.example.com/stream.m3u8');
      expect(result).toMatch(/^https:\/\/cdn\.example\.com\/stream\.m3u8/);
    });

    test('should handle relative paths with base URL', () => {
      const result = normalizeStreamUrl('/live/stream.m3u8', 'https://cdn.example.com');
      expect(result).toBe('https://cdn.example.com/live/stream.m3u8');
    });

    test('should pass through absolute URLs', () => {
      expect(normalizeStreamUrl('https://cdn.example.com/stream.m3u8')).toBe('https://cdn.example.com/stream.m3u8');
    });

    test('should return null for empty input', () => {
      expect(normalizeStreamUrl('')).toBeNull();
      expect(normalizeStreamUrl(null)).toBeNull();
      expect(normalizeStreamUrl(undefined)).toBeNull();
    });
  });

  describe('guessMimeTypeFromUrl()', () => {
    test('should detect HLS manifests', () => {
      expect(guessMimeTypeFromUrl('https://cdn.example.com/stream.m3u8')).toBe('application/vnd.apple.mpegurl');
      expect(guessMimeTypeFromUrl('https://cdn.example.com/stream.m3u8?token=abc')).toBe('application/vnd.apple.mpegurl');
    });

    test('should detect DASH manifests', () => {
      expect(guessMimeTypeFromUrl('https://cdn.example.com/manifest.mpd')).toBe('application/dash+xml');
    });

    test('should detect MP4/M4S', () => {
      expect(guessMimeTypeFromUrl('https://cdn.example.com/segment.mp4')).toBe('video/mp4');
      expect(guessMimeTypeFromUrl('https://cdn.example.com/segment.m4s')).toBe('video/mp4');
    });

    test('should return empty string for unknown types', () => {
      expect(guessMimeTypeFromUrl('https://cdn.example.com/page.html')).toBe('');
      expect(guessMimeTypeFromUrl('')).toBe('');
    });
  });

  describe('extractUrlFromOnclick()', () => {
    test('should extract quoted URL from onclick value', () => {
      expect(extractUrlFromOnclick("changeSource('/embed/stream1')")).toBe('/embed/stream1');
    });

    test('should extract absolute URL from onclick value', () => {
      expect(extractUrlFromOnclick("window.open('https://example.com/stream')")).toBe('https://example.com/stream');
    });

    test('should return null for non-string input', () => {
      expect(extractUrlFromOnclick(null)).toBeNull();
      expect(extractUrlFromOnclick(undefined)).toBeNull();
      expect(extractUrlFromOnclick(123)).toBeNull();
    });

    test('should extract unquoted absolute URLs', () => {
      expect(extractUrlFromOnclick('goto(https://example.com/page)')).toBe('https://example.com/page');
    });
  });

  describe('normalizeOnclickTarget()', () => {
    test('should normalize absolute URLs', () => {
      expect(normalizeOnclickTarget('https://example.com/embed')).toBe('https://example.com/embed');
    });

    test('should normalize relative paths', () => {
      expect(normalizeOnclickTarget('/embed/stream1')).toBe('https://streamed.pk/embed/stream1');
    });

    test('should add leading slash to bare paths', () => {
      const result = normalizeOnclickTarget('embed/stream1');
      expect(result).toBe('https://streamed.pk/embed/stream1');
    });

    test('should return null for null/undefined', () => {
      expect(normalizeOnclickTarget(null)).toBeNull();
      expect(normalizeOnclickTarget(undefined)).toBeNull();
    });
  });

  describe('resolveEmbedFromOnclick()', () => {
    test('should return null for invalid onclick value', async () => {
      const result = await resolveEmbedFromOnclick(null, null, jest.fn());
      expect(result).toBeNull();
    });

    test('should fetch target and extract embed URL', async () => {
      const mockHtml = '<html><iframe id="streamPlayer" src="https://cdn.example.com/embed/1"></iframe></html>';
      const fetchHtmlFn = jest.fn().mockResolvedValue(mockHtml);

      const result = await resolveEmbedFromOnclick("changeSource('/embed/stream1')", null, fetchHtmlFn);
      expect(result).toBe('https://cdn.example.com/embed/1');
      expect(fetchHtmlFn).toHaveBeenCalled();
    });

    test('should return null when no embed URL found in target page', async () => {
      const mockHtml = '<html><div>No iframes here</div></html>';
      const fetchHtmlFn = jest.fn().mockResolvedValue(mockHtml);

      const result = await resolveEmbedFromOnclick("changeSource('/embed/stream1')", null, fetchHtmlFn);
      expect(result).toBeNull();
    });

    test('should return null on fetch error', async () => {
      const fetchHtmlFn = jest.fn().mockRejectedValue(new Error('Network error'));

      const result = await resolveEmbedFromOnclick("changeSource('/embed/stream1')", null, fetchHtmlFn);
      expect(result).toBeNull();
    });
  });

  describe('collectOptions()', () => {
    test('should collect options with data-url attributes', () => {
      const html = `
        <select id="sourceSelect">
          <option data-url="https://cdn.example.com/stream1">Source 1</option>
          <option data-url="https://cdn.example.com/stream2">Source 2</option>
        </select>
      `;
      const $ = cheerio.load(html);
      const options = collectOptions($('body'), '#sourceSelect option', $);
      expect(options).toHaveLength(2);
      expect(options[0]).toEqual({ label: 'Source 1', embedUrl: 'https://cdn.example.com/stream1' });
    });

    test('should collect options with value attributes', () => {
      const html = `
        <select id="sourceSelect">
          <option value="https://cdn.example.com/embed1">Primary</option>
        </select>
      `;
      const $ = cheerio.load(html);
      const options = collectOptions($('body'), '#sourceSelect option', $);
      expect(options).toHaveLength(1);
      expect(options[0].embedUrl).toBe('https://cdn.example.com/embed1');
    });

    test('should filter out options without embed URLs', () => {
      const html = `
        <select id="sourceSelect">
          <option value="">No URL</option>
          <option value="https://cdn.example.com/embed1">Has URL</option>
        </select>
      `;
      const $ = cheerio.load(html);
      const options = collectOptions($('body'), '#sourceSelect option', $);
      expect(options).toHaveLength(1);
      expect(options[0].embedUrl).toBe('https://cdn.example.com/embed1');
    });
  });

  describe('extractHlsStreamsFromSource()', () => {
    test('should extract m3u8 URLs from JavaScript source', () => {
      const source = 'file: "https://cdn.example.com/live/stream.m3u8"';
      const result = extractHlsStreamsFromSource(source);
      expect(result).toContain('https://cdn.example.com/live/stream.m3u8');
    });

    test('should handle escaped URLs', () => {
      const source = 'file: "https:\\/\\/cdn.example.com\\/live\\/stream.m3u8"';
      const result = extractHlsStreamsFromSource(source);
      expect(result.length).toBeGreaterThan(0);
      expect(result.some((url) => url.includes('stream.m3u8'))).toBe(true);
    });

    test('should return empty array for non-string input', () => {
      expect(extractHlsStreamsFromSource(null)).toEqual([]);
      expect(extractHlsStreamsFromSource('')).toEqual([]);
      expect(extractHlsStreamsFromSource(123)).toEqual([]);
    });

    test('should deduplicate URLs', () => {
      const source = '"https://cdn.example.com/stream.m3u8" and again "https://cdn.example.com/stream.m3u8"';
      const result = extractHlsStreamsFromSource(source);
      expect(result).toHaveLength(1);
    });
  });

  describe('extractHlsStreamsFromJwPlayerBundle()', () => {
    test('should delegate to extractHlsStreamsFromSource', () => {
      const source = 'file: "https://cdn.example.com/stream.m3u8"';
      const result = extractHlsStreamsFromJwPlayerBundle(source);
      expect(result).toContain('https://cdn.example.com/stream.m3u8');
    });
  });

  describe('isProbablePlayerBundleScript()', () => {
    test('should detect player bundle by URL keywords', () => {
      expect(isProbablePlayerBundleScript(
        'https://cdn.example.com/player.js',
        { 'content-type': 'application/javascript' },
        '',
      )).toBe(true);
    });

    test('should detect player bundle by body markers', () => {
      expect(isProbablePlayerBundleScript(
        'https://cdn.example.com/app.js',
        { 'content-type': 'application/javascript' },
        'var player = jwplayer("video");',
      )).toBe(true);
    });

    test('should return false for non-JavaScript content', () => {
      expect(isProbablePlayerBundleScript(
        'https://cdn.example.com/player.js',
        { 'content-type': 'text/html' },
        '',
      )).toBe(false);
    });
  });

  describe('collectStreamCandidates()', () => {
    test('should collect video src attributes', () => {
      const html = '<video src="https://cdn.example.com/live.m3u8"></video>';
      const $ = cheerio.load(html);
      const result = collectStreamCandidates($, html);
      expect(result).toContain('https://cdn.example.com/live.m3u8');
    });

    test('should collect source element src attributes', () => {
      const html = '<video><source src="https://cdn.example.com/stream.mp4"></video>';
      const $ = cheerio.load(html);
      const result = collectStreamCandidates($, html);
      expect(result).toContain('https://cdn.example.com/stream.mp4');
    });

    test('should extract m3u8 URLs from raw HTML', () => {
      const html = '<script>var url = "https://cdn.example.com/live.m3u8?token=abc";</script>';
      const $ = cheerio.load(html);
      const result = collectStreamCandidates($, html);
      expect(result.some((url) => url.includes('live.m3u8'))).toBe(true);
    });
  });

  describe('buildDefaultStreamHeaders()', () => {
    test('should include User-Agent and Accept headers', () => {
      const headers = buildDefaultStreamHeaders();
      expect(headers['User-Agent']).toBeDefined();
      expect(headers.Accept).toBe('*/*');
    });

    test('should include Referer and Origin when embed URL provided', () => {
      const headers = buildDefaultStreamHeaders('https://embed.example.com/stream');
      expect(headers.Referer).toBe('https://embed.example.com/stream');
      expect(headers.Origin).toBe('https://embed.example.com');
    });
  });

  describe('parseEmbedPage()', () => {
    test('should extract stream URL from iframe', () => {
      const html = '<div><iframe id="streamIframe" src="https://cdn.example.com/stream.m3u8"></iframe></div>';
      const result = parseEmbedPage(html, null, 'https://example.com');
      expect(result.streamUrl).toBe('https://cdn.example.com/stream.m3u8');
      expect(result.streamMimeType).toBe('application/vnd.apple.mpegurl');
    });

    test('should extract source and quality options', () => {
      const html = `
        <div>
          <iframe id="streamIframe" src="https://cdn.example.com/stream.m3u8"></iframe>
          <select id="sourceSelect">
            <option value="https://streamed.pk/embed?a">Primary</option>
          </select>
          <select id="qualitySelect">
            <option value="https://streamed.pk/embed?a&quality=1080">1080p</option>
            <option value="https://streamed.pk/embed?a&quality=720">720p</option>
          </select>
        </div>
      `;
      const result = parseEmbedPage(html, null);
      expect(result.sourceOptions).toHaveLength(1);
      expect(result.qualityOptions).toHaveLength(2);
    });

    test('should handle payload with discoveredStreams', () => {
      const payload = {
        html: '<div></div>',
        discoveredStreams: [
          { url: 'https://cdn.example.com/live.m3u8', mimeType: 'application/vnd.apple.mpegurl', isHls: true },
        ],
      };
      const result = parseEmbedPage(payload, null, 'https://example.com');
      expect(result.streamUrl).toBe('https://cdn.example.com/live.m3u8');
    });

    test('should return null streamUrl when no streams found', () => {
      const html = '<div>No streams here</div>';
      const result = parseEmbedPage(html, null);
      expect(result.streamUrl).toBeNull();
    });
  });

  describe('resolveStreamFromEmbed()', () => {
    test('should use fetchHtmlFn when renderer is disabled', async () => {
      const embedHtml = '<div><iframe id="streamIframe" src="https://cdn.example.com/stream.m3u8"></iframe></div>';
      const fetchHtmlFn = jest.fn().mockResolvedValue(embedHtml);
      const fetchRenderedHtmlFn = jest.fn();

      const result = await resolveStreamFromEmbed('https://example.com/embed/1', null, {
        useRenderer: false,
        fetchHtmlFn,
        fetchRenderedHtmlFn,
      });

      expect(fetchHtmlFn).toHaveBeenCalled();
      expect(fetchRenderedHtmlFn).not.toHaveBeenCalled();
      expect(result.streamUrl).toBe('https://cdn.example.com/stream.m3u8');
    });

    test('should use fetchRenderedHtmlFn when renderer is enabled', async () => {
      const renderedPayload = {
        html: '<div><iframe id="streamIframe" src="https://cdn.example.com/stream.m3u8"></iframe></div>',
        discoveredStreams: [
          { url: 'https://cdn.example.com/stream.m3u8', mimeType: 'application/vnd.apple.mpegurl', isHls: true },
        ],
        cookies: [],
      };
      const fetchHtmlFn = jest.fn();
      const fetchRenderedHtmlFn = jest.fn().mockResolvedValue(renderedPayload);

      const result = await resolveStreamFromEmbed('https://example.com/embed/1', null, {
        useRenderer: true,
        fetchHtmlFn,
        fetchRenderedHtmlFn,
      });

      expect(fetchRenderedHtmlFn).toHaveBeenCalled();
      expect(result.streamUrl).toBe('https://cdn.example.com/stream.m3u8');
    });

    test('should fall back to fetchHtmlFn when renderer fails', async () => {
      const embedHtml = '<div><iframe id="streamIframe" src="https://cdn.example.com/stream.m3u8"></iframe></div>';
      const fetchHtmlFn = jest.fn().mockResolvedValue(embedHtml);
      const fetchRenderedHtmlFn = jest.fn().mockRejectedValue(new Error('Browser crash'));

      const result = await resolveStreamFromEmbed('https://example.com/embed/1', null, {
        useRenderer: true,
        fetchHtmlFn,
        fetchRenderedHtmlFn,
      });

      expect(fetchRenderedHtmlFn).toHaveBeenCalled();
      expect(fetchHtmlFn).toHaveBeenCalled();
      expect(result.streamUrl).toBe('https://cdn.example.com/stream.m3u8');
    });
  });
});
