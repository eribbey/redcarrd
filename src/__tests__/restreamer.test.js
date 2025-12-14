const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Restreamer = require('../restreamer');

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
    this.signal = null;
  }

  kill(signal) {
    this.killed = true;
    this.signal = signal;
    setImmediate(() => this.emit('exit', null, signal));
  }
}

describe('Restreamer', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('cleanupJob sends SIGTERM and removes work directory after completion', async () => {
    const restreamer = new Restreamer({ logger });
    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'restream-test-'));
    await fs.promises.writeFile(path.join(workDir, 'channel.m3u8'), '#EXTM3U');

    const fakeProcess = new FakeProcess();
    const completion = new Promise((resolve) => fakeProcess.once('exit', resolve));

    restreamer.jobs.set('ch-1', {
      channelId: 'ch-1',
      workDir,
      process: fakeProcess,
      completion,
    });

    await restreamer.cleanupJob('ch-1');

    expect(fakeProcess.killed).toBe(true);
    expect(fakeProcess.signal).toBe('SIGTERM');
    expect(fs.existsSync(workDir)).toBe(false);
    expect(restreamer.jobs.has('ch-1')).toBe(false);
  });
});
