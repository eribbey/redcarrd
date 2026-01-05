const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { create } = require('xmlbuilder');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const { createProgrammeFromEvent, buildDefaultStreamHeaders } = require('./scraper');
const Transmuxer = require('./transmuxer');
const Restreamer = require('./restreamer');

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_HYDRATION_CONCURRENCY = 5;
const MAX_COOKIES_PER_CHANNEL = 50;

// SSL verification configuration
// WARNING: Disabling SSL verification exposes you to MITM attacks
const DISABLE_SSL_VERIFICATION = process.env.DISABLE_SSL_VERIFICATION === 'true';

function createHttpsAgent(logger) {
  if (DISABLE_SSL_VERIFICATION && logger) {
    logger.warn('SSL certificate verification is disabled - this exposes you to MITM attacks', {
      module: 'channelManager',
      env: 'DISABLE_SSL_VERIFICATION',
    });
  }
  return new https.Agent({ rejectUnauthorized: !DISABLE_SSL_VERIFICATION });
}

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
    this.transmuxer = new Transmuxer({ logger });
    this.transmuxJobs = new Map();
    this.restreamer = new Restreamer({ logger });
    this.restreamJobs = new Map();
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

    const existingChannels = new Map(this.channels.map((channel) => [channel.id, channel]));
    const programmes = [];
    const channels = [];
    const expiresAt = dayjs().add(this.lifetimeHours, 'hour').toISOString();
    let added = 0;
    let updated = 0;

    filtered.forEach((event) => {
      const id = this.generateChannelId(event);
      const existing = existingChannels.get(id);
      const channel = this.createOrUpdateChannel(id, event, existing, expiresAt);
      channels.push(channel);
      programmes.push(createProgrammeFromEvent(event, id, this.lifetimeHours, this.timezone));
      if (existing) {
        updated += 1;
      } else {
        added += 1;
      }
    });

    const newIds = new Set(channels.map((channel) => channel.id));
    const now = dayjs();
    const removedChannels = this.channels.filter(
      (channel) => !newIds.has(channel.id) || (channel.expiresAt && dayjs(channel.expiresAt).isBefore(now)),
    );
    const removed = removedChannels.length;

    this.channels = channels;
    this.programmes = programmes;
    this.playlistReady = false;
    this.hydrationInProgress = false;
    const removedIds = removedChannels.map((channel) => channel.id);
    this.cleanupTransmuxJobs(removedIds);
    this.cleanupRestreamJobs(removedIds);

    this.logger?.info('Reconciling channels', {
      selectedCategories,
      categoryCounts,
      counts: { total: filtered.length, added, updated, removed },
    });

    if (!this.channels.length) {
      this.logger?.warn('No channels were created from events', { selectedCategories });
    }

    return this.channels;
  }

  generateChannelId(event) {
    const key = `${event.title || ''}|${event.startTime || event.start || ''}|${event.embedUrl || ''}`;
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
    return `ch-${hash}`;
  }

  createOrUpdateChannel(id, event, existing, expiresAt) {
    const embedUrlChanged = existing?.embedUrl && existing.embedUrl !== event.embedUrl;
    const requestHeaders =
      event.requestHeaders ||
      (embedUrlChanged ? buildDefaultStreamHeaders(event.embedUrl) : existing?.requestHeaders || buildDefaultStreamHeaders(event.embedUrl));

    return {
      id,
      category: event.category || 'uncategorized',
      title: event.title,
      embedUrl: event.embedUrl,
      streamUrl: embedUrlChanged ? null : event.streamUrl || existing?.streamUrl || null,
      streamMimeType: embedUrlChanged ? null : event.streamMimeType || existing?.streamMimeType || null,
      requestHeaders,
      sourceOptions: event.sourceOptions || existing?.sourceOptions || [],
      qualityOptions: event.qualityOptions || existing?.qualityOptions || [],
      cookies: embedUrlChanged ? [] : existing?.cookies || [],
      selectedSource: event.sourceOptions?.length
        ? { source: event.sourceOptions[0].source, sourceId: event.sourceOptions[0].sourceId }
        : existing?.selectedSource || null,
      streamMode: existing?.streamMode || 'restream',
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
          this.logger?.debug('Restreaming embed for channel', { id: channel.id, embedUrl: channel.embedUrl });
          const job = await this.ensureRestreamed(channel);
          if (job) {
            channel.streamUrl = job.manifestPath;
            channel.streamMimeType = 'application/vnd.apple.mpegurl';
            channel.streamMode = 'restream';
            this.logger?.info(`Restream ready for channel ${channel.id}`, { manifestPath: job.manifestPath });
          } else {
            this.logger?.warn('Restream job could not be created', { id: channel.id });
          }
        } catch (error) {
          this.logger?.warn(`Failed to restream embed for ${channel.id}`, {
            error: error.message,
            exitCode: error.exitCode,
            signal: error.signal,
            stderr: error.stderr,
          });
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
    const selectedOption = channel.sourceOptions?.find((option) => option.embedUrl === embedUrl);
    channel.embedUrl = embedUrl;
    channel.streamUrl = null; // will be rehydrated on next run
    channel.requestHeaders = selectedOption?.requestHeaders || buildDefaultStreamHeaders(embedUrl);
    channel.selectedSource = selectedOption
      ? { source: selectedOption.source, sourceId: selectedOption.sourceId }
      : channel.selectedSource;
    channel.cookies = [];
    channel.streamMode = 'restream';
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
    channel.cookies = [];
    channel.streamMode = 'restream';
    this.playlistReady = false;
    this.hydrationInProgress = false;
    this.logger?.info(`Updated quality for ${channelId}`, { embedUrl });
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
          `#EXTINF:-1 tvg-id="${channel.id}" group-title="${channel.category}",${channel.title || channel.category}`,
        );
        lines.push(`${baseUrl}/hls/${encodeURIComponent(channel.id)}`);
      });
    return lines.join('\n');
  }

  generateEpg() {
    const xml = create('tv', { version: '1.0', encoding: 'UTF-8' });
    this.channels.forEach((channel) => {
      xml
        .ele('channel', { id: channel.id })
        .ele('display-name')
        .txt(channel.title || channel.category)
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
        this.logger?.debug('Failed to set Origin header from embedUrl', {
          channelId: channel?.id,
          embedUrl: channel?.embedUrl,
          error: error.message,
        });
      }
    }

    if (channel?.cookies?.length) {
      headers.Cookie = channel.cookies.join('; ');
    }

    return headers;
  }

  updateCookies(channel, setCookieHeaders = []) {
    if (!channel || !Array.isArray(setCookieHeaders) || !setCookieHeaders.length) return;

    const cookieMap = new Map();

    (channel.cookies || []).forEach((cookie) => {
      const [name] = cookie.split('=');
      if (name) {
        cookieMap.set(name.trim(), cookie.trim());
      }
    });

    setCookieHeaders.forEach((raw) => {
      if (!raw) return;
      const [pair] = raw.split(';');
      const [name] = pair.split('=');
      if (name) {
        cookieMap.set(name.trim(), pair.trim());
      }
    });

    // Enforce maximum cookie limit per channel to prevent unbounded memory growth
    if (cookieMap.size > MAX_COOKIES_PER_CHANNEL) {
      this.logger?.warn('Cookie limit exceeded, keeping most recent cookies', {
        channelId: channel.id,
        cookieCount: cookieMap.size,
        limit: MAX_COOKIES_PER_CHANNEL,
      });
      const entries = Array.from(cookieMap.entries());
      cookieMap.clear();
      entries.slice(-MAX_COOKIES_PER_CHANNEL).forEach(([key, value]) => cookieMap.set(key, value));
    }

    channel.cookies = Array.from(cookieMap.values());
  }

  async fetchStream(channel, targetUrl) {
    const headers = this.buildStreamHeaders(channel);
    this.logger?.debug('Proxying stream fetch', { channelId: channel?.id, targetUrl });

    const response = await axios.get(targetUrl, {
      headers,
      responseType: 'arraybuffer',
      validateStatus: (status) => status >= 200 && status < 500,
      httpsAgent: createHttpsAgent(this.logger),
    });

    this.updateCookies(channel, response.headers['set-cookie']);

    return response;
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

  rewriteLocalManifest(manifestBody, baseProxyUrl) {
    const lines = manifestBody.split(/\r?\n/);
    const rewritten = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      return `${baseProxyUrl}/${encodeURIComponent(trimmed)}`;
    });

    return rewritten.join('\n');
  }

  isHlsChannel(channel) {
    const mime = channel?.streamMimeType || '';
    const url = channel?.streamUrl || '';
    return /mpegurl/i.test(mime) || url.includes('.m3u8');
  }

  isRestreamChannel(channel) {
    return channel?.streamMode === 'restream';
  }

  async ensureTransmuxed(channel) {
    if (!channel?.streamUrl) return null;
    const headers = this.buildStreamHeaders(channel);
    const job = await this.transmuxer.ensureJob(channel.id, channel.streamUrl, headers);
    this.transmuxJobs.set(channel.id, job);
    this.logger?.info('Transmux job ready for channel', { channelId: channel.id, workDir: job.workDir });
    return job;
  }

  async ensureRestreamed(channel) {
    if (!channel?.embedUrl) return null;
    const existing = this.restreamer.getJob(channel.id);
    if (existing && existing.embedUrl !== channel.embedUrl) {
      await this.restreamer.cleanupJob(channel.id);
      this.restreamJobs.delete(channel.id);
    }

    const job = await this.restreamer.ensureJob(channel.id, channel.embedUrl);
    if (job) this.restreamJobs.set(channel.id, job);
    return job;
  }

  getTransmuxJob(channelId) {
    return (
      this.transmuxer.getJob(channelId) ||
      this.transmuxJobs.get(channelId) ||
      this.restreamer.getJob(channelId) ||
      this.restreamJobs.get(channelId) ||
      null
    );
  }

  async cleanupTransmuxJobs(ids = []) {
    if (!ids.length) return;
    this.logger?.info('Evicting transmux jobs', { channelIds: ids });
    await Promise.all(ids.map((id) => this.transmuxer.cleanupJob(id)));
  }

  async cleanupRestreamJobs(ids = []) {
    if (!ids.length) return;
    this.logger?.info('Evicting restream jobs', { channelIds: ids });
    await Promise.all(ids.map((id) => this.restreamer.cleanupJob(id)));
  }
}

module.exports = ChannelManager;
