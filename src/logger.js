const { EventEmitter } = require('events');
const dayjs = require('dayjs');

class Logger extends EventEmitter {
  constructor(limit = 500) {
    super();
    this.limit = limit;
    this.entries = [];
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
    console[level === 'error' ? 'error' : 'log'](`[${entry.timestamp}] [${level.toUpperCase()}] ${message}${metaText}`);
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
