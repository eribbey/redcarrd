const axios = require('axios');
const cheerio = require('cheerio');
const dayjs = require('dayjs');

async function fetchHtml(url) {
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'redcarrd-proxy/1.0' },
    proxy: false,
  });
  return response.data;
}

function parseFrontPage(html) {
  const $ = cheerio.load(html);
  const events = [];
  const seen = new Set();

  const candidates = $('[data-category], .event, article, li')
    .toArray()
    .map((el) => $(el))
    .filter((el) => el.find('iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]').length);

  candidates.forEach((el, index) => {
    const title = (el.find('h1, h2, h3, .title, .event-title').first().text() || `Event ${index + 1}`).trim();
    const category = (el.attr('data-category') || el.find('[data-category]').attr('data-category') || 'general').trim().toLowerCase();
    const embedUrl = el.find('iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]').first().attr('src');
    if (!embedUrl || seen.has(embedUrl)) return;

    const sourceOptions = el
      .find('#sourceSelect option, select[name*="source"] option')
      .toArray()
      .map((opt) => ({
        label: $(opt).text().trim() || $(opt).attr('value'),
        embedUrl: $(opt).attr('value'),
      }))
      .filter((opt) => opt.embedUrl);

    const qualityOptions = el
      .find('#qualitySelect option, select[name*="quality"] option')
      .toArray()
      .map((opt) => ({
        label: $(opt).text().trim() || $(opt).attr('value'),
        embedUrl: $(opt).attr('value'),
      }))
      .filter((opt) => opt.embedUrl);

    events.push({ title, category, embedUrl, sourceOptions, qualityOptions });
    seen.add(embedUrl);
  });

  if (!events.length) {
    $('iframe#streamPlayer, iframe[id*="streamPlayer"], iframe[src*="embed"]').each((index, el) => {
      const embedUrl = $(el).attr('src');
      const title = $(el).attr('title') || `Event ${index + 1}`;
      const category = ($(el).data('category') || 'general').toString();
      if (embedUrl && !seen.has(embedUrl)) {
        events.push({ title, category, embedUrl, sourceOptions: [], qualityOptions: [] });
        seen.add(embedUrl);
      }
    });
  }

  return events;
}

function parseEmbedPage(html) {
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

  return { streamUrl, sourceOptions, qualityOptions };
}

async function resolveStreamFromEmbed(embedUrl) {
  const html = await fetchHtml(embedUrl.startsWith('http') ? embedUrl : `https://${embedUrl.replace(/^\//, '')}`);
  return parseEmbedPage(html);
}

async function scrapeFrontPage(frontPageUrl) {
  const html = await fetchHtml(frontPageUrl);
  return parseFrontPage(html);
}

function createProgrammeFromEvent(event, channelId, lifetimeHours = 24) {
  const start = dayjs();
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
