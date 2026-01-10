const fs = require('fs');
const os = require('os');
const path = require('path');
const StreamPipeline = require('./StreamPipeline');

/**
 * Unified stream manager for browser-based video capture to HLS
 *
 * This replaces the previous detection-based approach with direct video capture
 * using CDP screencast. The browser stays open during streaming and captures
 * whatever video is displayed on the page.
 */
class StreamManager {
  constructor({ logger, tempRoot = os.tmpdir(), maxConcurrent = 10 }) {
    this.logger = logger;
    this.tempRoot = tempRoot;
    this.jobs = new Map();
    this.dependencyCheckPromise = null;

    this.pipeline = new StreamPipeline({
      logger,
      tempRoot,
      maxConcurrent: maxConcurrent || parseInt(process.env.FFMPEG_MAX_CONCURRENT) || 10,
    });

    // Forward pipeline events
    this.pipeline.on('started', (data) => {
      this.logger?.info('Stream capture started', data);
    });

    this.pipeline.on('stopped', (data) => {
      this.logger?.info('Stream capture stopped', data);
    });

    this.pipeline.on('error', (data) => {
      this.logger?.error('Stream capture error', data);
    });

    this.logger?.info('StreamManager initialized (capture mode)', {
      maxConcurrent,
      tempRoot,
    });
  }

  async ensureJob(channelId, embedUrl, options = {}) {
    if (!embedUrl) {
      this.logger?.debug('No embed URL provided', { channelId });
      return null;
    }

    await this.ensureDependencies();

    // Check for existing running job
    const existing = this.jobs.get(channelId);
    if (existing && this.pipeline.isJobRunning(channelId)) {
      // Check if embed URL changed
      if (existing.embedUrl !== embedUrl) {
        this.logger?.info('Embed URL changed, restarting job', {
          channelId,
          oldUrl: existing.embedUrl,
          newUrl: embedUrl,
        });
        await this.cleanupJob(channelId);
      } else {
        this.logger?.debug('Reusing existing stream job', { channelId });
        existing.lastAccessed = Date.now();
        return existing;
      }
    }

    // Clean up stale job if exists
    if (existing && !this.pipeline.isJobRunning(channelId)) {
      this.logger?.warn('Existing stream job is stale, restarting', { channelId });
      await this.cleanupJob(channelId);
    }

    // Create new job
    const job = await this.createJob(channelId, embedUrl, options);
    this.jobs.set(channelId, job);
    return job;
  }

  async createJob(channelId, embedUrl, options = {}) {
    this.logger?.info('Creating stream job', {
      channelId,
      embedUrl,
    });

    try {
      // Start the capture pipeline
      const pipelineJob = await this.pipeline.start(channelId, embedUrl, options);

      const job = {
        channelId,
        embedUrl,
        workDir: pipelineJob.workDir,
        manifestPath: pipelineJob.manifestPath,
        pipelineJob,
        ffmpegProcess: pipelineJob.ffmpegProcess,
        process: pipelineJob.ffmpegProcess?.process,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
      };

      this.logger?.info('Stream job created successfully', {
        channelId,
        manifestPath: job.manifestPath,
      });

      return job;
    } catch (error) {
      this.logger?.error('Failed to create stream job', {
        channelId,
        embedUrl,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  isJobStale(job) {
    if (!job?.pipelineJob) {
      return true;
    }

    return !this.pipeline.isJobRunning(job.channelId);
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

    // Stop the pipeline (this handles browser, FFmpeg, and file cleanup)
    await this.pipeline.stop(channelId);

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
      const { chromium } = require('playwright');
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
    const pipelineMetrics = this.pipeline.getMetrics();

    return {
      jobCount: this.jobs.size,
      pipeline: pipelineMetrics,
      jobs: Array.from(this.jobs.values()).map((job) => ({
        channelId: job.channelId,
        embedUrl: job.embedUrl,
        createdAt: job.createdAt,
        lastAccessed: job.lastAccessed,
        uptime: Date.now() - job.createdAt,
        isRunning: this.pipeline.isJobRunning(job.channelId),
      })),
    };
  }

  async cleanupAll() {
    this.logger?.info('Cleaning up all stream jobs', { count: this.jobs.size });
    await this.pipeline.stopAll();
    this.jobs.clear();
  }
}

module.exports = StreamManager;
