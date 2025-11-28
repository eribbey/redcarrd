const axios = require('axios');
const cheerio = require('cheerio');
const dayjs = require('dayjs');
const { chromium } = require('playwright');
const fs = require('fs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

const DEFAULT_STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

dayjs.extend(utc);
dayjs.extend(timezone);

function normalizeUrl(url = '') {
  const trimmed = url.trim();
  if (!trimmed) return '';

  const baseUrl = process.env.FRONT_PAGE_URL || 'https://ntvstream.cx';

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

async function fetchHtml(url, logger) {
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'redcarrd-proxy/1.0' },
    proxy: false,
    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
  });
  logger?.debug('Fetched HTML via axios', { url, length: response.data?.length || 0 });
  return response.data;
}

const BLOCKED_HOSTS = ['google.com', 'www.google.com', 'pagead2.googlesyndication.com'];

async function fetchRenderedHtml(url, logger, options = {}) {
  const { capturePageData = false, waitForMatches = true, captureStreams = false } = options;
  const normalizedUrl = normalizeUrl(url);
  logger?.debug('Fetching rendered HTML via Playwright', { url: normalizedUrl });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    logger?.error('Failed to launch Playwright browser', { url: normalizedUrl, error: error.message });
    throw error;
  }

  try {
    const context = await browser.newContext({
      // Use a realistic user agent to ensure the page sends full JS-driven content.
      userAgent: DEFAULT_STREAM_UA,
      viewport: { width: 1366, height: 768 },
      // Some upstream hosts (e.g., custom HLS edges) use self-signed certificates; allow them during scraping.
      ignoreHTTPSErrors: true,
    });

    await context.route('**/*', (route) => {
      const requestUrl = route.request().url();
      let hostname;
      try {
        hostname = new URL(requestUrl).hostname;
      } catch (error) {
        logger?.warn('Blocking malformed request while rendering', { url: normalizedUrl, requestUrl });
        return route.abort();
      }

      if (BLOCKED_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
        logger?.debug('Blocked third-party request while rendering', { url: normalizedUrl, requestUrl });
        return route.abort();
      }

      return route.continue();
    });

    const page = await context.newPage();
    page.on('console', (message) => {
      logger?.warn('Page console output', {
        url: normalizedUrl,
        type: message.type(),
        text: message.text(),
      });
    });

    page.on('pageerror', (error) => {
      const level = /clientWidth/i.test(error.message) ? 'warn' : 'error';
      logger?.[level]('Page error during render', {
        url: normalizedUrl,
        message: error.message,
        stack: error.stack,
      });
    });

    const discoveredStreams = new Set();

    page.on('response', async (response) => {
      if (!response.ok()) {
        logger?.warn('Non-OK response while rendering', {
          url: normalizedUrl,
          status: response.status(),
          statusText: response.statusText(),
          responseUrl: response.url(),
        });
      }

      if (captureStreams && response.url().includes('.m3u8')) {
        discoveredStreams.add(response.url());
      }
    });

    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText;
      const responseUrl = request.url();
      const isMainFrame = request.frame() === page.mainFrame();
      const level = isMainFrame ? 'error' : 'warn';

      logger?.[level]('Request failed while rendering', {
        url: normalizedUrl,
        failure,
        responseUrl,
        mainFrame: isMainFrame,
      });
    });
    await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');

    if (waitForMatches) {
      try {
        await page.waitForFunction(
          () => {
            const matchesRoot = document.querySelector('#matchesContent');
            if (!matchesRoot) return false;
            return matchesRoot.querySelectorAll('.match-title, iframe, a[href], [data-src]').length > 0;
          },
          { timeout: 5000 },
        );
      } catch (error) {
        logger?.debug('Timed out waiting for matches content', { url: normalizedUrl, error: error.message });
      }
    }

    // Give client-side scripts enough time to hydrate dynamic content and iframes.
    await page.waitForTimeout(2000);

    if (captureStreams) {
      try {
        await page.evaluate(() => {
          const video = document.querySelector('video');
          if (video) {
            video.muted = true;
            video.play?.();
          }

          const playButtons = Array.from(
            document.querySelectorAll('.vjs-big-play-button, .plyr__control, button[type="button"], button'),
          );
          playButtons.slice(0, 2).forEach((button) => {
            try {
              button.click();
            } catch (error) {
              // Ignore click failures silently to keep scraping resilient.
            }
          });
        });

        // Allow time for the player to request manifests/segments after the play attempt.
        await page.waitForTimeout(1500);
      } catch (error) {
        logger?.debug('Failed to trigger playback during render', { url: normalizedUrl, error: error.message });
      }
    }

    let pageData = null;
    if (capturePageData) {
      try {
        pageData = await page.evaluate(() => {
          const serialize = (value) => {
            try {
              return JSON.parse(JSON.stringify(value));
            } catch (error) {
              return null;
            }
          };

          const globals = {};
          const candidateKeys = [
            'matches',
            'matchData',
            'matchesData',
            'liveMatches',
            'allMatches',
            'nonLiveMatches',
            'events',
            '__NUXT__',
            '__NEXT_DATA__',
          ];

          candidateKeys.forEach((key) => {
            if (typeof window[key] !== 'undefined') {
              globals[key] = serialize(window[key]);
            }
          });

          let localMatches = null;
          try {
            const cached = localStorage.getItem('matches');
            localMatches = cached ? JSON.parse(cached) : null;
          } catch (error) {
            localMatches = null;
          }

          return { globals, localMatches };
        });
      } catch (error) {
        logger?.debug('Failed to capture page data', { url: normalizedUrl, error: error.message });
      }
    }

    const content = await page.content();
    const $ = cheerio.load(content || '');
    const iframeSelector = 'iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]';
    const sourceSelector = '#sourceSelect option, select[name*="source"] option';
    const qualitySelector = '#qualitySelect option, select[name*="quality"] option';

    logger?.debug('Rendered HTML selector diagnostics', {
      url: normalizedUrl,
      matchCardCount: $('.match-card').length,
      matchesContentCount: $('#matchesContent').length,
      iframeCount: $(iframeSelector).length,
      sourceOptionCount: $(sourceSelector).length,
      qualityOptionCount: $(qualitySelector).length,
    });

    if (!content || !content.trim()) {
      const snapshotPath = `/tmp/rendered-${Date.now()}.html`;
      try {
        fs.writeFileSync(snapshotPath, content || '', 'utf8');
      } catch (error) {
        logger?.warn('Failed to write rendered HTML snapshot', { url: normalizedUrl, error: error.message });
      }

      logger?.error('Rendered HTML is empty', {
        url: normalizedUrl,
        snippet: (content || '').slice(0, 500),
        savedTo: snapshotPath,
      });
    }

    logger?.debug('Rendered HTML fetched', { url: normalizedUrl, length: content?.length || 0 });
    if (capturePageData || captureStreams) {
      return { html: content, pageData, discoveredStreams: Array.from(discoveredStreams) };
    }

    return content;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function parseEventTime(text, timezoneName = 'UTC') {
  const raw = text?.trim();
  if (!raw) return null;
  const match = raw.match(/(?<hour>\d{1,2}):(?<minute>\d{2})(?:\s*(?<ampm>AM|PM))?/i);
  if (!match?.groups) return null;

  const hour = parseInt(match.groups.hour, 10);
  const minute = parseInt(match.groups.minute, 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

  const ampm = match.groups.ampm?.toUpperCase();
  let adjustedHour = hour % 24;

  if (ampm === 'PM' && adjustedHour < 12) adjustedHour += 12;
  if (ampm === 'AM' && adjustedHour === 12) adjustedHour = 0;

  const now = dayjs().tz(timezoneName);
  let candidate = now.hour(adjustedHour).minute(minute).second(0).millisecond(0);

  if (candidate.isBefore(now.subtract(5, 'minute'))) {
    candidate = candidate.add(1, 'day');
  }

  return candidate.toDate();
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
  return normalizeUrl(`ntvstream.cx${path}`);
}

async function resolveEmbedFromOnclick(onclickValue, logger) {
  const rawUrl = extractUrlFromOnclick(onclickValue);
  if (!rawUrl) return null;

  const targetUrl = normalizeOnclickTarget(rawUrl);
  if (!targetUrl) return null;

  try {
    const html = await fetchHtml(targetUrl, logger);
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

function normalizeStreamUrl(url) {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return normalizeUrl(trimmed);
}

function collectStreamCandidates($ctx, html = '') {
  const candidates = new Set();

  const add = (value) => {
    const normalized = normalizeStreamUrl(value);
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

function buildEventsFromMatchesPayload(payload, timezoneName = 'UTC', logger, context = {}) {
  if (!payload) return [];

  const events = [];
  const seen = new Set();

  const deriveEmbedUrl = (item) => {
    if (!item || typeof item !== 'object') return null;
    const sourceFromList = (list) => {
      if (!Array.isArray(list)) return null;
      const candidate = list.find((src) => src?.embedUrl || src?.url || src?.src);
      return candidate?.embedUrl || candidate?.url || candidate?.src;
    };

    return (
      item.embedUrl ||
      item.embed ||
      item.streamUrl ||
      item.stream ||
      item.url ||
      item.link ||
      item.href ||
      sourceFromList(item.sources) ||
      sourceFromList(item.streams)
    );
  };

  const addFromItem = (item, index = 0) => {
    const embedUrl = deriveEmbedUrl(item);
    if (!embedUrl || seen.has(embedUrl)) return;

    const title =
      item?.title ||
      item?.name ||
      item?.match ||
      item?.event ||
      item?.slug ||
      `Event ${events.length + 1}`;
    const category = (item?.category || item?.league || item?.sport || 'general').toString().toLowerCase();
    const startTime = parseEventTime(item?.time || item?.startTime || item?.kickoff || item?.start, timezoneName);
    const sourceOptions = Array.isArray(item?.sourceOptions) ? item.sourceOptions : [];
    const qualityOptions = Array.isArray(item?.qualityOptions) ? item.qualityOptions : [];

    events.push({ title, category, embedUrl, sourceOptions, qualityOptions, startTime });
    seen.add(embedUrl);
  };

  const processArray = (list = []) => {
    if (!Array.isArray(list)) return;
    list.forEach((item, index) => addFromItem(item, index));
  };

  const harvestArrays = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      processArray(value);
      return;
    }

    if (typeof value === 'object') {
      ['live', 'all', 'matches', 'events', 'nonLive', 'data', 'items'].forEach((key) => {
        if (Array.isArray(value[key])) processArray(value[key]);
      });
    }
  };

  const { globals = {}, localMatches } = payload;
  Object.values(globals || {}).forEach(harvestArrays);
  harvestArrays(localMatches);

  if (!events.length) {
    logger?.warn('No events parsed from matches payload', { ...context, source: 'script-data' });
  } else {
    logger?.info('Parsed events from matches payload', { ...context, source: 'script-data', count: events.length });
  }

  return events;
}

async function parseFrontPage(html, timezoneName = 'UTC', logger, context = {}) {
  const $ = cheerio.load(html);
  const events = [];
  const seen = new Set();
  const normalizedUrl = context.url ? normalizeUrl(context.url) : undefined;
  const iframeSelector = 'iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]';
  const sourceSelector = '#sourceSelect option, select[name*="source"] option';
  const qualitySelector = '#qualitySelect option, select[name*="quality"] option';

  const matchesContent = $('#matchesContent');
  const matchesContentCount = matchesContent.length;
  const matchCards = $('.match-card');
  const matchCardCount = matchCards.length;
  const iframeCount = $(iframeSelector).length;
  const sourceOptionCount = $(sourceSelector).length;
  const qualityOptionCount = $(qualitySelector).length;

  logger?.info('Front page selector diagnostics', {
    url: normalizedUrl,
    timezone: timezoneName,
    matchesContentFound: matchesContentCount > 0,
    matchesContentCount,
    matchCardCount,
    iframeCount,
    sourceOptionCount,
    qualityOptionCount,
  });

  let eventsFromMatchCards = 0;
  let eventsFromCandidates = 0;
  let eventsFromLooseIframes = 0;
  if (matchCards.length) {
    const matchCardArray = matchCards.toArray();
    for (let index = 0; index < matchCardArray.length; index += 1) {
      const el = $(matchCardArray[index]);
      const title = (el.find('.match-title').first().text() || `Event ${index + 1}`).trim();
      const category = (el.attr('data-category') || 'general').toString().trim().toLowerCase();
      const onclickValue = el.attr('onclick');

      const sourceOptions = collectOptions(el, '#sourceSelect option, select[name*="source"] option', $);
      const qualityOptions = collectOptions(el, '#qualitySelect option, select[name*="quality"] option', $);
      const startTime = parseEventTime(el.find('.time-badge').first().text(), timezoneName);

      const embedUrl =
        el.find('a.match-title[href]').attr('href') ||
        el.find('iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]').first().attr('src') ||
        el.find('[data-src]').attr('data-src') ||
        el.find('[data-url]').attr('data-url') ||
        sourceOptions[0]?.embedUrl ||
        qualityOptions[0]?.embedUrl ||
        (await resolveEmbedFromOnclick(onclickValue, logger));

      if (!embedUrl || seen.has(embedUrl)) continue;

      events.push({ title, category, embedUrl, sourceOptions, qualityOptions, startTime });
      seen.add(embedUrl);
      eventsFromMatchCards += 1;
    }
  }

  const candidates = $('[data-category], .event, article, li')
    .toArray()
    .map((el) => $(el))
    .filter((el) => el.find(iframeSelector).length);

  candidates.forEach((el, index) => {
    const title = (el.find('h1, h2, h3, .title, .event-title').first().text() || `Event ${index + 1}`).trim();
    const category = (el.attr('data-category') || el.find('[data-category]').attr('data-category') || 'general').trim().toLowerCase();
    const embedUrl =
      el.find(iframeSelector).first().attr('src') ||
      el.find('[data-src]').attr('data-src') ||
      el.find('[data-url]').attr('data-url');
    if (!embedUrl || seen.has(embedUrl)) return;

    const sourceOptions = collectOptions(el, '#sourceSelect option, select[name*="source"] option', $);
    const qualityOptions = collectOptions(el, '#qualitySelect option, select[name*="quality"] option', $);
    const startTime = parseEventTime(el.find('.time-badge').first().text(), timezoneName);

    events.push({ title, category, embedUrl, sourceOptions, qualityOptions, startTime });
    seen.add(embedUrl);
    eventsFromCandidates += 1;
  });

  if (!events.length) {
    $(iframeSelector).each((index, el) => {
      const embedUrl = $(el).attr('src') || $(el).data('src') || $(el).attr('data-url');
      const title = $(el).attr('title') || `Event ${index + 1}`;
      const category = ($(el).data('category') || 'general').toString();
      if (embedUrl && !seen.has(embedUrl)) {
        const startTime = parseEventTime(
          $(el).closest('[data-category], .event, article, li').find('.time-badge').first().text(),
          timezoneName,
        );
        events.push({ title, category, embedUrl, sourceOptions: [], qualityOptions: [], startTime });
        seen.add(embedUrl);
        eventsFromLooseIframes += 1;
      }
    });
  }

  if (!events.length) {
    const sanitized = cheerio.load(html || '');
    sanitized('script, style').remove();
    const snapshotPath = `/tmp/frontpage-${Date.now()}.html`;

    try {
      fs.writeFileSync(snapshotPath, sanitized.html() || '', 'utf8');
      logger?.warn('No events parsed from front page', {
        url: normalizedUrl,
        timezone: timezoneName,
        matchCardCount,
        matchesContentCount,
        iframeCount,
        sourceOptionCount,
        qualityOptionCount,
        savedTo: snapshotPath,
      });
    } catch (error) {
      logger?.error('Failed to persist front page snapshot', {
        url: normalizedUrl,
        timezone: timezoneName,
        error: error.message,
      });
    }
  }

  logger?.debug('Parsed front page events', {
    url: normalizedUrl,
    timezone: timezoneName,
    count: events.length,
    eventsFromMatchCards,
    eventsFromCandidates,
    eventsFromLooseIframes,
  });
  return events;
}

function parseEmbedPage(payload, logger) {
  const html = typeof payload === 'string' ? payload : payload?.html || '';
  const $ = cheerio.load(html);
  const initialStream = $('iframe#streamIframe, iframe[id*="streamIframe"]').attr('src');

  const sourceOptions = collectOptions($('body'), '#sourceSelect option, select[name*="source"] option', $);

  const qualityOptions = collectOptions($('body'), '#qualitySelect option, select[name*="quality"] option', $);

  const embeddedStreams = Array.isArray(payload?.discoveredStreams) ? payload.discoveredStreams : [];
  const directStreams = Array.from(new Set([...embeddedStreams, ...collectStreamCandidates($, html)]));
  const streamUrl =
    directStreams.find((url) => url.includes('.m3u8')) ||
    normalizeStreamUrl(initialStream) ||
    directStreams[0] ||
    null;

  logger?.debug('Parsed embed page', {
    streamUrl,
    directStreams: directStreams.length,
    sourceOptions: sourceOptions.length,
    qualityOptions: qualityOptions.length,
  });
  return { streamUrl, sourceOptions, qualityOptions };
}

async function resolveStreamFromEmbed(embedUrl, logger, options = {}) {
  const useRenderer = options.useRenderer ?? process.env.SCRAPER_RENDER_WITH_JS !== 'false';
  const normalizedUrl = normalizeUrl(embedUrl);
  try {
    const payload = useRenderer
      ? await fetchRenderedHtml(normalizedUrl, logger, { captureStreams: true, waitForMatches: false })
      : await fetchHtml(normalizedUrl, logger);
    const parsed = parseEmbedPage(payload, logger);
    return { ...parsed, requestHeaders: buildDefaultStreamHeaders(normalizedUrl) };
  } catch (error) {
    logger?.error('Failed to resolve stream from embed', { url: normalizedUrl, error: error.message });

    if (useRenderer) {
      logger?.warn('Falling back to non-rendered fetch for embed', { url: normalizedUrl });
      const html = await fetchHtml(normalizedUrl, logger);
      const parsed = parseEmbedPage(html, logger);
      return { ...parsed, requestHeaders: buildDefaultStreamHeaders(normalizedUrl) };
    }

    throw error;
  }
}

async function scrapeFrontPage(frontPageUrl, timezoneName = 'UTC', logger) {
  const useRenderer = process.env.SCRAPER_RENDER_WITH_JS !== 'false';
  const normalizedUrl = normalizeUrl(frontPageUrl);
  try {
    const rendered = useRenderer
      ? await fetchRenderedHtml(normalizedUrl, logger, { capturePageData: true })
      : await fetchHtml(normalizedUrl, logger);

    const html = typeof rendered === 'string' ? rendered : rendered?.html;
    let events = await parseFrontPage(html, timezoneName, logger, { url: normalizedUrl });

    if (!events.length && rendered && typeof rendered === 'object') {
      events = buildEventsFromMatchesPayload(rendered.pageData, timezoneName, logger, { url: normalizedUrl });
    }

    return events;
  } catch (error) {
    logger?.error('Failed to fetch front page', { url: normalizedUrl, timezoneName, error: error.message });

    if (useRenderer) {
      logger?.warn('Falling back to non-rendered front page fetch', { url: normalizedUrl });
      const html = await fetchHtml(normalizedUrl, logger);
      return parseFrontPage(html, timezoneName, logger, { url: normalizedUrl });
    }

    throw error;
  }
}

function createProgrammeFromEvent(event, channelId, lifetimeHours = 24, timezoneName = 'UTC') {
  const now = dayjs().tz(timezoneName);
  const start = event.startTime ? dayjs(event.startTime).tz(timezoneName) : now;
  const stop = start.add(lifetimeHours, 'hour');
  return {
    channelId,
    title: event.title,
    category: event.category,
    start: start.toDate(),
    stop: stop.toDate(),
  };
}

module.exports = {
  parseFrontPage,
  parseEmbedPage,
  resolveStreamFromEmbed,
  scrapeFrontPage,
  createProgrammeFromEvent,
  buildDefaultStreamHeaders,
};
