const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

/**
 * Global resource monitor for limiting concurrent FFmpeg processes
 */
class GlobalResourceMonitor {
  constructor({ logger, maxConcurrent }) {
    this.logger = logger;
    this.maxConcurrent = maxConcurrent;
    this.activeCount = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      this.logger?.debug('FFmpeg process slot acquired', {
        active: this.activeCount,
        max: this.maxConcurrent,
      });
      return;
    }

    this.logger?.debug('FFmpeg process limit reached, queuing', {
      active: this.activeCount,
      max: this.maxConcurrent,
      queueSize: this.queue.length,
    });

    await new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    this.activeCount--;
    this.logger?.debug('FFmpeg process slot released', {
      active: this.activeCount,
      queueSize: this.queue.length,
    });

    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      this.activeCount++;
      resolve();
    }
  }
}

/**
 * Health monitor for individual FFmpeg processes
 */
class ProcessHealthMonitor {
  constructor(processWrapper) {
    this.processWrapper = processWrapper;
    this.logger = processWrapper.logger;
    this.channelId = processWrapper.channelId;
    this.checkInterval = parseInt(process.env.FFMPEG_HEALTH_CHECK_INTERVAL_MS) || 10000;
    this.staleThreshold = parseInt(process.env.FFMPEG_STALE_THRESHOLD_MS) || 60000;
    this.timer = null;
    this.start();
  }

  start() {
    this.timer = setInterval(() => this.check(), this.checkInterval);
    this.logger?.debug('Health monitor started', {
      channelId: this.channelId,
      checkInterval: this.checkInterval,
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger?.debug('Health monitor stopped', { channelId: this.channelId });
    }
  }

  check() {
    const metrics = this.processWrapper.getMetrics();

    if (metrics.state === 'crashed' || metrics.state === 'killed') {
      this.logger?.debug('Health check: process already terminated', {
        channelId: this.channelId,
        state: metrics.state,
      });
      return;
    }

    if (metrics.state === 'initializing') {
      return;
    }

    const timeSinceOutput = Date.now() - (metrics.lastOutput || metrics.startTime || 0);
    if (timeSinceOutput > this.staleThreshold) {
      this.logger?.warn('FFmpeg process appears stale', {
        channelId: this.channelId,
        timeSinceOutput,
        threshold: this.staleThreshold,
      });
      this.processWrapper.state = 'degraded';
      return;
    }

    if (metrics.recentErrors.length > 5) {
      const criticalErrors = metrics.recentErrors.filter(e =>
        /error|failed|invalid/i.test(e)
      );

      if (criticalErrors.length > 3) {
        this.logger?.warn('FFmpeg process has critical errors', {
          channelId: this.channelId,
          errorCount: criticalErrors.length,
        });
        this.processWrapper.state = 'degraded';
        return;
      }
    }

    if (this.processWrapper.state === 'degraded') {
      this.logger?.info('FFmpeg process recovered', { channelId: this.channelId });
      this.processWrapper.state = 'healthy';
    }
  }
}

/**
 * Wrapper for individual FFmpeg process with lifecycle management
 */
class ProcessWrapper extends EventEmitter {
  constructor({ channelId, streamUrl, outputPath, logger, memoryLimitMB, headers = {}, streamType = 'hls' }) {
    super();
    this.channelId = channelId;
    this.streamUrl = streamUrl;
    this.outputPath = outputPath;
    this.logger = logger;
    this.memoryLimitMB = memoryLimitMB;
    this.headers = headers;
    this.streamType = streamType;

    this.process = null;
    this.state = 'initializing';
    this.healthMonitor = null;
    this.startTime = null;
    this.lastOutput = null;
    this.errorBuffer = [];
    this.outputBuffer = [];
  }

  async start() {
    const args = this.buildFFmpegArgs();

    this.logger?.info('Spawning FFmpeg process', {
      channelId: this.channelId,
      streamUrl: this.streamUrl,
      outputPath: this.outputPath,
    });

    this.process = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.startTime = Date.now();
    this.state = 'running';

    this.attachEventHandlers();
    this.healthMonitor = new ProcessHealthMonitor(this);

    await this.waitForManifest();
    this.state = 'healthy';
    this.logger?.info('FFmpeg process healthy', {
      channelId: this.channelId,
      pid: this.process.pid,
    });
  }

  buildFFmpegArgs() {
    const headerLines = Object.entries(this.headers)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');

    const isDash = this.streamType === 'dash';
    const segmentPattern = path.join(path.dirname(this.outputPath), 'segment_%03d.ts');

    return [
      '-loglevel', 'warning',
      '-fflags', '+genpts+discardcorrupt',
      '-err_detect', 'ignore_err',
      ...(headerLines ? ['-headers', headerLines + '\r\n'] : []),
      ...(isDash ? ['-protocol_whitelist', 'file,http,https,tcp,tls'] : []),
      ...(isDash ? ['-i', this.streamUrl, '-map', '0'] : ['-i', this.streamUrl]),
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '12',
      '-hls_flags', 'append_list+independent_segments+program_date_time+temp_file',
      '-hls_delete_threshold', '3',
      '-hls_playlist_type', 'event',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', segmentPattern,
      '-start_number', '0',
      this.outputPath,
    ];
  }

  attachEventHandlers() {
    this.process.stdout.on('data', (data) => {
      this.lastOutput = Date.now();
      const message = data.toString().trim();
      if (message) {
        this.outputBuffer.push(message);
        if (this.outputBuffer.length > 50) this.outputBuffer.shift();
        this.logger?.debug('FFmpeg stdout', { channelId: this.channelId, message });
      }
    });

    this.process.stderr.on('data', (data) => {
      this.lastOutput = Date.now();
      const message = data.toString().trim();
      if (message) {
        this.errorBuffer.push(message);
        if (this.errorBuffer.length > 50) this.errorBuffer.shift();

        this.parseFFmpegProgress(message);
        this.logger?.debug('FFmpeg stderr', { channelId: this.channelId, message });
      }
    });

    this.process.on('error', (error) => {
      this.logger?.error('FFmpeg process error', {
        channelId: this.channelId,
        error: error.message,
      });
      this.state = 'crashed';
      this.emit('error', error);
    });

    this.process.on('exit', (code, signal) => {
      this.logger?.info('FFmpeg process exited', {
        channelId: this.channelId,
        code,
        signal,
        uptime: this.startTime ? Date.now() - this.startTime : null,
      });

      this.state = signal ? 'killed' : 'crashed';
      this.healthMonitor?.stop();
      this.emit('exit', { code, signal });
    });
  }

  parseFFmpegProgress(message) {
    const frameMatch = message.match(/frame=\s*(\d+)/);
    const fpsMatch = message.match(/fps=\s*([\d.]+)/);
    const bitrateMatch = message.match(/bitrate=\s*([\d.]+\w+)/);

    if (frameMatch || fpsMatch || bitrateMatch) {
      this.emit('progress', {
        frame: frameMatch ? parseInt(frameMatch[1]) : null,
        fps: fpsMatch ? parseFloat(fpsMatch[1]) : null,
        bitrate: bitrateMatch ? bitrateMatch[1] : null,
      });
    }
  }

  async waitForManifest() {
    const timeout = 30000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (this.state === 'crashed' || this.state === 'killed') {
        throw new Error(`FFmpeg process exited before manifest was ready`);
      }

      try {
        const stats = await fs.promises.stat(this.outputPath);
        if (stats.size > 0) {
          this.logger?.debug('Manifest ready', {
            channelId: this.channelId,
            path: this.outputPath,
            elapsedMs: Date.now() - start,
          });
          return;
        }
      } catch (error) {
        // File doesn't exist yet, continue waiting
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Manifest not ready after ${timeout}ms for channel ${this.channelId}`);
  }

  async kill({ signal = 'SIGTERM', timeout = 5000 } = {}) {
    if (!this.process || this.state === 'killed') return;

    this.logger?.info('Killing FFmpeg process', {
      channelId: this.channelId,
      pid: this.process.pid,
      signal,
    });

    this.process.kill(signal);

    await Promise.race([
      new Promise(resolve => this.process.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, timeout)),
    ]);

    if (!this.process.killed && this.state !== 'killed' && this.state !== 'crashed') {
      this.logger?.warn('Force killing FFmpeg process', {
        channelId: this.channelId,
        pid: this.process.pid,
      });
      this.process.kill('SIGKILL');
    }

    this.healthMonitor?.stop();
  }

  getMetrics() {
    return {
      state: this.state,
      uptime: this.startTime ? Date.now() - this.startTime : null,
      startTime: this.startTime,
      pid: this.process?.pid,
      killed: this.process?.killed,
      exitCode: this.process?.exitCode,
      signalCode: this.process?.signalCode,
      lastOutput: this.lastOutput,
      recentErrors: this.errorBuffer.slice(-10),
      recentOutput: this.outputBuffer.slice(-10),
    };
  }
}

/**
 * Main FFmpeg process manager with global resource limits
 */
class FFmpegProcessManager {
  constructor({ logger, maxConcurrent = 20, memoryLimitMB = 512 }) {
    this.logger = logger;
    this.maxConcurrent = maxConcurrent || parseInt(process.env.FFMPEG_MAX_CONCURRENT) || 20;
    this.memoryLimitMB = memoryLimitMB || parseInt(process.env.FFMPEG_MEMORY_LIMIT_MB) || 512;
    this.processes = new Map();
    this.globalResourceMonitor = new GlobalResourceMonitor({
      logger,
      maxConcurrent: this.maxConcurrent,
    });

    this.logger?.info('FFmpegProcessManager initialized', {
      maxConcurrent: this.maxConcurrent,
      memoryLimitMB: this.memoryLimitMB,
    });
  }

  async spawn(channelId, streamUrl, outputPath, options = {}) {
    await this.globalResourceMonitor.acquire();

    try {
      const processWrapper = new ProcessWrapper({
        channelId,
        streamUrl,
        outputPath,
        logger: this.logger,
        memoryLimitMB: this.memoryLimitMB,
        ...options,
      });

      await processWrapper.start();
      this.processes.set(channelId, processWrapper);

      processWrapper.on('exit', () => {
        this.logger?.debug('Process wrapper exited, cleaning up', { channelId });
        this.processes.delete(channelId);
        this.globalResourceMonitor.release();
      });

      return processWrapper;
    } catch (error) {
      this.globalResourceMonitor.release();
      this.logger?.error('Failed to spawn FFmpeg process', {
        channelId,
        error: error.message,
      });
      throw error;
    }
  }

  async kill(channelId, options = { signal: 'SIGTERM', timeout: 5000 }) {
    const wrapper = this.processes.get(channelId);
    if (!wrapper) {
      this.logger?.debug('No process to kill', { channelId });
      return;
    }

    await wrapper.kill(options);
    this.processes.delete(channelId);
    this.globalResourceMonitor.release();
  }

  getProcess(channelId) {
    return this.processes.get(channelId);
  }

  async killAll() {
    this.logger?.info('Killing all FFmpeg processes', {
      count: this.processes.size,
    });

    await Promise.allSettled(
      Array.from(this.processes.keys()).map(id => this.kill(id))
    );
  }

  getMetrics() {
    const processMetrics = {};
    for (const [channelId, wrapper] of this.processes.entries()) {
      processMetrics[channelId] = wrapper.getMetrics();
    }

    return {
      activeCount: this.processes.size,
      maxConcurrent: this.maxConcurrent,
      queueSize: this.globalResourceMonitor.queue.length,
      processes: processMetrics,
    };
  }
}

module.exports = FFmpegProcessManager;
