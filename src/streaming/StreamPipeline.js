const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const BrowserStreamCapture = require('./BrowserStreamCapture');
const FFmpegProcessManager = require('./FFmpegProcessManager');

/**
 * Coordinates browser capture and FFmpeg encoding into a unified pipeline
 *
 * Flow: Browser (CDP screencast) → frames → FFmpeg (stdin) → HLS segments
 */
class StreamPipeline extends EventEmitter {
  constructor({ logger, tempRoot = os.tmpdir(), maxConcurrent = 10 }) {
    super();
    this.logger = logger;
    this.tempRoot = tempRoot;
    this.jobs = new Map();

    this.ffmpegManager = new FFmpegProcessManager({
      logger,
      maxConcurrent,
    });

    this.logger?.info('StreamPipeline initialized', { tempRoot, maxConcurrent });
  }

  async start(channelId, embedUrl, options = {}) {
    // Check if job already exists
    const existing = this.jobs.get(channelId);
    if (existing && existing.isRunning) {
      this.logger?.debug('Reusing existing pipeline job', { channelId });
      existing.lastAccessed = Date.now();
      return existing;
    }

    // Clean up stale job if exists
    if (existing) {
      await this.stop(channelId);
    }

    this.logger?.info('Starting stream pipeline', { channelId, embedUrl });

    // Create work directory
    const workDir = await fs.promises.mkdtemp(path.join(this.tempRoot, 'stream-'));
    const manifestPath = path.join(workDir, `${channelId}.m3u8`);

    const captureWidth = options.captureWidth || parseInt(process.env.CAPTURE_WIDTH) || 1280;
    const captureHeight = options.captureHeight || parseInt(process.env.CAPTURE_HEIGHT) || 720;
    const captureFps = options.captureFps || parseInt(process.env.CAPTURE_FPS) || 30;
    const captureQuality = options.captureQuality || parseInt(process.env.CAPTURE_QUALITY) || 80;

    const job = {
      channelId,
      embedUrl,
      workDir,
      manifestPath,
      capture: null,
      ffmpegProcess: null,
      isRunning: false,
      frameCount: 0,
      bytesWritten: 0,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      errors: [],
    };

    try {
      // Start FFmpeg first (so it's ready to receive frames)
      this.logger?.debug('Starting FFmpeg for pipe input', { channelId, manifestPath });
      job.ffmpegProcess = await this.ffmpegManager.spawnForPipe(channelId, manifestPath, {
        captureWidth,
        captureHeight,
        captureFps,
      });

      const stdin = job.ffmpegProcess.getStdin();
      if (!stdin) {
        throw new Error('FFmpeg stdin not available');
      }

      // Create browser capture
      this.logger?.debug('Starting browser capture', { channelId, embedUrl });
      job.capture = new BrowserStreamCapture({
        logger: this.logger,
        width: captureWidth,
        height: captureHeight,
        quality: captureQuality,
        fps: captureFps,
      });

      // Connect frame events to FFmpeg stdin
      job.capture.on('frame', (frameBuffer, metadata) => {
        if (!job.isRunning) return;

        try {
          const canWrite = stdin.write(frameBuffer);
          job.frameCount++;
          job.bytesWritten += frameBuffer.length;

          // Handle backpressure
          if (!canWrite) {
            job.capture.pause();
            stdin.once('drain', () => {
              if (job.isRunning) {
                job.capture.resume();
              }
            });
          }
        } catch (error) {
          this.logger?.debug('Error writing frame to FFmpeg', {
            channelId,
            error: error.message,
          });
        }
      });

      // Handle capture errors
      job.capture.on('error', (error) => {
        this.logger?.error('Browser capture error', {
          channelId,
          error: error.message,
        });
        job.errors.push({ type: 'capture', error: error.message, timestamp: Date.now() });
        this.emit('error', { channelId, error });
      });

      // Handle capture stopped
      job.capture.on('stopped', () => {
        this.logger?.debug('Browser capture stopped', { channelId });
        // Close FFmpeg stdin to signal end of input
        if (stdin && !stdin.destroyed) {
          stdin.end();
        }
      });

      // Handle FFmpeg exit
      job.ffmpegProcess.on('exit', ({ code, signal }) => {
        this.logger?.info('FFmpeg process exited', { channelId, code, signal });
        job.isRunning = false;
        this.emit('stopped', { channelId, code, signal });
      });

      // Handle FFmpeg errors
      job.ffmpegProcess.on('error', (error) => {
        this.logger?.error('FFmpeg error', {
          channelId,
          error: error.message,
        });
        job.errors.push({ type: 'ffmpeg', error: error.message, timestamp: Date.now() });
        this.emit('error', { channelId, error });
      });

      // Start capture (this will navigate to page and begin screencast)
      await job.capture.start(embedUrl);

      job.isRunning = true;
      this.jobs.set(channelId, job);

      this.logger?.info('Stream pipeline started successfully', {
        channelId,
        manifestPath,
        captureWidth,
        captureHeight,
        captureFps,
      });

      this.emit('started', { channelId, manifestPath });

      return job;
    } catch (error) {
      this.logger?.error('Failed to start stream pipeline', {
        channelId,
        embedUrl,
        error: error.message,
        stack: error.stack,
      });

      // Cleanup on failure
      if (job.capture) {
        await job.capture.stop().catch(() => {});
      }
      if (job.ffmpegProcess) {
        await this.ffmpegManager.kill(channelId).catch(() => {});
      }
      if (workDir) {
        await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }

      throw error;
    }
  }

  async stop(channelId) {
    const job = this.jobs.get(channelId);
    if (!job) {
      this.logger?.debug('No pipeline job to stop', { channelId });
      return;
    }

    this.logger?.info('Stopping stream pipeline', {
      channelId,
      frameCount: job.frameCount,
      uptime: Date.now() - job.createdAt,
    });

    job.isRunning = false;

    // Stop browser capture first
    if (job.capture) {
      await job.capture.stop().catch((error) => {
        this.logger?.debug('Error stopping capture', { channelId, error: error.message });
      });
    }

    // Then stop FFmpeg
    await this.ffmpegManager.kill(channelId).catch((error) => {
      this.logger?.debug('Error killing FFmpeg', { channelId, error: error.message });
    });

    // Cleanup work directory
    if (job.workDir) {
      await fs.promises.rm(job.workDir, { recursive: true, force: true }).catch((error) => {
        this.logger?.debug('Error cleaning up work directory', {
          channelId,
          workDir: job.workDir,
          error: error.message,
        });
      });
    }

    this.jobs.delete(channelId);
    this.logger?.info('Stream pipeline stopped', { channelId });
  }

  async stopAll() {
    this.logger?.info('Stopping all stream pipelines', { count: this.jobs.size });

    const channelIds = Array.from(this.jobs.keys());
    await Promise.allSettled(channelIds.map((id) => this.stop(id)));

    this.logger?.info('All stream pipelines stopped');
  }

  getJob(channelId) {
    return this.jobs.get(channelId) || null;
  }

  isJobRunning(channelId) {
    const job = this.jobs.get(channelId);
    return job?.isRunning === true;
  }

  getMetrics() {
    const jobMetrics = {};
    for (const [channelId, job] of this.jobs.entries()) {
      jobMetrics[channelId] = {
        isRunning: job.isRunning,
        frameCount: job.frameCount,
        bytesWritten: job.bytesWritten,
        uptime: Date.now() - job.createdAt,
        lastAccessed: job.lastAccessed,
        errors: job.errors.slice(-5),
        captureMetrics: job.capture?.getMetrics?.() || null,
        ffmpegMetrics: job.ffmpegProcess?.getMetrics?.() || null,
      };
    }

    return {
      activeJobs: this.jobs.size,
      ffmpegMetrics: this.ffmpegManager.getMetrics(),
      jobs: jobMetrics,
    };
  }
}

module.exports = StreamPipeline;
