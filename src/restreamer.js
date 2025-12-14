const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

class Restreamer {
  constructor({
    logger,
    scriptPath = path.join(__dirname, 'restream.js'),
    readinessTimeoutMs = 120000,
    tempRoot = os.tmpdir(),
  }) {
    this.logger = logger;
    this.scriptPath = scriptPath;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.tempRoot = tempRoot;
    this.jobs = new Map();
    this.dependencyCheckPromise = null;
  }

  async ensureJob(channelId, embedUrl) {
    if (!embedUrl) return null;

    const writableTempRoot = await this.ensureWritableTempRoot();
    await this.ensureDependencies();

    const existing = this.jobs.get(channelId);
    if (existing) {
      this.logger?.debug('Reusing existing restream job', {
        channelId,
        workDir: existing.workDir,
        tempRoot: existing.tempRoot,
      });
      existing.lastAccessed = Date.now();
      return existing;
    }

    const workDir = await fs.promises.mkdtemp(path.join(writableTempRoot, 'restream-'));
    const manifestPath = path.join(workDir, `${channelId}.m3u8`);
    const args = [this.scriptPath, embedUrl, channelId, workDir];

    this.logger?.info('Starting restream job', {
      channelId,
      embedUrl,
      workDir,
      tempRoot: writableTempRoot,
      readinessTimeoutMs: this.readinessTimeoutMs,
    });

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
      tempRoot: writableTempRoot,
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

  async ensureWritableTempRoot() {
    const resolvedTempRoot = path.resolve(this.tempRoot || os.tmpdir());
    const probeDir = path.join(resolvedTempRoot, 'restreamer-probe');
    const probeFile = path.join(probeDir, `.probe-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    this.logger?.debug('Checking temp root writability', {
      tempRoot: this.tempRoot,
      resolvedTempRoot,
      probeFile,
    });

    try {
      await fs.promises.access(resolvedTempRoot, fs.constants.W_OK);
      await fs.promises.mkdir(probeDir, { recursive: true });
      await fs.promises.writeFile(probeFile, 'probe');
      await fs.promises.unlink(probeFile);
      await fs.promises.rm(probeDir, { recursive: true, force: true });

      this.logger?.debug('Temp root writable', { tempRoot: this.tempRoot, resolvedTempRoot });
      return resolvedTempRoot;
    } catch (error) {
      this.logger?.error('Temp root is not writable', { tempRoot: resolvedTempRoot, error: error.message });
      const wrapped = new Error(`Temp directory ${resolvedTempRoot} is not writable: ${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async ensureDependencies() {
    if (this.dependencyCheckPromise) return this.dependencyCheckPromise;

    this.dependencyCheckPromise = (async () => {
      await this.checkFfmpegAvailable();
      await this.checkPlaywrightLaunchable();
    })();

    try {
      await this.dependencyCheckPromise;
      this.logger?.debug('Restreamer dependencies ready');
    } catch (error) {
      this.logger?.error('Restreamer dependency check failed', { error: error.message });
      this.dependencyCheckPromise = null;
      throw error;
    }

    return this.dependencyCheckPromise;
  }

  async checkFfmpegAvailable() {
    this.logger?.debug('Checking ffmpeg availability');

    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('ffmpeg -version timed out'));
      }, 5000);

      child.stdout?.on('data', (data) => {
        output += data.toString();
      });

      child.stderr?.on('data', (data) => {
        output += data.toString();
      });

      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`ffmpeg not available: ${error.message}`));
      });

      child.once('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(true);
        } else {
          reject(new Error(`ffmpeg -version exited with code ${code}${output ? `: ${output.trim()}` : ''}`));
        }
      });
    });
  }

  async checkPlaywrightLaunchable() {
    this.logger?.debug('Checking Playwright/Chromium availability');

    try {
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      await browser.close();
      return true;
    } catch (error) {
      const wrapped = new Error(`Failed to launch Playwright Chromium: ${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async waitForManifest(manifestPath, timeoutMs, child, channelId) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let timer;
      let stdoutBuffer = '';
      let stderrBuffer = '';

      const appendWithLimit = (existing, chunk, limit = 8000) => {
        const next = `${existing}${chunk}`;
        return next.length > limit ? next.slice(next.length - limit) : next;
      };

      this.logger?.debug('Waiting for restream manifest', { manifestPath, timeoutMs, channelId });

      const onExit = (code, signal) => {
        cleanup();
        const message = `Restream process exited before manifest was ready (code=${code}, signal=${signal})`;
        const error = new Error(formatErrorMessage(message, stdoutBuffer, stderrBuffer));
        error.exitCode = code;
        error.signal = signal;
        error.stdout = stdoutBuffer;
        error.stderr = stderrBuffer;
        reject(error);
      };

      const onError = (error) => {
        cleanup();
        const wrapped = new Error(formatErrorMessage(error.message || 'Restream process error', stdoutBuffer, stderrBuffer));
        wrapped.exitCode = error.code;
        wrapped.signal = error.signal;
        wrapped.stdout = stdoutBuffer;
        wrapped.stderr = stderrBuffer;
        reject(wrapped);
      };

      const onStdout = (data) => {
        stdoutBuffer = appendWithLimit(stdoutBuffer, data.toString());
      };

      const onStderr = (data) => {
        stderrBuffer = appendWithLimit(stderrBuffer, data.toString());
      };

      if (child) {
        child.once('exit', onExit);
        child.once('error', onError);
        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
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
          const error = new Error(
            formatErrorMessage(`Timed out waiting for restream manifest at ${manifestPath}`, stdoutBuffer, stderrBuffer),
          );
          error.stdout = stdoutBuffer;
          error.stderr = stderrBuffer;
          reject(error);
          return;
        }

        timer = setTimeout(poll, 500);
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (child) {
          child.off('exit', onExit);
          child.off('error', onError);
          child.stdout?.off('data', onStdout);
          child.stderr?.off('data', onStderr);
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

function formatErrorMessage(message, stdoutBuffer = '', stderrBuffer = '') {
  const details = [];
  if (stderrBuffer) details.push(`stderr:\n${stderrBuffer.trim()}`);
  if (stdoutBuffer) details.push(`stdout:\n${stdoutBuffer.trim()}`);
  if (!details.length) return message;
  return `${message}\n${details.join('\n---\n')}`;
}
