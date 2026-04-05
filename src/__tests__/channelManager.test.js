jest.mock('axios');
const axios = require('axios');
const ChannelManager = require('../channelManager');

describe('ChannelManager', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockReset();
  });

  test('builds deterministic channels and reconciles updates', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    const events = [
      {
        title: 'A',
        startTime: '2024-01-01T12:00:00Z',
        category: 'football',
        embedUrl: 'https://example.com/embed/a',
        sourceOptions: [],
        qualityOptions: [],
      },
      {
        title: 'B',
        startTime: '2024-01-01T13:00:00Z',
        category: 'football',
        embedUrl: 'https://example.com/embed/b',
        sourceOptions: [],
        qualityOptions: [],
      },
      { title: 'C', category: 'basketball', embedUrl: 'https://example.com/embed/c', sourceOptions: [], qualityOptions: [] },
    ];

    await manager.buildChannels(events, ['football']);
    expect(manager.channels).toHaveLength(2);
    expect(manager.channels[0].id).toMatch(/^ch-/);
    expect(manager.channels[1].id).toMatch(/^ch-/);

    const originalId = manager.channels.find((channel) => channel.title === 'A').id;
    const updatedEvents = [
      {
        title: 'A',
        startTime: '2024-01-01T12:00:00Z',
        category: 'football',
        embedUrl: 'https://example.com/embed/a',
        sourceOptions: [],
        qualityOptions: [],
      },
      {
        title: 'D',
        startTime: '2024-01-01T14:00:00Z',
        category: 'football',
        embedUrl: 'https://example.com/embed/d',
        sourceOptions: [],
        qualityOptions: [],
      },
    ];

    await manager.buildChannels(updatedEvents, ['football']);
    expect(manager.channels).toHaveLength(2);
    expect(manager.channels.find((channel) => channel.title === 'A').id).toBe(originalId);
    expect(logger.info).toHaveBeenCalledWith('Reconciling channels', expect.objectContaining({
      counts: expect.objectContaining({ added: 1, updated: 1 }),
    }));
  });

  test('generates playlist and epg for healthy channels', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.channels = [
      {
        id: 'ch-football',
        category: 'football',
        title: 'A',
        embedUrl: 'https://example.com/embed/a',
        streamUrl: 'https://cdn.example.com/a.m3u8',
        requestHeaders: { Referer: 'https://example.com/embed/a' },
        sourceOptions: [],
        qualityOptions: [],
        expiresAt: new Date().toISOString(),
        status: 'healthy',
      },
    ];
    manager.programmes = [
      {
        channelId: 'ch-football',
        title: 'A',
        category: 'football',
        start: new Date(),
        stop: new Date(),
      },
    ];
    const playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain('/hls/ch-football');

    const epg = manager.generateEpg();
    expect(epg).toContain('<tv>');
    expect(epg).toContain('ch-football');
  });

  describe('resolveStream()', () => {
    let channelManager;

    beforeEach(() => {
      channelManager = new ChannelManager({ lifetimeHours: 24, logger });
    });

    test('should set streamMode to hls when HLS URL detected', async () => {
      const mockResolver = {
        resolve: jest.fn().mockResolvedValue({
          url: 'https://cdn.example.com/stream.m3u8',
          type: 'hls',
          headers: { Referer: 'https://embed.example.com' },
        }),
        close: jest.fn(),
      };
      channelManager.streamResolver = mockResolver;

      const channel = { id: 'test-1', embedUrl: 'https://embed.example.com/player/1' };
      await channelManager.resolveStream(channel);

      expect(channel.streamUrl).toBe('https://cdn.example.com/stream.m3u8');
      expect(channel.streamMode).toBe('hls');
      expect(channel.streamHeaders).toEqual({ Referer: 'https://embed.example.com' });
    });

    test('should set streamMode to transmux when non-HLS URL detected', async () => {
      const mockResolver = {
        resolve: jest.fn().mockResolvedValue({
          url: 'https://cdn.example.com/stream.mpd',
          type: 'dash',
          headers: { Referer: 'https://embed.example.com' },
        }),
        close: jest.fn(),
      };
      channelManager.streamResolver = mockResolver;

      const channel = { id: 'test-2', embedUrl: 'https://embed.example.com/player/2' };
      await channelManager.resolveStream(channel);

      expect(channel.streamUrl).toBe('https://cdn.example.com/stream.mpd');
      expect(channel.streamMode).toBe('transmux');
    });

  });

  describe('ensureTransmuxed()', () => {
    let channelManager;

    beforeEach(() => {
      channelManager = new ChannelManager({ lifetimeHours: 24, logger });
    });

    test('should start transmuxer job for non-HLS channel', async () => {
      const mockTransmuxer = {
        ensureJob: jest.fn().mockResolvedValue({
          manifestPath: '/tmp/transmux-abc/test.m3u8',
          workDir: '/tmp/transmux-abc',
        }),
      };
      channelManager.transmuxer = mockTransmuxer;

      const channel = {
        id: 'test-1',
        streamUrl: 'https://cdn.example.com/stream.mpd',
        streamMode: 'transmux',
        streamHeaders: { Referer: 'https://embed.example.com' },
      };

      const result = await channelManager.ensureTransmuxed(channel);
      expect(result).toBeTruthy();
      expect(mockTransmuxer.ensureJob).toHaveBeenCalledWith(
        'test-1',
        'https://cdn.example.com/stream.mpd',
        { Referer: 'https://embed.example.com' }
      );
    });

    test('should return null when no stream URL', async () => {
      const channel = { id: 'test-2', streamMode: 'transmux' };
      const result = await channelManager.ensureTransmuxed(channel);
      expect(result).toBeNull();
    });
  });

  test('creates channels with pending status and lifecycle fields', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    const events = [
      {
        title: 'Game A',
        startTime: '2024-01-01T12:00:00Z',
        category: 'football',
        embedUrl: 'https://example.com/embed/a',
        sourceOptions: [],
        qualityOptions: [],
      },
    ];

    await manager.buildChannels(events, ['football']);
    const channel = manager.channels[0];

    expect(channel.status).toBe('pending');
    expect(channel.failCount).toBe(0);
    expect(channel.nextRetryAt).toBeNull();
    expect(channel.lastHealthCheck).toBeNull();
    expect(channel.healthFailCount).toBe(0);
  });

  test('resets dead channels to pending on event refresh', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    const events = [
      {
        title: 'Game A',
        startTime: '2024-01-01T12:00:00Z',
        category: 'football',
        embedUrl: 'https://example.com/embed/a',
        sourceOptions: [],
        qualityOptions: [],
      },
    ];

    await manager.buildChannels(events, ['football']);
    manager.channels[0].status = 'dead';
    manager.channels[0].failCount = 5;

    // Rebuild with same events — dead should reset
    await manager.buildChannels(events, ['football']);
    expect(manager.channels[0].status).toBe('pending');
    expect(manager.channels[0].failCount).toBe(0);
  });

  test('generatePlaylist returns healthy channels without playlistReady gate', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.channels = [
      { id: 'ch-1', category: 'football', title: 'Game A', streamUrl: 'https://stream.test/a.m3u8', status: 'healthy' },
      { id: 'ch-2', category: 'football', title: 'Game B', streamUrl: 'https://stream.test/b.m3u8', status: 'resolved' },
      { id: 'ch-3', category: 'football', title: 'Game C', streamUrl: null, status: 'pending' },
    ];

    const playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toContain('ch-1');
    expect(playlist).toContain('ch-2'); // resolved channels with streamUrl are also included
    expect(playlist).not.toContain('ch-3');
  });

  describe('getNextChannelForResolution', () => {
    test('prioritizes pending over failed over expiring', () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });
      const now = Date.now();
      manager.channels = [
        { id: 'ch-expiring', status: 'healthy', streamUrl: 'https://s.test/a.m3u8', resolvedAt: now - 25 * 60 * 1000, failCount: 0 },
        { id: 'ch-failed', status: 'failed', failCount: 1, nextRetryAt: now - 1000 },
        { id: 'ch-pending', status: 'pending', failCount: 0 },
      ];

      const next = manager.getNextChannelForResolution();
      expect(next.id).toBe('ch-pending');
    });

    test('respects backoff for failed channels', () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });
      manager.channels = [
        { id: 'ch-failed', status: 'failed', failCount: 1, nextRetryAt: Date.now() + 60000 },
      ];

      const next = manager.getNextChannelForResolution();
      expect(next).toBeNull();
    });

    test('returns null when no channels need resolution', () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });
      manager.channels = [
        { id: 'ch-healthy', status: 'healthy', streamUrl: 'https://s.test/a.m3u8', resolvedAt: Date.now(), failCount: 0 },
      ];

      const next = manager.getNextChannelForResolution();
      expect(next).toBeNull();
    });

    test('skips dead channels', () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });
      manager.channels = [
        { id: 'ch-dead', status: 'dead', failCount: 5 },
      ];

      const next = manager.getNextChannelForResolution();
      expect(next).toBeNull();
    });
  });

  describe('resolution loop', () => {
    test('resolveAndUpdateStatus promotes to healthy on success', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });
      manager.streamResolver = {
        resolve: jest.fn().mockResolvedValue({ url: 'https://s.test/live.m3u8', type: 'hls', headers: {} }),
      };

      const channel = { id: 'ch-1', status: 'pending', embedUrl: 'https://embed.test/1', failCount: 0, healthFailCount: 0 };
      manager.channels = [channel];

      await manager.resolveAndUpdateStatus(channel);

      expect(channel.status).toBe('healthy');
      expect(channel.streamUrl).toBe('https://s.test/live.m3u8');
      expect(channel.failCount).toBe(0);
      expect(channel.resolvedAt).toBeGreaterThan(0);
    });

    test('resolveAndUpdateStatus sets failed with backoff on failure', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });
      manager.streamResolver = {
        resolve: jest.fn().mockResolvedValue(null),
      };

      const channel = { id: 'ch-1', status: 'pending', embedUrl: 'https://embed.test/1', failCount: 0, healthFailCount: 0 };
      manager.channels = [channel];

      await manager.resolveAndUpdateStatus(channel);

      expect(channel.status).toBe('failed');
      expect(channel.failCount).toBe(1);
      expect(channel.nextRetryAt).toBeGreaterThan(Date.now());
    });

    test('resolveAndUpdateStatus sets dead after max failures', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });
      manager.streamResolver = {
        resolve: jest.fn().mockResolvedValue(null),
      };

      const channel = { id: 'ch-1', status: 'failed', embedUrl: 'https://embed.test/1', failCount: 4, healthFailCount: 0 };
      manager.channels = [channel];

      await manager.resolveAndUpdateStatus(channel);

      expect(channel.status).toBe('dead');
      expect(channel.failCount).toBe(5);
    });
  });

  describe('checkChannelHealth', () => {
    test('marks HLS channel healthy when manifest contains segments', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });
      const hlsManifest = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment0.ts\n';

      axios.get.mockResolvedValue({
        status: 200,
        data: Buffer.from(hlsManifest),
        headers: {},
      });

      const channel = {
        id: 'ch-1', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
        streamMode: 'hls', embedUrl: 'https://embed.test/1',
        requestHeaders: {}, streamHeaders: {}, cookies: [],
        healthFailCount: 0, healthFailTimestamps: [],
        resolvedAt: Date.now() - 600000, // resolved 10 min ago, past grace period
      };

      await manager.checkChannelHealth(channel);
      expect(channel.status).toBe('healthy');
      expect(channel.lastHealthCheck).toBeGreaterThan(0);
    });

    test('marks HLS channel unhealthy when manifest is empty', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });

      axios.get.mockResolvedValue({
        status: 200,
        data: Buffer.from('#EXTM3U\n'),
        headers: {},
      });

      const channel = {
        id: 'ch-1', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
        streamMode: 'hls', embedUrl: 'https://embed.test/1',
        requestHeaders: {}, streamHeaders: {}, cookies: [],
        healthFailCount: 0, healthFailTimestamps: [],
        resolvedAt: Date.now() - 600000, // past grace period
      };

      await manager.checkChannelHealth(channel);
      expect(channel.status).toBe('pending');
      expect(channel.streamUrl).toBeNull();
    });

    test('marks channel unhealthy on 403', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });

      axios.get.mockResolvedValue({ status: 403, data: Buffer.from(''), headers: {} });

      const channel = {
        id: 'ch-1', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
        streamMode: 'hls', embedUrl: 'https://embed.test/1',
        requestHeaders: {}, streamHeaders: {}, cookies: [],
        healthFailCount: 0, healthFailTimestamps: [],
        resolvedAt: Date.now() - 600000,
      };

      await manager.checkChannelHealth(channel);
      expect(channel.status).toBe('pending');
      expect(channel.streamUrl).toBeNull();
    });

    test('marks channel dead after rapid fail cycles within time window', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });

      axios.get.mockResolvedValue({ status: 500, data: Buffer.from(''), headers: {} });

      const now = Date.now();
      const channel = {
        id: 'ch-1', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
        streamMode: 'hls', embedUrl: 'https://embed.test/1',
        requestHeaders: {}, streamHeaders: {}, cookies: [],
        healthFailCount: 0,
        healthFailTimestamps: [now - 120000, now - 60000],
        resolvedAt: now - 600000,
      };

      await manager.checkChannelHealth(channel);
      expect(channel.status).toBe('dead');
    });

    test('does not mark dead if failures are outside time window', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });

      axios.get.mockResolvedValue({ status: 500, data: Buffer.from(''), headers: {} });

      const now = Date.now();
      const channel = {
        id: 'ch-1', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
        streamMode: 'hls', embedUrl: 'https://embed.test/1',
        requestHeaders: {}, streamHeaders: {}, cookies: [],
        healthFailCount: 0,
        healthFailTimestamps: [now - 700000, now - 650000],
        resolvedAt: now - 800000,
      };

      await manager.checkChannelHealth(channel);
      expect(channel.status).toBe('pending');
    });

    test('403 auth failure queues for re-resolution without counting rapid fail', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });

      axios.get.mockResolvedValue({ status: 403, data: Buffer.from(''), headers: {} });

      const now = Date.now();
      const channel = {
        id: 'ch-auth', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
        streamMode: 'hls', embedUrl: 'https://embed.test/1',
        requestHeaders: {}, streamHeaders: {}, cookies: [],
        healthFailCount: 0,
        healthFailTimestamps: [now - 120000, now - 60000],
        resolvedAt: now - 600000,
      };

      await manager.checkChannelHealth(channel);
      expect(channel.status).toBe('pending');
      expect(channel.streamUrl).toBeNull();
      expect(channel.resolvedAt).toBeNull();
      expect(channel.failCount).toBe(0);
    });

    test('410 auth failure queues for re-resolution', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });

      axios.get.mockResolvedValue({ status: 410, data: Buffer.from(''), headers: {} });

      const channel = {
        id: 'ch-gone', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
        streamMode: 'hls', embedUrl: 'https://embed.test/1',
        requestHeaders: {}, streamHeaders: {}, cookies: [],
        healthFailCount: 0, healthFailTimestamps: [],
        resolvedAt: Date.now() - 600000,
      };

      await manager.checkChannelHealth(channel);
      expect(channel.status).toBe('pending');
      expect(channel.streamUrl).toBeNull();
    });

    test('non-auth failure (500) still counts toward rapid fail threshold', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });

      axios.get.mockResolvedValue({ status: 500, data: Buffer.from(''), headers: {} });

      const now = Date.now();
      const channel = {
        id: 'ch-500', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
        streamMode: 'hls', embedUrl: 'https://embed.test/1',
        requestHeaders: {}, streamHeaders: {}, cookies: [],
        healthFailCount: 0,
        healthFailTimestamps: [now - 120000, now - 60000],
        resolvedAt: now - 600000,
      };

      await manager.checkChannelHealth(channel);
      expect(channel.status).toBe('dead');
    });
  });

  test('retains upstream cookies across proxied HLS requests', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    const channel = {
      id: 'ch-football',
      category: 'football',
      title: 'A',
      embedUrl: 'https://example.com/embed/a',
      streamUrl: 'https://cdn.example.com/a.m3u8',
      requestHeaders: { Referer: 'https://example.com/embed/a' },
      sourceOptions: [],
      qualityOptions: [],
      expiresAt: new Date().toISOString(),
    };

    axios.get.mockResolvedValueOnce({
      data: 'manifest',
      headers: { 'set-cookie': ['sid=abc123; Path=/', 'region=us; Max-Age=3600'] },
    });

    await manager.fetchStream(channel, channel.streamUrl);
    expect(channel.cookies).toEqual(expect.arrayContaining(['sid=abc123', 'region=us']));

    axios.get.mockResolvedValueOnce({ data: 'segment-bytes', headers: {} });

    await manager.fetchStream(channel, 'https://cdn.example.com/segment1.ts');
    expect(axios.get).toHaveBeenLastCalledWith(
      'https://cdn.example.com/segment1.ts',
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'sid=abc123; region=us' }) }),
    );
  });

  describe('lifecycle integration', () => {
    test('channel goes from pending to resolved to healthy', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });
      manager.streamResolver = {
        resolve: jest.fn().mockResolvedValue({ url: 'https://s.test/live.m3u8', type: 'hls', headers: {} }),
      };

      await manager.buildChannels([
        { title: 'Game', startTime: '2024-01-01T12:00:00Z', category: 'football', embedUrl: 'https://embed.test/1', sourceOptions: [], qualityOptions: [] },
      ], ['football']);
      expect(manager.channels[0].status).toBe('pending');

      let playlist = manager.generatePlaylist('http://localhost:3005');
      expect(playlist).not.toContain('ch-');

      const channel = manager.getNextChannelForResolution();
      expect(channel).not.toBeNull();
      await manager.resolveAndUpdateStatus(channel);
      expect(channel.status).toBe('healthy'); // promoted directly on resolution

      playlist = manager.generatePlaylist('http://localhost:3005');
      expect(playlist).toContain('ch-'); // healthy channels appear in playlist immediately

      playlist = manager.generatePlaylist('http://localhost:3005');
      expect(playlist).toContain(channel.id);
    });

    test('channel removed from playlist when health check fails', async () => {
      const manager = new ChannelManager({ lifetimeHours: 24, logger });

      manager.channels = [{
        id: 'ch-test', category: 'football', title: 'Game', embedUrl: 'https://embed.test/1',
        streamUrl: 'https://s.test/live.m3u8', streamMode: 'hls', status: 'healthy',
        requestHeaders: {}, streamHeaders: {}, cookies: [], healthFailCount: 0, healthFailTimestamps: [],
      }];

      let playlist = manager.generatePlaylist('http://localhost:3005');
      expect(playlist).toContain('ch-test');

      axios.get.mockResolvedValue({ status: 403, data: Buffer.from(''), headers: {} });
      await manager.checkChannelHealth(manager.channels[0]);

      playlist = manager.generatePlaylist('http://localhost:3005');
      expect(playlist).not.toContain('ch-test');
      expect(manager.channels[0].status).toBe('pending');
    });
  });
});
