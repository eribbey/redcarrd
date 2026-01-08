const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const FFmpegProcessManager = require('./FFmpegProcessManager');
const StreamDetector = require('./StreamDetector');

const JPlayerAdapter = require('./playerAdapters/JPlayerAdapter');
const JWPlayerAdapter = require('./playerAdapters/JWPlayerAdapter');
const HTML5VideoAdapter = require('./playerAdapters/HTML5VideoAdapter');
const VideoJSAdapter = require('./playerAdapters/VideoJSAdapter');
const FlowplayerAdapter = require('./playerAdapters/FlowplayerAdapter');
const ClapprAdapter = require('./playerAdapters/ClapprAdapter');
const BitmovinAdapter = require('./playerAdapters/BitmovinAdapter');

const DEFAULT_STREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PLAYWRIGHT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
];

/**
 * Unified stream manager replacing both restreamer.js and transmuxer.js
 * Handles browser automation, stream detection, and FFmpeg process management
 */
class StreamManager {
  constructor({ logger, tempRoot = os.tmpdir(), maxConcurrent = 20 }) {
    this.logger = logger;
    this.tempRoot = tempRoot;
    this.jobs = new Map();
    this.dependencyCheckPromise = null;

    this.ffmpegManager = new FFmpegProcessManager({
      logger,
      maxConcurrent: maxConcurrent || parseInt(process.env.FFMPEG_MAX_CONCURRENT) || 20,
    });

    const playerAdapters = [
      new JPlayerAdapter(),
      new JWPlayerAdapter(),
      new VideoJSAdapter(),
      new FlowplayerAdapter(),
      new ClapprAdapter(),
      new BitmovinAdapter(),
      new HTML5VideoAdapter(),
    ];

    this.detector = new StreamDetector({
      logger,
      adapters: playerAdapters,
    });

    this.logger?.info('StreamManager initialized', {
      maxConcurrent,
      adapterCount: playerAdapters.length,
    });
  }

  async ensureJob(channelId, embedUrl, options = {}) {
    if (!embedUrl) {
      this.logger?.debug('No embed URL provided', { channelId });
      return null;
    }

    await this.ensureDependencies();

    const existing = this.jobs.get(channelId);
    if (existing && !this.isJobStale(existing)) {
      this.logger?.debug('Reusing existing stream job', { channelId });
      existing.lastAccessed = Date.now();
      return existing;
    }

    if (existing) {
      this.logger?.warn('Existing stream job is stale, restarting', { channelId });
      await this.cleanupJob(channelId);
    }

    const job = await this.createJob(channelId, embedUrl, options);
    this.jobs.set(channelId, job);
    return job;
  }

  async createJob(channelId, embedUrl, options = {}) {
    const workDir = await fs.promises.mkdtemp(
      path.join(this.tempRoot, 'stream-')
    );
    const manifestPath = path.join(workDir, `${channelId}.m3u8`);

    this.logger?.info('Creating stream job', {
      channelId,
      embedUrl,
      workDir,
    });

    let browser = null;
    let context = null;
    let page = null;
    let streamInfo = null;

    try {
      ({ browser, context, page } = await this.launchBrowser(embedUrl));

      streamInfo = await this.detectStream(page, embedUrl, options);

      this.logger?.info('Stream detected, starting FFmpeg', {
        channelId,
        type: streamInfo.type,
        url: streamInfo.url,
      });

      const cookies = await context.cookies(streamInfo.url).catch(() => []);
      const headers = {
        'Referer': embedUrl,
        'Cookie': cookies.map(c => `${c.name}=${c.value}`).join('; '),
        'User-Agent': DEFAULT_STREAM_UA,
      };

      const ffmpegProcess = await this.ffmpegManager.spawn(
        channelId,
        streamInfo.url,
        manifestPath,
        { headers, streamType: streamInfo.type }
      );

      await browser.close();
      browser = null;
      context = null;
      page = null;

      const job = {
        channelId,
        embedUrl,
        streamUrl: streamInfo.url,
        streamType: streamInfo.type,
        workDir,
        manifestPath,
        ffmpegProcess,
        process: ffmpegProcess.process,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
      };

      this.logger?.info('Stream job created successfully', {
        channelId,
        manifestPath,
        streamType: streamInfo.type,
      });

      return job;
    } catch (error) {
      if (browser) {
        await browser.close().catch(() => {});
      }

      if (workDir) {
        await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }

      this.logger?.error('Failed to create stream job', {
        channelId,
        embedUrl,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    }
  }

  async launchBrowser(embedUrl) {
    this.logger?.debug('Launching Chromium browser', { embedUrl });

    const browser = await chromium.launch({
      headless: true,
      args: PLAYWRIGHT_LAUNCH_ARGS,
    });

    const context = await browser.newContext({
      userAgent: DEFAULT_STREAM_UA,
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });

    await context.addInitScript(() => {
      window.open = () => null;
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4] });
      window.chrome = window.chrome || { runtime: {} };
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) =>
          parameters?.name === 'notifications'
            ? Promise.resolve({ state: 'denied' })
            : originalQuery(parameters);
      }
    });

    const page = await context.newPage();
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('popup', popup => popup.close().catch(() => {}));

    this.logger?.debug('Navigating to embed URL', { embedUrl });

    await page.goto(embedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });

    return { browser, context, page };
  }

  async detectStream(page, embedUrl, options = {}) {
    const maxAttempts = options.maxAttempts || parseInt(process.env.RESTREAM_MAX_ATTEMPTS) || 4;
    const enableConfigFallback = options.enableConfigFallback !== false;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          this.logger?.warn('Retrying stream detection', {
            attempt,
            maxAttempts,
            embedUrl,
          });
          await page.waitForTimeout(2000 * attempt);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        }

        await this.autoplay(page);

        const streamInfo = await this.detector.detect(page, {
          enableConfigFallback,
        });

        if (streamInfo) {
          this.logger?.info('Stream detection successful', {
            attempt,
            url: streamInfo.url,
            type: streamInfo.type,
            player: streamInfo.player,
          });
          return streamInfo;
        }
      } catch (error) {
        lastError = error;
        this.logger?.debug('Detection attempt failed', {
          attempt,
          error: error.message,
        });
      }
    }

    throw lastError || new Error('Stream detection failed after retries');
  }

  async autoplay(page) {
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      function tryPlay() {
        try {
          const video = document.querySelector('video');
          if (video) {
            video.muted = true;
            const p = video.play();
            if (p && p.catch) p.catch(() => {});
          }

          const audio = document.querySelector('audio');
          if (audio) {
            audio.muted = true;
            const p = audio.play();
            if (p && p.catch) p.catch(() => {});
          }

          if (typeof window.jwplayer === 'function') {
            try {
              let player = window.jwplayer();
              if (!player) {
                const jwElem = document.querySelector('.jwplayer, [id^="jwplayer"], [id^="vplayer"]');
                if (jwElem) player = window.jwplayer(jwElem);
              }
              if (player) {
                player.setMute(true);
                player.play();
              }
            } catch (error) {}
          }

          if (typeof videojs !== 'undefined') {
            const players = videojs.players || {};
            for (const id in players) {
              try {
                players[id].muted(true);
                players[id].play();
              } catch (error) {}
            }
          }
        } catch (error) {}
      }

      tryPlay();
      document.body.addEventListener('click', tryPlay, { once: true });
      document.body.addEventListener('keydown', tryPlay, { once: true });
    });

    await page.waitForTimeout(5000);
  }

  isJobStale(job) {
    if (!job?.ffmpegProcess) {
      return true;
    }

    const metrics = job.ffmpegProcess.getMetrics();
    return metrics.state === 'crashed' || metrics.state === 'killed';
  }

  async cleanupJob(channelId) {
    const job = this.jobs.get(channelId);
    if (!job) {
      this.logger?.debug('No job to cleanup', { channelId });
      return;
    }

    this.logger?.info('Cleaning up stream job', {
      channelId,
      workDir: job.workDir,
    });

    if (job.ffmpegProcess) {
      await this.ffmpegManager.kill(channelId);
    }

    if (job.workDir) {
      try {
        await fs.promises.rm(job.workDir, { recursive: true, force: true });
        this.logger?.debug('Removed work directory', {
          channelId,
          workDir: job.workDir,
        });
      } catch (error) {
        this.logger?.warn('Failed to cleanup stream job directory', {
          channelId,
          workDir: job.workDir,
          error: error.message,
        });
      }
    }

    this.jobs.delete(channelId);
  }

  async ensureDependencies() {
    if (this.dependencyCheckPromise) {
      return this.dependencyCheckPromise;
    }

    this.dependencyCheckPromise = (async () => {
      try {
        await this.checkFfmpegAvailable();
        await this.checkPlaywrightLaunchable();
        this.logger?.info('Dependencies verified (FFmpeg + Playwright)');
      } catch (error) {
        this.logger?.error('Dependency check failed', { error: error.message });
        throw error;
      }
    })();

    return this.dependencyCheckPromise;
  }

  async checkFfmpegAvailable() {
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const child = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('ffmpeg -version timed out'));
      }, 5000);

      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg -version exited with code ${code}`));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`ffmpeg not found or not executable: ${error.message}`));
      });
    });
  }

  async checkPlaywrightLaunchable() {
    try {
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      await browser.close();
    } catch (error) {
      throw new Error(`Failed to launch Playwright Chromium: ${error.message}`);
    }
  }

  getMetrics() {
    const ffmpegMetrics = this.ffmpegManager.getMetrics();

    return {
      jobCount: this.jobs.size,
      ffmpeg: ffmpegMetrics,
      jobs: Array.from(this.jobs.values()).map(job => ({
        channelId: job.channelId,
        embedUrl: job.embedUrl,
        streamType: job.streamType,
        createdAt: job.createdAt,
        lastAccessed: job.lastAccessed,
        uptime: Date.now() - job.createdAt,
        ffmpegState: job.ffmpegProcess?.state,
      })),
    };
  }
}

module.exports = StreamManager;
