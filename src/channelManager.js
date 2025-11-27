const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { create } = require('xmlbuilder');
const axios = require('axios');
const { resolveStreamFromEmbed, createProgrammeFromEvent, buildDefaultStreamHeaders } = require('./scraper');

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_HYDRATION_CONCURRENCY = 5;

class ChannelManager {
  constructor({
    lifetimeHours = 24,
    logger,
    frontPageUrl,
    timezoneName = 'UTC',
    hydrationConcurrency = DEFAULT_HYDRATION_CONCURRENCY,
  }) {
    this.channels = [];
    this.programmes = [];
    this.lifetimeHours = lifetimeHours;
    this.logger = logger;
    this.frontPageUrl = frontPageUrl;
    this.timezone = timezoneName;
    this.hydrationConcurrency = Math.max(1, hydrationConcurrency || DEFAULT_HYDRATION_CONCURRENCY);
    this.playlistReady = false;
    this.hydrationInProgress = false;
  }

  async buildChannels(events, selectedCategories = []) {
    const filtered = selectedCategories.length
      ? events.filter((event) => selectedCategories.includes(event.category))
      : events;

    if (!events?.length) {
      this.logger?.warn('No events supplied to buildChannels');
    }

    const categoryCounts = filtered.reduce((acc, event) => {
      const category = event.category || 'uncategorized';
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});

    this.logger?.info(`Rebuilding channels from ${filtered.length} events`, {
      selectedCategories,
      categoryCounts,
    });

    const grouped = filtered.reduce((acc, event) => {
      const category = event.category || 'uncategorized';
      const arr = acc[category] || [];
      arr.push(event);
      acc[category] = arr;
      return acc;
    }, {});

    const newChannels = [];
    const programmes = [];

    for (const [category, eventsForCategory] of Object.entries(grouped)) {
      eventsForCategory.forEach((event, index) => {
        const id = `${category}-${index + 1}`;
        const channel = this.createChannel(id, category, event);
        newChannels.push(channel);
        programmes.push(createProgrammeFromEvent(event, id, this.lifetimeHours, this.timezone));
      });
    }

    this.channels = newChannels;
    this.programmes = programmes;
    this.playlistReady = false;
    this.hydrationInProgress = false;
    if (!this.channels.length) {
      this.logger?.warn('No channels were created from events', { selectedCategories });
    }

    return this.channels;
  }

  createChannel(id, category, event) {
    const expiresAt = dayjs().add(this.lifetimeHours, 'hour').toISOString();
    return {
      id,
      category,
      title: event.title,
      embedUrl: event.embedUrl,
      streamUrl: event.streamUrl || null,
      requestHeaders: event.requestHeaders || buildDefaultStreamHeaders(event.embedUrl),
      sourceOptions: event.sourceOptions || [],
      qualityOptions: event.qualityOptions || [],
      expiresAt,
    };
  }

  async hydrateStreams() {
    if (!this.channels.length) {
      this.playlistReady = true;
      this.hydrationInProgress = false;
      return this.channels;
    }

    this.hydrationInProgress = true;
    this.playlistReady = false;

    const workerCount = Math.min(this.hydrationConcurrency, this.channels.length);
    let currentIndex = 0;

    const worker = async () => {
      while (true) {
        const index = currentIndex;
        currentIndex += 1;
        const channel = this.channels[index];
        if (!channel) break;

        try {
          this.logger?.debug('Resolving stream for channel', { id: channel.id, embedUrl: channel.embedUrl });
          const result = await resolveStreamFromEmbed(channel.embedUrl, this.logger);
          channel.streamUrl = result.streamUrl;
          channel.requestHeaders = result.requestHeaders || channel.requestHeaders;
          channel.sourceOptions = result.sourceOptions?.length ? result.sourceOptions : channel.sourceOptions;
          channel.qualityOptions = result.qualityOptions?.length ? result.qualityOptions : channel.qualityOptions;
          this.logger?.info(`Resolved stream for channel ${channel.id}`, { streamUrl: channel.streamUrl });
        } catch (error) {
          this.logger?.warn(`Failed to resolve stream for ${channel.id}`, { error: error.message });
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));
    this.hydrationInProgress = false;
    this.playlistReady = true;
    this.logger?.info('playlist.m3u8 is ready', { channelCount: this.channels.length });
    return this.channels;
  }

  selectSource(channelId, embedUrl) {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) return null;
    channel.embedUrl = embedUrl;
    channel.streamUrl = null; // will be rehydrated on next run
    channel.requestHeaders = buildDefaultStreamHeaders(embedUrl);
    this.playlistReady = false;
    this.hydrationInProgress = false;
    this.logger?.info(`Updated source for ${channelId}`, { embedUrl });
    return channel;
  }

  async selectQuality(channelId, embedUrl) {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) return null;
    channel.embedUrl = embedUrl;
    channel.streamUrl = null;
    channel.requestHeaders = buildDefaultStreamHeaders(embedUrl);
    this.playlistReady = false;
    this.hydrationInProgress = false;
    this.logger?.info(`Updated quality for ${channelId}`, { embedUrl });
    const result = await resolveStreamFromEmbed(embedUrl, this.logger);
    channel.streamUrl = result.streamUrl;
    channel.requestHeaders = result.requestHeaders || channel.requestHeaders;
    return channel;
  }

  generatePlaylist(baseUrl) {
    if (!this.playlistReady) {
      this.logger?.warn('Attempted to generate playlist before streams were hydrated');
      return '#EXTM3U\n# Playlist is still hydrating';
    }

    const lines = ['#EXTM3U'];
    this.channels
      .filter((ch) => ch.streamUrl)
      .forEach((channel) => {
        lines.push(
          `#EXTINF:-1 tvg-id="${channel.id}" group-title="${channel.category}",${channel.category} ${this.extractIndex(channel.id)}`,
        );
        lines.push(`${baseUrl}/hls/${encodeURIComponent(channel.id)}`);
      });
    return lines.join('\n');
  }

  extractIndex(id) {
    const parts = id.split('-');
    return parts[parts.length - 1];
  }

  generateEpg() {
    const xml = create({ version: '1.0', encoding: 'UTF-8' })
      .ele('tv');
    this.channels.forEach((channel) => {
      xml
        .ele('channel', { id: channel.id })
        .ele('display-name')
        .txt(`${channel.category} ${this.extractIndex(channel.id)}`)
        .up()
        .up();
    });

    this.programmes.forEach((programme) => {
      xml
        .ele('programme', {
          start: dayjs(programme.start).tz(this.timezone).format('YYYYMMDDHHmmss ZZ'),
          stop: dayjs(programme.stop).tz(this.timezone).format('YYYYMMDDHHmmss ZZ'),
          channel: programme.channelId,
        })
        .ele('title')
        .txt(programme.title)
        .up()
        .ele('category')
        .txt(programme.category)
        .up()
        .up();
    });

    return xml.end({ pretty: true });
  }

  getChannelById(id) {
    return this.channels.find((channel) => channel.id === id);
  }

  buildStreamHeaders(channel) {
    const headers = { ...buildDefaultStreamHeaders(channel?.embedUrl), ...(channel?.requestHeaders || {}) };

    if (!headers.Referer && channel?.embedUrl) headers.Referer = channel.embedUrl;
    if (!headers.Origin && channel?.embedUrl) {
      try {
        headers.Origin = new URL(channel.embedUrl).origin;
      } catch (error) {
        // ignore
      }
    }

    return headers;
  }

  async fetchStream(channel, targetUrl) {
    const headers = this.buildStreamHeaders(channel);
    this.logger?.debug('Proxying stream fetch', { channelId: channel?.id, targetUrl });

    return axios.get(targetUrl, {
      headers,
      responseType: 'arraybuffer',
      validateStatus: (status) => status >= 200 && status < 500,
    });
  }

  rewriteManifest(manifestBody, manifestUrl, baseProxyUrl) {
    const lines = manifestBody.split(/\r?\n/);
    const rewritten = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      let absolute;
      try {
        absolute = new URL(trimmed, manifestUrl).toString();
      } catch (error) {
        return line;
      }

      return `${baseProxyUrl}/proxy?url=${encodeURIComponent(absolute)}`;
    });

    return rewritten.join('\n');
  }
}

module.exports = ChannelManager;
