const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { create } = require('xmlbuilder');
const { resolveStreamFromEmbed, createProgrammeFromEvent } = require('./scraper');

dayjs.extend(utc);
dayjs.extend(timezone);

class ChannelManager {
  constructor({ lifetimeHours = 24, logger, frontPageUrl, timezoneName = 'UTC' }) {
    this.channels = [];
    this.programmes = [];
    this.lifetimeHours = lifetimeHours;
    this.logger = logger;
    this.frontPageUrl = frontPageUrl;
    this.timezone = timezoneName;
  }

  async buildChannels(events, selectedCategories = []) {
    const filtered = selectedCategories.length
      ? events.filter((event) => selectedCategories.includes(event.category))
      : events;

    this.logger?.info(`Rebuilding channels from ${filtered.length} events`);

    const grouped = filtered.reduce((acc, event) => {
      const arr = acc[event.category] || [];
      arr.push(event);
      acc[event.category] = arr;
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
      sourceOptions: event.sourceOptions || [],
      qualityOptions: event.qualityOptions || [],
      expiresAt,
    };
  }

  async hydrateStreams() {
    for (const channel of this.channels) {
      try {
        const result = await resolveStreamFromEmbed(channel.embedUrl, this.logger);
        channel.streamUrl = result.streamUrl;
        channel.sourceOptions = result.sourceOptions?.length ? result.sourceOptions : channel.sourceOptions;
        channel.qualityOptions = result.qualityOptions?.length ? result.qualityOptions : channel.qualityOptions;
        this.logger?.info(`Resolved stream for channel ${channel.id}`, { streamUrl: channel.streamUrl });
      } catch (error) {
        this.logger?.warn(`Failed to resolve stream for ${channel.id}`, { error: error.message });
      }
    }
    return this.channels;
  }

  selectSource(channelId, embedUrl) {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) return null;
    channel.embedUrl = embedUrl;
    channel.streamUrl = null; // will be rehydrated on next run
    this.logger?.info(`Updated source for ${channelId}`, { embedUrl });
    return channel;
  }

  async selectQuality(channelId, embedUrl) {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) return null;
    channel.embedUrl = embedUrl;
    channel.streamUrl = null;
    this.logger?.info(`Updated quality for ${channelId}`, { embedUrl });
    const result = await resolveStreamFromEmbed(embedUrl, this.logger);
    channel.streamUrl = result.streamUrl;
    return channel;
  }

  generatePlaylist(baseUrl) {
    const lines = ['#EXTM3U'];
    this.channels
      .filter((ch) => ch.streamUrl)
      .forEach((channel) => {
        lines.push(`#EXTINF:-1 tvg-id="${channel.id}" group-title="${channel.category}",${channel.category} ${this.extractIndex(channel.id)}`);
        lines.push(channel.streamUrl);
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
}

module.exports = ChannelManager;
