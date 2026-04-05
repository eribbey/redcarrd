const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { create } = require('xmlbuilder');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const { createProgrammeFromEvent, buildDefaultStreamHeaders } = require('./scraper');
const { StreamResolver } = require('./streamResolver');
const Transmuxer = require('./transmuxer');
const { createSolverClientFromEnv } = require('./solverClient');

dayjs.extend(utc);
dayjs.extend(timezone);

const MAX_COOKIES_PER_CHANNEL = 50;

// SSL verification configuration
// WARNING: Disabling SSL verification exposes you to MITM attacks
// Default: disabled unless explicitly re-enabled via DISABLE_SSL_VERIFICATION=false
const DISABLE_SSL_VERIFICATION = process.env.DISABLE_SSL_VERIFICATION !== 'false';

function createHttpsAgent(logger) {
  if (DISABLE_SSL_VERIFICATION && logger) {
    logger.warn(
      'SSL certificate verification is disabled by default; set DISABLE_SSL_VERIFICATION=false to re-enable strict validation (MITM risk)',
      {
      module: 'channelManager',
      env: 'DISABLE_SSL_VERIFICATION',
      },
    );
  }
  return new https.Agent({ rejectUnauthorized: !DISABLE_SSL_VERIFICATION });
}

class ChannelManager {
  constructor({
    lifetimeHours = 24,
    logger,
    frontPageUrl,
    timezoneName = 'UTC',
  }) {
    this.channels = [];
    this.programmes = [];
    this.lifetimeHours = lifetimeHours;
    this.logger = logger;
    this.frontPageUrl = frontPageUrl;
    this.timezone = timezoneName;
    this.streamResolver = new StreamResolver({ logger });
    this.transmuxer = new Transmuxer({ logger });
    this.solverClient = createSolverClientFromEnv(logger);
    this.running = true;
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

    // Reset dead channels to pending on event refresh
    const preserveStatus = existing?.status && existing.status !== 'dead';
    const status = embedUrlChanged ? 'pending' : (preserveStatus ? existing.status : 'pending');

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
      streamMode: existing?.streamMode || null,
      streamHeaders: embedUrlChanged ? null : existing?.streamHeaders || null,
      expiresAt,
      // Lifecycle fields
      status,
      resolvedAt: embedUrlChanged ? null : existing?.resolvedAt || null,
      lastHealthCheck: embedUrlChanged ? null : existing?.lastHealthCheck || null,
      failCount: (embedUrlChanged || !preserveStatus) ? 0 : existing?.failCount || 0,
      nextRetryAt: (embedUrlChanged || !preserveStatus) ? null : existing?.nextRetryAt || null,
      healthFailCount: embedUrlChanged ? 0 : existing?.healthFailCount || 0,
      healthFailTimestamps: embedUrlChanged ? [] : existing?.healthFailTimestamps || [],
    };
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
    channel.streamMode = null;
    channel.status = 'pending';
    channel.failCount = 0;
    channel.nextRetryAt = null;
    channel.healthFailCount = 0;
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
    channel.streamMode = null;
    channel.status = 'pending';
    channel.failCount = 0;
    channel.nextRetryAt = null;
    channel.healthFailCount = 0;
    this.logger?.info(`Updated quality for ${channelId}`, { embedUrl });
    return channel;
  }

  generatePlaylist(baseUrl) {
    const lines = ['#EXTM3U'];
    this.channels
      .filter((ch) => (ch.status === 'healthy' || ch.status === 'resolved') && ch.streamUrl)
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
    const healthyIds = new Set(
      this.channels.filter((ch) => ch.status === 'healthy' || ch.status === 'resolved').map((ch) => ch.id)
    );

    this.channels.filter((ch) => healthyIds.has(ch.id)).forEach((channel) => {
      xml
        .ele('channel', { id: channel.id })
        .ele('display-name')
        .txt(channel.title || channel.category)
        .up()
        .up();
    });

    this.programmes.filter((p) => healthyIds.has(p.channelId)).forEach((programme) => {
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
    // streamHeaders from resolver take priority (they have the correct Referer/Origin from detection)
    const headers = { ...buildDefaultStreamHeaders(channel?.embedUrl), ...(channel?.requestHeaders || {}), ...(channel?.streamHeaders || {}) };

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

    // Add browser-like headers that CDNs check for (Sec-Fetch-*, Accept-Language, etc.)
    // Without these, many CDNs reject requests as non-browser/bot traffic
    if (!headers['Accept-Language']) headers['Accept-Language'] = 'en-US,en;q=0.9';
    if (!headers['Sec-Fetch-Dest']) headers['Sec-Fetch-Dest'] = 'empty';
    if (!headers['Sec-Fetch-Mode']) headers['Sec-Fetch-Mode'] = 'cors';
    if (!headers['Sec-Fetch-Site']) headers['Sec-Fetch-Site'] = 'cross-site';

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
      proxy: false,
      httpsAgent: createHttpsAgent(this.logger),
    });

    this.updateCookies(channel, response.headers['set-cookie']);

    if (response.status === 403 || response.status === 410) {
      const bodyPreview = response.data ? response.data.toString('utf8').substring(0, 500) : '';
      this.logger.warn('Upstream rejected request', {
        channelId: channel.id,
        status: response.status,
        targetUrl: targetUrl.substring(0, 200),
        referer: headers.Referer,
        userAgent: headers['User-Agent']?.substring(0, 50),
        hasCookie: Boolean(headers.Cookie),
        hasSecFetch: Boolean(headers['Sec-Fetch-Mode']),
        bodyPreview,
      });
      channel.streamUrl = null;
      channel.resolvedAt = null;
      channel.status = 'pending';
      const err = new Error(`Upstream returned ${response.status}`);
      err.upstreamStatus = response.status;
      throw err;
    }

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

  async resolveStream(channel) {
    // Build list of embed URLs to try: current first, then remaining sourceOptions
    const embedUrls = [channel.embedUrl];
    if (channel.sourceOptions?.length) {
      for (const opt of channel.sourceOptions) {
        if (opt.embedUrl && !embedUrls.includes(opt.embedUrl)) {
          embedUrls.push(opt.embedUrl);
        }
      }
    }

    // Pre-fetch solver cookies to bypass anti-bot (WASM lock, Cloudflare, etc.)
    let solverCookies = null;
    if (this.solverClient?.enabled) {
      try {
        this.logger.info('Pre-fetching solver cookies', { channelId: channel.id, embedUrl: channel.embedUrl });
        const solverResult = await this.solverClient.solve(channel.embedUrl);
        if (solverResult?.normalizedCookies?.length) {
          solverCookies = solverResult.normalizedCookies;
          this.logger.info('Solver cookies obtained', { channelId: channel.id, cookieCount: solverCookies.length });
        }
      } catch (error) {
        this.logger.warn('Solver pre-fetch failed', { channelId: channel.id, error: error.message });
      }
    }

    // Try each embed URL until one resolves
    for (const embedUrl of embedUrls) {
      this.logger.info('Attempting stream resolution', {
        channelId: channel.id,
        embedUrl,
        sourceIndex: embedUrls.indexOf(embedUrl) + 1,
        totalSources: embedUrls.length,
      });

      const result = await this.streamResolver.resolve(embedUrl, {
        referer: channel.referer || process.env.FRONT_PAGE_URL || 'https://streamed.pk',
        maxAttempts: parseInt(process.env.RESTREAM_MAX_ATTEMPTS) || 2,
        solverCookies,
      });

      if (result) {
        channel.embedUrl = embedUrl; // Update to the working source
        channel.streamUrl = result.url;
        channel.streamHeaders = result.headers;
        channel.streamMode = result.type === 'hls' ? 'hls' : 'transmux';
        channel.resolvedAt = Date.now();

        this.logger.info('Stream resolved', {
          channelId: channel.id,
          type: result.type,
          streamMode: channel.streamMode,
          embedUrl,
        });

        return result;
      }

      this.logger.warn('Source failed, trying next', { channelId: channel.id, embedUrl });
    }

    this.logger.warn('All sources exhausted', { channelId: channel.id, sourcesTried: embedUrls.length });
    return null;
  }

  async ensureTransmuxed(channel) {
    if (!channel.streamUrl) {
      this.logger.warn('No stream URL for transmuxing', { channelId: channel.id });
      return null;
    }

    try {
      const job = await this.transmuxer.ensureJob(
        channel.id,
        channel.streamUrl,
        channel.streamHeaders || {}
      );
      return job;
    } catch (error) {
      this.logger.error('Transmuxing failed', {
        channelId: channel.id,
        streamUrl: channel.streamUrl,
        error: error.message,
      });
      return null;
    }
  }

  getTransmuxJob(channelId) {
    return this.transmuxer.jobs.get(channelId) || null;
  }

  async cleanupTransmuxJobs(ids = []) {
    if (!ids.length) return;
    this.logger?.info('Evicting transmux jobs', { channelIds: ids });
    await Promise.all(ids.map((id) => this.transmuxer.cleanupJob?.(id)).filter(Boolean));
  }

  getNextChannelForResolution() {
    const now = Date.now();
    const ttlMs = (parseInt(process.env.STREAM_URL_TTL_MINUTES) || 10) * 60 * 1000;
    const maxFailures = parseInt(process.env.RESOLUTION_MAX_FAILURES) || 5;

    // Priority 1: pending channels
    const pending = this.channels.filter((ch) => ch.status === 'pending');
    if (pending.length) return pending[pending.length - 1]; // newest first

    // Priority 2: failed channels past their backoff
    const retriable = this.channels.filter(
      (ch) => ch.status === 'failed' && ch.failCount < maxFailures && (!ch.nextRetryAt || now >= ch.nextRetryAt)
    );
    if (retriable.length) return retriable[0];

    // Priority 3: expiring channels (>80% of TTL)
    const expiring = this.channels.filter(
      (ch) => (ch.status === 'healthy' || ch.status === 'resolved') &&
              ch.streamUrl && ch.resolvedAt && (now - ch.resolvedAt > ttlMs * 0.8)
    );
    if (expiring.length) return expiring[0];

    return null;
  }

  async resolveAndUpdateStatus(channel) {
    const maxFailures = parseInt(process.env.RESOLUTION_MAX_FAILURES) || 5;
    const BACKOFF_STEPS = [30000, 60000, 120000, 300000, 600000]; // 30s, 1m, 2m, 5m, 10m

    try {
      const result = await this.resolveStream(channel);

      if (result) {
        // Promote directly to healthy — Playwright already proved the stream exists.
        // Waiting for a separate HTTP health check would fail on CDNs that reject
        // non-browser requests (different TLS fingerprint, missing session cookies).
        channel.status = 'healthy';
        channel.failCount = 0;
        channel.nextRetryAt = null;
        this.logger.info('Channel resolved and promoted to healthy', { channelId: channel.id, streamUrl: result.url });
      } else {
        channel.failCount = (channel.failCount || 0) + 1;
        if (channel.failCount >= maxFailures) {
          channel.status = 'dead';
          this.logger.warn('Channel marked dead after max failures', { channelId: channel.id, failCount: channel.failCount });
        } else {
          channel.status = 'failed';
          const backoffMs = BACKOFF_STEPS[Math.min(channel.failCount - 1, BACKOFF_STEPS.length - 1)];
          channel.nextRetryAt = Date.now() + backoffMs;
          this.logger.info('Channel resolution failed, will retry', { channelId: channel.id, failCount: channel.failCount, nextRetryIn: backoffMs });
        }
      }
    } catch (error) {
      channel.failCount = (channel.failCount || 0) + 1;
      if (channel.failCount >= maxFailures) {
        channel.status = 'dead';
        this.logger.warn('Channel marked dead after max failures', { channelId: channel.id, failCount: channel.failCount });
      } else {
        channel.status = 'failed';
        const backoffMs = BACKOFF_STEPS[Math.min(channel.failCount - 1, BACKOFF_STEPS.length - 1)];
        channel.nextRetryAt = Date.now() + backoffMs;
        this.logger.warn('Channel resolution threw error', { channelId: channel.id, error: error.message, failCount: channel.failCount });
      }
    }
  }

  async runResolutionLoop() {
    const sleepMs = parseInt(process.env.RESOLUTION_LOOP_SLEEP_MS) || 2000;

    this.logger.info('Resolution loop started');

    while (this.running) {
      const channel = this.getNextChannelForResolution();

      if (channel) {
        await this.resolveAndUpdateStatus(channel);
      }

      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }

    this.logger.info('Resolution loop stopped');
  }

  async checkChannelHealth(channel) {
    const rapidFailThreshold = parseInt(process.env.HEALTH_RAPID_FAIL_THRESHOLD) || 3;
    const rapidFailWindowMs = parseInt(process.env.HEALTH_RAPID_FAIL_WINDOW_MS) || 600000;

    // Trust stream URLs for a grace period after resolution — the Playwright browser
    // already validated the stream exists. Many CDNs reject follow-up axios requests
    // (different TLS fingerprint, missing browser session) so health checks via HTTP
    // will 403 even though the stream works fine for real browsers/IPTV clients.
    const healthGracePeriodMs = parseInt(process.env.HEALTH_GRACE_PERIOD_MS) || 300000; // 5 min default
    if (channel.resolvedAt && Date.now() - channel.resolvedAt < healthGracePeriodMs) {
      if (channel.status !== 'healthy') {
        channel.status = 'healthy';
        this.logger.debug('Granting health pass to recently resolved channel', { channelId: channel.id });
      }
      channel.lastHealthCheck = Date.now();
      return;
    }

    try {
      const headers = this.buildStreamHeaders(channel);
      const isHls = this.isHlsChannel(channel);

      let healthy;
      let reason = '';
      if (isHls) {
        const response = await axios.get(channel.streamUrl, {
          headers,
          responseType: 'arraybuffer',
          timeout: 10000,
          validateStatus: (status) => status >= 200 && status < 500,
          proxy: false,
          httpsAgent: createHttpsAgent(),
        });
        healthy = response.status >= 200 && response.status < 300;
        if (healthy) {
          const body = response.data?.toString('utf8') || '';
          // Accept both media playlists (#EXTINF) and multi-variant playlists (#EXT-X-STREAM-INF)
          healthy = body.includes('#EXTINF') || body.includes('#EXT-X-STREAM-INF');
          if (!healthy) {
            reason = `HTTP ${response.status} but invalid manifest (${body.substring(0, 100)})`;
          }
        } else {
          reason = `HTTP ${response.status}`;
        }
      } else {
        const response = await axios.head(channel.streamUrl, {
          headers,
          timeout: 10000,
          validateStatus: (status) => status >= 200 && status < 500,
          proxy: false,
          httpsAgent: createHttpsAgent(),
        });
        healthy = response.status >= 200 && response.status < 300;
        if (!healthy) {
          reason = `HTTP ${response.status}`;
        }
      }

      if (healthy) {
        channel.status = 'healthy';
        channel.lastHealthCheck = Date.now();
        this.logger.info('Health check passed', { channelId: channel.id, streamUrl: channel.streamUrl?.substring(0, 100) });
      } else {
        const isAuthFailure = reason.startsWith('HTTP 403') || reason.startsWith('HTTP 410');
        this.logger.warn('Health check failed', {
          channelId: channel.id,
          streamUrl: channel.streamUrl?.substring(0, 100),
          reason,
          isAuthFailure,
          referer: headers.Referer?.substring(0, 100),
        });

        if (isAuthFailure) {
          // Auth/token failures are not stream death — immediately queue for re-resolution
          // without counting against the rapid fail threshold
          channel.status = 'pending';
          channel.streamUrl = null;
          channel.resolvedAt = null;
          channel.failCount = 0;
          channel.nextRetryAt = null;
          this.logger.info('Auth failure detected, queued for immediate re-resolution', {
            channelId: channel.id, reason,
          });
        } else {
          this._markUnhealthy(channel, reason || 'non-2xx or invalid manifest', rapidFailThreshold, rapidFailWindowMs);
        }
      }
    } catch (error) {
      const isAuthError = error.response?.status === 403 || error.response?.status === 410;
      this.logger.warn('Health check error', {
        channelId: channel.id,
        streamUrl: channel.streamUrl?.substring(0, 100),
        error: error.message,
        isAuthError,
      });

      if (isAuthError) {
        channel.status = 'pending';
        channel.streamUrl = null;
        channel.resolvedAt = null;
        channel.failCount = 0;
        channel.nextRetryAt = null;
        this.logger.info('Auth error in health check, queued for re-resolution', {
          channelId: channel.id,
        });
      } else {
        this._markUnhealthy(channel, error.message, rapidFailThreshold, rapidFailWindowMs);
      }
    }
  }

  _markUnhealthy(channel, reason, rapidFailThreshold, rapidFailWindowMs) {
    const now = Date.now();

    if (!channel.healthFailTimestamps) channel.healthFailTimestamps = [];
    channel.healthFailTimestamps.push(now);

    // Prune timestamps outside the window
    channel.healthFailTimestamps = channel.healthFailTimestamps.filter(
      (ts) => now - ts < rapidFailWindowMs
    );

    if (channel.healthFailTimestamps.length >= rapidFailThreshold) {
      channel.status = 'dead';
      this.logger.warn('Channel marked dead after rapid health failures', {
        channelId: channel.id,
        failuresInWindow: channel.healthFailTimestamps.length,
        reason,
      });
    } else {
      channel.status = 'pending';
      channel.streamUrl = null;
      channel.resolvedAt = null;
      channel.failCount = 0;
      channel.nextRetryAt = null;
      this.logger.warn('Channel health check failed, queued for re-resolution', {
        channelId: channel.id, reason,
        failuresInWindow: channel.healthFailTimestamps.length,
      });
    }
  }

  async runHealthCheckLoop() {
    const intervalSeconds = parseInt(process.env.HEALTH_CHECK_INTERVAL_SECONDS) || 30;

    this.logger.info('Health check loop started', { intervalSeconds });

    while (this.running) {
      const checkable = this.channels.filter(
        (ch) => ch.status === 'resolved' || ch.status === 'healthy'
      );

      for (const channel of checkable) {
        if (!this.running) break;
        await this.checkChannelHealth(channel);
      }

      // Clean up transmux jobs for channels that went unhealthy
      const unhealthyIds = this.channels
        .filter((ch) => ch.status !== 'healthy' && ch.status !== 'resolved')
        .map((ch) => ch.id);
      await this.cleanupTransmuxJobs(unhealthyIds);

      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    }

    this.logger.info('Health check loop stopped');
  }

  async cleanupRestreamJobs(ids = []) {
    if (!ids.length) return;
    this.logger?.info('Evicting stream resolver jobs', { channelIds: ids });
    // StreamResolver doesn't maintain persistent jobs, so this is a no-op
  }
}

module.exports = ChannelManager;
