const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

class Restreamer {
  constructor({ logger, scriptPath = path.join(__dirname, 'restream.js'), readinessTimeoutMs = 120000 }) {
    this.logger = logger;
    this.scriptPath = scriptPath;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.jobs = new Map();
  }

  async ensureJob(channelId, embedUrl) {
    if (!embedUrl) return null;

    const existing = this.jobs.get(channelId);
    if (existing) {
      this.logger?.debug('Reusing existing restream job', { channelId, workDir: existing.workDir });
      existing.lastAccessed = Date.now();
      return existing;
    }

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'restream-'));
    const manifestPath = path.join(workDir, `${channelId}.m3u8`);
    const args = [this.scriptPath, embedUrl, channelId, workDir];

    this.logger?.info('Starting restream job', { channelId, embedUrl, workDir, readinessTimeoutMs: this.readinessTimeoutMs });

    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.logger?.debug('Spawned restream process', { channelId, pid: child.pid, args });

    child.stdout.on('data', (data) => {
      this.logger?.debug('Restream stdout', { channelId, message: data.toString() });
    });

    child.stderr.on('data', (data) => {
      this.logger?.warn('Restream stderr', { channelId, message: data.toString() });
    });

    const readyPromise = this.waitForManifest(manifestPath, this.readinessTimeoutMs, child, channelId);

    const completion = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        this.logger?.info('Restream process exited', { channelId, code, signal });
        resolve();
      });
      child.on('error', (error) => {
        this.logger?.error('Restream process error', { channelId, error: error.message });
      });
    });

    try {
      await readyPromise;
    } catch (error) {
      this.logger?.error('Failed to start restream job', { channelId, error: error.message });

      if (child && !child.killed) {
        child.kill('SIGTERM');
      }

      await new Promise((resolve) => child.once('exit', resolve));
      throw error;
    }

    const job = {
      channelId,
      embedUrl,
      workDir,
      manifestPath,
      process: child,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      completion,
    };

    this.jobs.set(channelId, job);
    return job;
  }

  async waitForManifest(manifestPath, timeoutMs, child, channelId) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let timer;

      this.logger?.debug('Waiting for restream manifest', { manifestPath, timeoutMs, channelId });

      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`Restream process exited before manifest was ready (code=${code}, signal=${signal})`));
      };

      const onError = (error) => {
        cleanup();
        reject(error);
      };

      if (child) {
        child.once('exit', onExit);
        child.once('error', onError);
      }

      const poll = async () => {
        try {
          const stats = await fs.promises.stat(manifestPath);
          if (stats.size > 0) {
            cleanup();
            this.logger?.info('Restream manifest detected', {
              manifestPath,
              elapsedMs: Date.now() - start,
              size: stats.size,
              channelId,
            });
            resolve(true);
            return;
          }
        } catch (error) {
          // ignore until timeout
        }

        if (Date.now() - start >= timeoutMs) {
          cleanup();
          this.logger?.error('Timed out waiting for restream manifest', {
            manifestPath,
            timeoutMs,
            channelId,
          });
          reject(new Error(`Timed out waiting for restream manifest at ${manifestPath}`));
          return;
        }

        timer = setTimeout(poll, 500);
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (child) {
          child.off('exit', onExit);
          child.off('error', onError);
        }
      };

      poll();
    });
  }

  getJob(channelId) {
    const job = this.jobs.get(channelId);
    if (job) job.lastAccessed = Date.now();
    return job || null;
  }

  async cleanupJob(channelId) {
    const job = this.jobs.get(channelId);
    if (!job) return;

    if (job.process && !job.process.killed) {
      job.process.kill('SIGTERM');
    }

    try {
      await job.completion;
    } catch (error) {
      this.logger?.warn('Error while awaiting restream completion during cleanup', {
        channelId,
        error: error.message,
      });
    }

    try {
      await fs.promises.rm(job.workDir, { recursive: true, force: true });
      this.logger?.info('Cleaned up restream job', { channelId, workDir: job.workDir });
    } catch (error) {
      this.logger?.warn('Failed to cleanup restream job directory', {
        channelId,
        error: error.message,
      });
    }

    this.jobs.delete(channelId);
  }
}

module.exports = Restreamer;
