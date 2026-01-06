const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

class Transmuxer {
  constructor({ logger }) {
    this.logger = logger;
    this.jobs = new Map();
  }

  buildHeadersArgument(headers = {}) {
    const headerLines = Object.entries(headers)
      .filter(([, value]) => typeof value !== 'undefined' && value !== null)
      .map(([key, value]) => `${key}: ${value}`);
    if (!headerLines.length) return null;
    return headerLines.join('\r\n');
  }

  async ensureJob(channelId, inputUrl, headers = {}) {
    const existing = this.jobs.get(channelId);
    if (existing && !this.isJobStale(existing)) {
      existing.lastAccessed = Date.now();
      return existing;
    }

    if (existing) {
      this.logger?.info('Existing transmux job is stale, restarting', { channelId });
      await this.cleanupJob(channelId);
    }

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transmux-'));
    const manifestPath = path.join(workDir, 'index.m3u8');
    const segmentPath = path.join(workDir, 'segment_%03d.ts');
    const headerArg = this.buildHeadersArgument(headers);

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'warning',
      '-fflags',
      '+genpts+discardcorrupt',
      '-err_detect',
      'ignore_err',
    ];

    if (headerArg) {
      args.push('-headers', headerArg);
    }

    args.push(
      '-i',
      inputUrl,
      // Try codec copy first, fallback handled by FFmpeg
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      // Bypass codec issues
      '-bsf:a',
      'aac_adtstoasc',
      '-f',
      'hls',
      // Longer segments for stability (6s instead of 4s)
      '-hls_time',
      '6',
      // Larger playlist for better buffering (12 segments = ~72s buffer)
      '-hls_list_size',
      '12',
      // Improved flags: removed delete_segments, added program_date_time
      '-hls_flags',
      'append_list+independent_segments+program_date_time+temp_file',
      // Allow segments to persist for DVR-like behavior
      '-hls_delete_threshold',
      '3',
      '-hls_playlist_type',
      'event',
      '-hls_segment_type',
      'mpegts',
      '-hls_segment_filename',
      segmentPath,
      '-start_number',
      '0',
      manifestPath,
    );

    this.logger?.info('Starting transmux job', { channelId, inputUrl, workDir });

    const child = spawn('ffmpeg', args);

    child.stderr.on('data', (data) => {
      this.logger?.debug('Transmuxer stderr', {
        channelId,
        message: data.toString(),
      });
    });

    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearPollTimer();
        reject(new Error('Timed out waiting for transmux manifest'));
      }, 15000);

      let pollTimer;

      const clearPollTimer = () => {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      };

      const checkReady = async () => {
        try {
          const stats = await fs.promises.stat(manifestPath);
          if (stats.size > 0) {
            clearTimeout(timeout);
            clearPollTimer();
            resolve(true);
            return;
          }
        } catch (error) {
          this.logger?.debug('Polling for manifest file failed (will retry)', {
            channelId,
            manifestPath,
            error: error.message,
          });
        }

        pollTimer = setTimeout(checkReady, 500);
      };

      checkReady();

      child.on('error', (error) => {
        clearTimeout(timeout);
        clearPollTimer();
        reject(error);
      });

      child.on('exit', (code, signal) => {
        if (code !== 0) {
          clearTimeout(timeout);
          clearPollTimer();
          reject(new Error(`ffmpeg exited with code ${code || signal}`));
        }
      });
    });

    await readyPromise;

    const job = {
      channelId,
      inputUrl,
      workDir,
      manifestPath,
      segmentPath,
      process: child,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
    };

    this.jobs.set(channelId, job);
    return job;
  }

  getJob(channelId) {
    return this.jobs.get(channelId);
  }

  isJobStale(job) {
    if (!job || !job.process) return true;

    const { exitCode, signalCode, killed } = job.process;
    if (exitCode !== null || signalCode || killed) {
      return true;
    }

    // Check if job hasn't been accessed in the last 10 minutes
    const staleThresholdMs = 10 * 60 * 1000;
    if (Date.now() - job.lastAccessed > staleThresholdMs) {
      return true;
    }

    return false;
  }

  async cleanupJob(channelId) {
    const job = this.jobs.get(channelId);
    if (!job) return;

    if (job.process && !job.process.killed) {
      job.process.kill('SIGTERM');
    }

    try {
      await fs.promises.rm(job.workDir, { recursive: true, force: true });
      this.logger?.info('Cleaned up transmux job', { channelId, workDir: job.workDir });
    } catch (error) {
      this.logger?.warn('Failed to cleanup transmux job directory', { channelId, error: error.message });
    }

    this.jobs.delete(channelId);
  }
}

module.exports = Transmuxer;
