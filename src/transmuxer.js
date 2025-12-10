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
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing;
    }

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transmux-'));
    const manifestPath = path.join(workDir, 'index.m3u8');
    const segmentPath = path.join(workDir, 'segment_%03d.ts');
    const headerArg = this.buildHeadersArgument(headers);

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
    ];

    if (headerArg) {
      args.push('-headers', headerArg);
    }

    args.push(
      '-i',
      inputUrl,
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_list_size',
      '5',
      '-hls_flags',
      'delete_segments+append_list+independent_segments',
      '-hls_segment_filename',
      segmentPath,
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
        reject(new Error('Timed out waiting for transmux manifest'));
      }, 15000);

      const checkReady = async () => {
        try {
          const stats = await fs.promises.stat(manifestPath);
          if (stats.size > 0) {
            clearTimeout(timeout);
            resolve(true);
            return;
          }
        } catch (error) {
          // ignore
        }

        setTimeout(checkReady, 500);
      };

      checkReady();

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on('exit', (code, signal) => {
        if (code !== 0) {
          clearTimeout(timeout);
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
