const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const Logger = require('./logger');
const { loadConfig, saveConfig, defaultConfig } = require('./config');
const ChannelManager = require('./channelManager');
const { scrapeFrontPage } = require('./scraper');

const PORT = process.env.PORT || 3005;
const FRONT_PAGE_URL = process.env.FRONT_PAGE_URL || 'https://streamed.pk';

const app = express();
const logger = new Logger();

app.use(cors());
app.use(bodyParser.json());
app.use(morgan('dev'));
app.use(express.static(__dirname + '/public'));

let config = loadConfig(logger);
let lastRebuild = null;

const channelManager = new ChannelManager({
  lifetimeHours: config.lifetimeHours || defaultConfig.lifetimeHours,
  logger,
  frontPageUrl: FRONT_PAGE_URL,
  timezoneName: config.timezone || defaultConfig.timezone,
});

async function refreshEvents() {
  const timezone = config.timezone || defaultConfig.timezone;
  const metaContext = { frontPageUrl: FRONT_PAGE_URL, timezone };

  try {
    logger.info('Starting event refresh', metaContext);

    const events = await scrapeFrontPage(FRONT_PAGE_URL, timezone, logger);
    const categoryCounts = events.reduce((acc, event) => {
      const category = (event.category || 'uncategorized').toString();
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});

    logger.info('Scraped front page events', { ...metaContext, totalEvents: events.length, categoryCounts });
    if (!events.length) {
      logger.warn('No events parsed from front page', metaContext);
    }

    await channelManager.buildChannels(events, config.categories);
    lastRebuild = new Date().toISOString();
    logger.info('Event refresh completed', { ...metaContext, channelCount: channelManager.channels.length });
  } catch (error) {
    logger.error('Failed to refresh events', { ...metaContext, error: error.message, stack: error.stack });
  }
}

let eventLoopTimer = null;
function scheduleEventLoop() {
  if (eventLoopTimer) clearInterval(eventLoopTimer);
  const minutes = parseInt(process.env.EVENT_POLL_INTERVAL_MINUTES) || config.rebuildIntervalMinutes || defaultConfig.rebuildIntervalMinutes;
  eventLoopTimer = setInterval(refreshEvents, minutes * 60 * 1000);
  logger.info(`Scheduled event refresh every ${minutes} minutes`);
}

(async () => {
  await refreshEvents();
  scheduleEventLoop();
  channelManager.runResolutionLoop();
  channelManager.runHealthCheckLoop();
})();

function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  channelManager.running = false;
  if (eventLoopTimer) clearInterval(eventLoopTimer);
  channelManager.streamResolver.closeBrowser().then(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.get('/api/state', (req, res) => {
  const statusCounts = channelManager.channels.reduce((acc, ch) => {
    acc[ch.status] = (acc[ch.status] || 0) + 1;
    return acc;
  }, {});

  res.json({
    config,
    channels: channelManager.channels,
    logs: logger.getEntries(),
    lastRebuild,
    statusCounts,
  });
});

app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  const sendEntry = (entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  logger
    .getEntries()
    .slice()
    .reverse()
    .forEach(sendEntry);

  logger.on('entry', sendEntry);

  req.on('close', () => {
    logger.off('entry', sendEntry);
  });
});

app.post('/api/config', (req, res) => {
  const { categories, rebuildIntervalMinutes, lifetimeHours, timezone } = req.body;

  // Validate and sanitize input
  if (categories !== undefined) {
    if (!Array.isArray(categories)) {
      return res.status(400).json({ error: 'categories must be an array' });
    }
    config.categories = categories;
  }

  if (rebuildIntervalMinutes !== undefined) {
    const interval = Number(rebuildIntervalMinutes);
    if (!Number.isFinite(interval) || interval < 1 || interval > 10080) {
      return res.status(400).json({ error: 'rebuildIntervalMinutes must be between 1 and 10080' });
    }
    config.rebuildIntervalMinutes = interval;
  }

  if (lifetimeHours !== undefined) {
    const lifetime = Number(lifetimeHours);
    if (!Number.isFinite(lifetime) || lifetime < 1 || lifetime > 720) {
      return res.status(400).json({ error: 'lifetimeHours must be between 1 and 720' });
    }
    config.lifetimeHours = lifetime;
    channelManager.lifetimeHours = lifetime;
  }

  if (timezone !== undefined) {
    if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 100) {
      return res.status(400).json({ error: 'timezone must be a non-empty string' });
    }
    config.timezone = timezone;
    channelManager.timezone = timezone;
  }

  saveConfig(config, logger);
  scheduleEventLoop();
  res.json({ config });
});

app.post('/api/rebuild', async (req, res) => {
  await refreshEvents();
  res.json({ status: 'ok', lastRebuild });
});

app.post('/api/channel/:id/source', (req, res) => {
  const channel = channelManager.selectSource(req.params.id, req.body.embedUrl);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  res.json(channel);
});

app.post('/api/channel/:id/quality', async (req, res) => {
  const channel = await channelManager.selectQuality(req.params.id, req.body.embedUrl);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  res.json(channel);
});

app.get('/playlist.m3u8', (req, res) => {
  res.set('Content-Type', 'application/x-mpegurl');
  res.send(channelManager.generatePlaylist(`${req.protocol}://${req.get('host')}`));
});

function isHlsContentType(contentType = '') {
  return /application\/(vnd\.apple\.mpegurl|x-mpegURL|mpegurl)/i.test(contentType);
}

function buildProxyBaseUrl(req, channelId) {
  return `${req.protocol}://${req.get('host')}/hls/${encodeURIComponent(channelId)}`;
}

async function handleHlsResponse(req, res, targetUrl, channel, isRootManifest = false) {
  try {
    const response = await channelManager.fetchStream(channel, targetUrl);

    const contentType = response.headers['content-type'] || 'application/octet-stream';
    const shouldRewrite = isRootManifest || isHlsContentType(contentType) || targetUrl.includes('.m3u8');

    if (shouldRewrite) {
      const manifest = response.data?.toString('utf8') || '';
      const proxyBase = buildProxyBaseUrl(req, channel.id);
      const rewritten = channelManager.rewriteManifest(manifest, targetUrl, proxyBase);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    res.set('Content-Type', contentType);
    return res.send(response.data);
  } catch (error) {
    // Return 503 for upstream rejections so IPTV clients back off
    const status = error.upstreamStatus === 403 || error.upstreamStatus === 410 ? 503 : 502;
    logger.error('Failed to proxy HLS request', {
      channelId: channel?.id,
      targetUrl,
      status: error.upstreamStatus || error.response?.status,
      message: error.message,
    });
    return res.status(status).send(
      status === 503
        ? 'Stream expired, re-resolving'
        : 'Upstream error fetching stream'
    );
  }
}

async function serveTransmuxedManifest(req, res, channel) {
  try {
    const job = await channelManager.ensureTransmuxed(channel);
    const manifestBody = await fs.promises.readFile(job.manifestPath, 'utf8');
    const base = `${req.protocol}://${req.get('host')}/hls/${encodeURIComponent(channel.id)}/local`;
    const rewritten = channelManager.rewriteLocalManifest(manifestBody, base);
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(rewritten);
  } catch (error) {
    logger.error('Failed to serve transmuxed manifest', {
      channelId: channel?.id,
      targetUrl: channel?.streamUrl,
      message: error.message,
    });
    return res.status(502).send('Failed to transmux stream');
  }
}

app.get('/hls/:id', async (req, res) => {
  const channel = channelManager.getChannelById(req.params.id);
  if (!channel || !channel.streamUrl) {
    return res.status(404).send('Channel not found or stream unavailable');
  }

  if (channel.streamMode === 'transmux') {
    return serveTransmuxedManifest(req, res, channel);
  }

  return handleHlsResponse(req, res, channel.streamUrl, channel, true);
});

app.get('/hls/:id/proxy', async (req, res) => {
  const channel = channelManager.getChannelById(req.params.id);
  const targetUrl = req.query.url;

  if (!channel || !channel.streamUrl) {
    return res.status(404).send('Channel not found or stream unavailable');
  }

  if (channel.streamMode === 'transmux') {
    return res.status(400).send('Channel is being transmuxed; direct proxy not available');
  }

  if (!targetUrl) {
    return res.status(400).send('Missing url parameter');
  }

  return handleHlsResponse(req, res, targetUrl, channel, false);
});

app.get('/hls/:id/local/:segment', async (req, res) => {
  const channel = channelManager.getChannelById(req.params.id);
  if (!channel || channel.streamMode !== 'transmux') {
    return res.status(404).send('Channel not found or not transmuxed');
  }

  const job = channelManager.getTransmuxJob(req.params.id);
  if (!job) {
    return res.status(404).send('Transmuxed content unavailable');
  }

  const requested = decodeURIComponent(req.params.segment || '');
  const normalized = path.normalize(requested);
  const resolved = path.resolve(job.workDir, normalized);
  if (!resolved.startsWith(job.workDir)) {
    logger.warn('Path traversal attempt detected', {
      channelId: req.params.id,
      requested,
      normalized,
      resolved,
      workDir: job.workDir,
    });
    return res.status(400).send('Invalid segment path');
  }

  try {
    const buffer = await fs.promises.readFile(resolved);
    res.set('Content-Type', 'video/mp2t');
    return res.send(buffer);
  } catch (error) {
    logger.error('Failed to serve transmuxed segment', {
      channelId: channel.id,
      segment: requested,
      message: error.message,
    });
    return res.status(404).send('Segment not found');
  }
});

app.get('/epg.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  res.send(channelManager.generateEpg());
});

app.get('/api/logs', (req, res) => {
  res.json(logger.getEntries());
});

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
});

module.exports = app;
