const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

class Restreamer {
  constructor({ logger, scriptPath = path.join(__dirname, 'restream.js'), readinessTimeoutMs = 60000 }) {
    this.logger = logger;
    this.scriptPath = scriptPath;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.jobs = new Map();
  }

  async ensureJob(channelId, embedUrl) {
    if (!embedUrl) return null;

    const existing = this.jobs.get(channelId);
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing;
    }

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'restream-'));
    const manifestPath = path.join(workDir, `${channelId}.m3u8`);
    const args = [this.scriptPath, embedUrl, channelId, workDir];

    this.logger?.info('Starting restream job', { channelId, embedUrl, workDir });

    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', (data) => {
      this.logger?.debug('Restream stdout', { channelId, message: data.toString() });
    });

    child.stderr.on('data', (data) => {
      this.logger?.warn('Restream stderr', { channelId, message: data.toString() });
    });

    const readyPromise = this.waitForManifest(manifestPath, this.readinessTimeoutMs);

    const completion = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        this.logger?.info('Restream process exited', { channelId, code, signal });
        resolve();
      });
      child.on('error', (error) => {
        this.logger?.error('Restream process error', { channelId, error: error.message });
      });
    });

    await readyPromise;

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

  async waitForManifest(manifestPath, timeoutMs) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const stats = await fs.promises.stat(manifestPath);
        if (stats.size > 0) return true;
      } catch (error) {
        // ignore until timeout
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Timed out waiting for restream manifest at ${manifestPath}`);
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
