const axios = require('axios');
const cheerio = require('cheerio');
const dayjs = require('dayjs');
const { chromium } = require('playwright');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

async function fetchHtml(url, logger) {
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'redcarrd-proxy/1.0' },
    proxy: false,
  });
  logger?.debug('Fetched HTML via axios', { url, length: response.data?.length || 0 });
  return response.data;
}

async function fetchRenderedHtml(url, logger) {
  const normalizedUrl = url.startsWith('http') ? url : `https://${url.replace(/^\/\//, '')}`;
  logger?.debug('Fetching rendered HTML via Playwright', { url: normalizedUrl });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: 'redcarrd-proxy/1.0',
    });
    const page = await context.newPage();
    await page.goto(normalizedUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const content = await page.content();
    logger?.debug('Rendered HTML fetched', { url: normalizedUrl, length: content.length });
    return content;
  } finally {
    await browser.close();
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

function collectOptions(root, selector, $ctx) {
  return root
    .find(selector)
    .toArray()
    .map((opt) => ({
      label: $ctx(opt).text().trim() || $ctx(opt).attr('value'),
      embedUrl: $ctx(opt).attr('value'),
    }))
    .filter((opt) => opt.embedUrl);
}

function parseFrontPage(html, timezoneName = 'UTC', logger) {
  const $ = cheerio.load(html);
  const events = [];
  const seen = new Set();

  const matchesContent = $('#matchesContent');
  if (matchesContent.length) {
    matchesContent.find('.match-title').each((index, titleEl) => {
      const el = $(titleEl);
      const wrapper = el.closest('[data-category], .match, .event, li, article, .card');
      const title = (el.text() || `Event ${index + 1}`).trim();
      const category = (wrapper.attr('data-category') || 'general').trim().toLowerCase();
      const embedUrl =
        wrapper.find('iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]').first().attr('src') ||
        el.attr('href');
      if (!embedUrl || seen.has(embedUrl)) return;

      const sourceOptions = collectOptions(wrapper, '#sourceSelect option, select[name*="source"] option', $);
      const qualityOptions = collectOptions(wrapper, '#qualitySelect option, select[name*="quality"] option', $);
      const startTime = parseEventTime(wrapper.find('.time-badge').first().text(), timezoneName);

      events.push({ title, category, embedUrl, sourceOptions, qualityOptions, startTime });
      seen.add(embedUrl);
    });
  }

  const candidates = $('[data-category], .event, article, li')
    .toArray()
    .map((el) => $(el))
    .filter((el) => el.find('iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]').length);

  candidates.forEach((el, index) => {
    const title = (el.find('h1, h2, h3, .title, .event-title').first().text() || `Event ${index + 1}`).trim();
    const category = (el.attr('data-category') || el.find('[data-category]').attr('data-category') || 'general').trim().toLowerCase();
    const embedUrl = el.find('iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]').first().attr('src');
    if (!embedUrl || seen.has(embedUrl)) return;

    const sourceOptions = collectOptions(el, '#sourceSelect option, select[name*="source"] option', $);
    const qualityOptions = collectOptions(el, '#qualitySelect option, select[name*="quality"] option', $);
    const startTime = parseEventTime(el.find('.time-badge').first().text(), timezoneName);

    events.push({ title, category, embedUrl, sourceOptions, qualityOptions, startTime });
    seen.add(embedUrl);
  });

  if (!events.length) {
    $('iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]').each((index, el) => {
      const embedUrl = $(el).attr('src');
      const title = $(el).attr('title') || `Event ${index + 1}`;
      const category = ($(el).data('category') || 'general').toString();
      if (embedUrl && !seen.has(embedUrl)) {
        const startTime = parseEventTime(
          $(el).closest('[data-category], .event, article, li').find('.time-badge').first().text(),
          timezoneName,
        );
        events.push({ title, category, embedUrl, sourceOptions: [], qualityOptions: [], startTime });
        seen.add(embedUrl);
      }
    });
  }

  logger?.debug('Parsed front page events', { count: events.length });
  return events;
}

function parseEmbedPage(html, logger) {
  const $ = cheerio.load(html);
  const streamUrl = $('iframe#streamIframe, iframe[id*="streamIframe"]').attr('src');
  const sourceOptions = $('#sourceSelect option, select[name*="source"] option')
    .toArray()
    .map((opt) => ({ label: $(opt).text().trim() || $(opt).attr('value'), embedUrl: $(opt).attr('value') }))
    .filter((opt) => opt.embedUrl);

  const qualityOptions = $('#qualitySelect option, select[name*="quality"] option')
    .toArray()
    .map((opt) => ({ label: $(opt).text().trim() || $(opt).attr('value'), embedUrl: $(opt).attr('value') }))
    .filter((opt) => opt.embedUrl);

  logger?.debug('Parsed embed page', { streamUrl, sourceOptions: sourceOptions.length, qualityOptions: qualityOptions.length });
  return { streamUrl, sourceOptions, qualityOptions };
}

async function resolveStreamFromEmbed(embedUrl, logger, options = {}) {
  const useRenderer = options.useRenderer ?? process.env.SCRAPER_RENDER_WITH_JS !== 'false';
  const normalizedUrl = embedUrl.startsWith('http') ? embedUrl : `https://${embedUrl.replace(/^\//, '')}`;
  const html = useRenderer ? await fetchRenderedHtml(normalizedUrl, logger) : await fetchHtml(normalizedUrl, logger);
  return parseEmbedPage(html, logger);
}

async function scrapeFrontPage(frontPageUrl, timezoneName = 'UTC', logger) {
  const useRenderer = process.env.SCRAPER_RENDER_WITH_JS !== 'false';
  const html = useRenderer ? await fetchRenderedHtml(frontPageUrl, logger) : await fetchHtml(frontPageUrl, logger);
  return parseFrontPage(html, timezoneName, logger);
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
};
