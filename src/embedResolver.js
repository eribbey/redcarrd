const cheerio = require('cheerio');

const DEFAULT_STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function normalizeUrl(url = '') {
  const trimmed = url.trim();
  if (!trimmed) return '';

  const baseUrl = process.env.FRONT_PAGE_URL || 'https://streamed.pk';

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return new URL(trimmed, baseUrl).toString();

  try {
    if (/^[\w.-]+\.[a-z]{2,}/i.test(trimmed)) {
      return new URL(`https://${trimmed.replace(/^\/\//, '')}`).toString();
    }

    return new URL(trimmed, baseUrl).toString();
  } catch (error) {
    return `https://${trimmed.replace(/^\/\//, '')}`;
  }
}

function normalizeStreamUrl(url, baseUrl) {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  const fallbackBase = process.env.FRONT_PAGE_URL || 'https://streamed.pk';
  const resolvedBase = baseUrl || fallbackBase;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  if (trimmed.startsWith('//')) {
    try {
      return new URL(trimmed, resolvedBase).toString();
    } catch (error) {
      return `https:${trimmed}`;
    }
  }

  try {
    if (/^[\w.-]+\.[a-z]{2,}/i.test(trimmed)) {
      return new URL(`https://${trimmed.replace(/^\/\//, '')}`).toString();
    }

    return new URL(trimmed, resolvedBase).toString();
  } catch (error) {
    return normalizeUrl(trimmed);
  }
}

function guessMimeTypeFromUrl(url = '') {
  if (/\.m3u8(\?|$)/i.test(url)) return 'application/vnd.apple.mpegurl';
  if (/\.mpd(\?|$)/i.test(url)) return 'application/dash+xml';
  if (/\.(mp4|m4s)(\?|$)/i.test(url)) return 'video/mp4';
  return '';
}

function extractUrlFromOnclick(onclickValue) {
  if (!onclickValue || typeof onclickValue !== 'string') return null;

  const quotedMatch = onclickValue.match(/["']([^"']+)["']/);
  if (quotedMatch?.[1]) return quotedMatch[1];

  const urlMatch = onclickValue.match(/https?:\/\/[^'"\s)]+/i);
  return urlMatch ? urlMatch[0] : null;
}

function normalizeOnclickTarget(onclickUrl) {
  if (!onclickUrl) return null;
  const trimmed = onclickUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) return normalizeUrl(trimmed);
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return normalizeUrl(`streamed.pk${path}`);
}

async function resolveEmbedFromOnclick(onclickValue, logger, fetchHtmlFn) {
  const rawUrl = extractUrlFromOnclick(onclickValue);
  if (!rawUrl) return null;

  const targetUrl = normalizeOnclickTarget(rawUrl);
  if (!targetUrl) return null;

  try {
    const html = await fetchHtmlFn(targetUrl, logger);
    const $ = cheerio.load(html || '');
    const embedUrl =
      $('iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]').first().attr('src') ||
      $('[data-src]').attr('data-src') ||
      $('[data-url]').attr('data-url') ||
      $('a[href*="embed"]').first().attr('href');

    if (!embedUrl) {
      logger?.warn('No embedUrl found in onclick target', { url: targetUrl });
      return null;
    }

    return embedUrl;
  } catch (error) {
    logger?.error('Failed to fetch onclick target', { url: targetUrl, error: error.message });
    return null;
  }
}

function collectOptions(root, selector, $ctx) {
  return root
    .find(selector)
    .toArray()
    .map((opt) => {
      const $opt = $ctx(opt);
      const embedUrl =
        $opt.attr('data-url') ||
        $opt.attr('data-src') ||
        $opt.attr('data-href') ||
        extractUrlFromOnclick($opt.attr('onclick')) ||
        $opt.attr('value');

      if (!embedUrl) return null;

      const label = $opt.text().trim() || embedUrl;
      return { label, embedUrl };
    })
    .filter(Boolean);
}

function extractHlsStreamsFromSource(source = '', baseUrl) {
  if (!source || typeof source !== 'string') return [];

  const candidates = new Set();

  const add = (value) => {
    if (!value) return;
    const cleaned = value
      .replace(/\\\//g, '/')
      .replace(/\\u002f/gi, '/')
      .replace(/\\x2f/gi, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/&amp;/gi, '&')
      .trim();

    const decoded = (() => {
      try {
        return decodeURIComponent(cleaned);
      } catch (error) {
        return cleaned;
      }
    })();

    const normalized = normalizeStreamUrl(decoded, baseUrl);
    if (normalized) candidates.add(normalized);
  };

  const patterns = [
    /file\s*[:=]\s*["'`]([^"'`]+?\.m3u8[^"'`]*)["'`]/gi,
    /https?:\\{0,2}\/\\{0,2}[^"'`\s]+?\.m3u8[^"'`\s]*/gi,
    /["'`]([^"'`\s]+?\.m3u8[^"'`]*)["'`]/gi,
  ];

  patterns.forEach((regex) => {
    let match;
    while ((match = regex.exec(source))) {
      add(match[1] || match[0]);
    }
  });

  return Array.from(candidates);
}

function extractHlsStreamsFromJwPlayerBundle(source = '') {
  return extractHlsStreamsFromSource(source);
}

function isProbablePlayerBundleScript(responseUrl = '', headers = {}, body = '') {
  const normalizedUrl = responseUrl?.toLowerCase?.() || '';
  const contentType = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const disposition = (headers['content-disposition'] || headers['Content-Disposition'] || '').toLowerCase();
  const lowerBody = body?.toLowerCase?.() || '';

  const isJavaScript = /javascript|ecmascript/.test(contentType);
  const filenameIndicators = [
    'player',
    'bundle',
    'stream',
    'hls',
    'video',
    'playback',
    'embed',
    'dash',
    'jw',
    'plyr',
    'shaka',
  ];

  const urlSuggestsPlayer = filenameIndicators.some((token) => normalizedUrl.includes(token));
  const headersSuggestPlayer = /player|stream|video/.test(disposition);

  const bodyMarkers = [
    /jwplayer/,
    /videojs/,
    /hls\.js/,
    /new\s+hls\s*\(/,
    /\.m3u8/,
    /mpegurl/,
    /manifest\.mpd/,
    /dash\./,
    /shaka\./,
    /plyr\./,
    /clappr/,
    /playerConfig|playlist|sources\s*:/,
  ];

  const bodySuggestsPlayer = bodyMarkers.some((pattern) => pattern.test(lowerBody));

  return isJavaScript && (urlSuggestsPlayer || headersSuggestPlayer || bodySuggestsPlayer);
}

function collectStreamCandidates($ctx, html = '', baseUrl) {
  const candidates = new Set();

  const add = (value) => {
    const normalized = normalizeStreamUrl(value, baseUrl);
    if (normalized) candidates.add(normalized);
  };

  $ctx('video[src], source[src], video source[src], audio[src]').each((_, el) => add($ctx(el).attr('src')));

  $ctx('a[href*=".m3u8"], link[href*=".m3u8"], iframe[src*=".m3u8"], script[src*=".m3u8"]').each((_, el) =>
    add($ctx(el).attr('src') || $ctx(el).attr('href')),
  );

  const regex = /https?:\/\/[^'"\s]+\.m3u8[^'"\s]*/gi;
  let match;
  while ((match = regex.exec(html))) {
    add(match[0]);
  }

  return Array.from(candidates);
}

function buildDefaultStreamHeaders(embedUrl) {
  const headers = { 'User-Agent': DEFAULT_STREAM_UA, Accept: '*/*' };

  if (embedUrl) {
    headers.Referer = normalizeUrl(embedUrl);
    try {
      headers.Origin = new URL(headers.Referer).origin;
    } catch (error) {
      // Ignore origin derivation errors.
    }
  }

  return headers;
}

function parseEmbedPage(payload, logger, baseUrl) {
  const html = typeof payload === 'string' ? payload : payload?.html || '';
  const $ = cheerio.load(html);
  const embedBase = baseUrl || payload?.url || payload?.pageUrl || payload?.responseUrl;
  const initialStream = $('iframe#streamIframe, iframe[id*="streamIframe"]').attr('src');

  const sourceOptions = collectOptions($('body'), '#sourceSelect option, select[name*="source"] option', $);

  const qualityOptions = collectOptions($('body'), '#qualitySelect option, select[name*="quality"] option', $);

  const normalizeDiscoveredStreams = () => {
    if (!Array.isArray(payload?.discoveredStreams)) return [];
    return payload.discoveredStreams
      .map((entry) => {
        if (typeof entry === 'string') {
          const normalizedUrl = normalizeStreamUrl(entry, embedBase);
          if (!normalizedUrl) return null;
          return { url: normalizedUrl, mimeType: guessMimeTypeFromUrl(normalizedUrl), isHls: normalizedUrl.includes('.m3u8') };
        }

        if (entry && typeof entry === 'object' && entry.url) {
          const normalizedUrl = normalizeStreamUrl(entry.url, embedBase);
          if (!normalizedUrl) return null;
          return {
            url: normalizedUrl,
            mimeType: entry.mimeType || guessMimeTypeFromUrl(normalizedUrl),
            isHls: Boolean(entry.isHls || normalizedUrl.includes('.m3u8')),
          };
        }

        return null;
      })
      .filter(Boolean);
  };

  const discoveredStreams = normalizeDiscoveredStreams();
  const directStreams = Array.from(
    new Set([...discoveredStreams.map((entry) => entry.url), ...collectStreamCandidates($, html, embedBase)]),
  );
  const normalizedInitial = normalizeStreamUrl(initialStream, embedBase);
  const streamUrl =
    directStreams.find((url) => url.includes('.m3u8')) ||
    normalizedInitial ||
    directStreams[0] ||
    null;

  const matchedDiscovered = discoveredStreams.find((entry) => entry.url === streamUrl);
  const streamMimeType = matchedDiscovered?.mimeType || guessMimeTypeFromUrl(streamUrl);

  logger?.debug('Parsed embed page', {
    streamUrl,
    streamMimeType,
    directStreams: directStreams.length,
    sourceOptions: sourceOptions.length,
    qualityOptions: qualityOptions.length,
  });
  return { streamUrl, streamMimeType, sourceOptions, qualityOptions };
}

async function resolveStreamFromEmbed(embedUrl, logger, options = {}) {
  const { fetchHtmlFn, fetchRenderedHtmlFn } = options;
  const useRenderer = options.useRenderer ?? process.env.SCRAPER_RENDER_WITH_JS !== 'false';
  const normalizedEmbedUrl = normalizeUrl(embedUrl);
  const buildCookieMetadata = (payload = {}) => {
    const cookies = Array.isArray(payload.cookies)
      ? payload.cookies
          .filter((cookie) => cookie?.name && typeof cookie.value !== 'undefined')
          .map((cookie) => `${cookie.name}=${cookie.value}`)
      : [];

    const setCookieHeaders = Array.isArray(payload.setCookieHeaders)
      ? payload.setCookieHeaders.filter(Boolean)
      : [];

    const cookieHeader = payload.cookieHeader || (cookies.length ? cookies.join('; ') : '');
    const requestHeaders = { ...buildDefaultStreamHeaders(normalizedEmbedUrl) };

    if (cookieHeader) requestHeaders.Cookie = cookieHeader;

    return { cookies, cookieHeader, setCookieHeaders, requestHeaders };
  };

  try {
    const payload = useRenderer
      ? await fetchRenderedHtmlFn(normalizedEmbedUrl, logger, { captureStreams: true, waitForMatches: false })
      : await fetchHtmlFn(normalizedEmbedUrl, logger);

    const parsed = parseEmbedPage(payload, logger, normalizedEmbedUrl);

    if (useRenderer) {
      const discoveredStreams = Array.isArray(payload?.discoveredStreams) ? payload.discoveredStreams : [];
      const discoveredM3u8Count = discoveredStreams.filter((entry) => {
        const url = entry?.url || entry;
        return typeof url === 'string' && url.includes('.m3u8');
      }).length;
      const renderHadPageError = Boolean(payload?.pageErrorOccurred);
      const renderFoundStream = Boolean(parsed.streamUrl || discoveredM3u8Count > 0);

      const shouldFallback =
        !renderFoundStream || (renderHadPageError && !parsed.streamUrl && discoveredM3u8Count === 0);

      if (shouldFallback) {
        logger?.warn('Falling back to non-rendered fetch for embed after render diagnostics', {
          url: normalizedEmbedUrl,
          renderHadPageError,
          discoveredStreamCount: discoveredStreams.length,
          discoveredM3u8Count,
          streamUrlFromRender: parsed.streamUrl,
        });

        const html = await fetchHtmlFn(normalizedEmbedUrl, logger, {
          cookies: payload?.cookies,
          cookieHeader: payload?.cookieHeader,
          acceptLanguage: 'en-US,en;q=0.9',
        });
        const fallbackParsed = parseEmbedPage(html, logger, normalizedEmbedUrl);
        const cookieMetadata = buildCookieMetadata(payload);
        return { ...fallbackParsed, ...cookieMetadata };
      }
    }
    const cookieMetadata = buildCookieMetadata(useRenderer ? payload : {});
    return { ...parsed, ...cookieMetadata };
  } catch (error) {
    logger?.error('Failed to resolve stream from embed', { url: normalizedEmbedUrl, error: error.message });

    if (useRenderer) {
      logger?.warn('Falling back to non-rendered fetch for embed', { url: normalizedEmbedUrl });
      const html = await fetchHtmlFn(normalizedEmbedUrl, logger, {
        cookies: error?.cookies,
        cookieHeader: error?.cookieHeader,
        acceptLanguage: 'en-US,en;q=0.9',
      });
      const parsed = parseEmbedPage(html, logger, normalizedEmbedUrl);
      const cookieMetadata = buildCookieMetadata(error || {});
      return { ...parsed, ...cookieMetadata };
    }

    throw error;
  }
}

module.exports = {
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
};
