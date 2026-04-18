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

module.exports = {
  normalizeUrl,
  normalizeStreamUrl,
  guessMimeTypeFromUrl,
  extractUrlFromOnclick,
  normalizeOnclickTarget,
  resolveEmbedFromOnclick,
  collectOptions,
  extractHlsStreamsFromSource,
  isProbablePlayerBundleScript,
  buildDefaultStreamHeaders,
};
