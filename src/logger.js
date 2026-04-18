const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const DEFAULT_LOG_PATH = path.resolve(__dirname, '..', 'redcarrd.log');
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

class Logger extends EventEmitter {
  constructor(limit = 500) {
    super();
    this.limit = limit;
    this.entries = [];
    this.logFilePath = process.env.LOG_FILE_PATH || DEFAULT_LOG_PATH;
    this.logToFile = process.env.LOG_TO_FILE !== 'false';
    this._logStream = null;
    this._bytesWritten = 0;

    if (this.logToFile) {
      this._initLogStream();
    }
  }

  _initLogStream() {
    try {
      // Check existing file size for rotation
      try {
        const stat = fs.statSync(this.logFilePath);
        if (stat.size > MAX_LOG_SIZE_BYTES) {
          this._rotateLog();
        }
        this._bytesWritten = stat.size;
      } catch (_) {
        // File doesn't exist yet, that's fine
      }

      this._logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      this._logStream.on('error', (err) => {
        console.error(`[Logger] Failed to write to log file: ${err.message}`);
        this._logStream = null;
      });
    } catch (err) {
      console.error(`[Logger] Failed to open log file at ${this.logFilePath}: ${err.message}`);
    }
  }

  _rotateLog() {
    const rotatedPath = `${this.logFilePath}.1`;
    try {
      // Keep one rotated backup
      if (fs.existsSync(rotatedPath)) {
        fs.unlinkSync(rotatedPath);
      }
      fs.renameSync(this.logFilePath, rotatedPath);
      this._bytesWritten = 0;
    } catch (err) {
      console.error(`[Logger] Log rotation failed: ${err.message}`);
    }
  }

  log(level, message, meta = {}) {
    const entry = {
      level,
      message,
      meta,
      timestamp: dayjs().toISOString(),
    };
    this.entries.unshift(entry);
    if (this.entries.length > this.limit) {
      this.entries = this.entries.slice(0, this.limit);
    }
    const metaText = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    const formattedLine = `[${entry.timestamp}] [${level.toUpperCase()}] ${message}${metaText}`;
    console[level === 'error' ? 'error' : 'log'](formattedLine);

    if (this._logStream) {
      const line = formattedLine + '\n';
      this._logStream.write(line);
      this._bytesWritten += Buffer.byteLength(line);
      if (this._bytesWritten > MAX_LOG_SIZE_BYTES) {
        this._logStream.end();
        this._rotateLog();
        this._initLogStream();
      }
    }

    this.emit('entry', entry);
    return entry;
  }

  info(message, meta) {
    return this.log('info', message, meta);
  }

  debug(message, meta) {
    return this.log('debug', message, meta);
  }

  warn(message, meta) {
    return this.log('warn', message, meta);
  }

  error(message, meta) {
    return this.log('error', message, meta);
  }

  getEntries() {
    return this.entries;
  }
}

module.exports = Logger;
