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

  test('generates playlist and epg', () => {
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
    manager.playlistReady = true;
    const playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain('/hls/ch-football');

    const epg = manager.generateEpg();
    expect(epg).toContain('<tv>');
    expect(epg).toContain('ch-football');
  });

  test('returns placeholder playlist when hydration not finished', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.channels = [
      {
        id: 'ch-football',
        category: 'football',
        title: 'A',
        embedUrl: 'https://example.com/embed/a',
        streamUrl: null,
        sourceOptions: [],
        qualityOptions: [],
        expiresAt: new Date().toISOString(),
      },
    ];
    const playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toContain('Playlist is still hydrating');
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

    test('should respect cooldown period', async () => {
      const mockResolver = { resolve: jest.fn(), close: jest.fn() };
      channelManager.streamResolver = mockResolver;

      const channel = {
        id: 'test-3',
        embedUrl: 'https://embed.example.com/player/3',
        lastResolutionAttempt: Date.now() - 30000, // 30 seconds ago
      };
      await channelManager.resolveStream(channel);

      expect(mockResolver.resolve).not.toHaveBeenCalled();
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

  describe('stream URL TTL', () => {
    let channelManager;

    beforeEach(() => {
      channelManager = new ChannelManager({ lifetimeHours: 24, logger });
    });

    test('should need re-resolution when URL reaches 80% of TTL', () => {
      const channel = {
        id: 'test-1',
        streamUrl: 'https://cdn.example.com/stream.m3u8',
        resolvedAt: Date.now() - (25 * 60 * 1000), // 25 min ago (past 80% of 30 min TTL)
      };
      expect(channelManager.needsReResolution(channel)).toBe(true);
    });

    test('should not need re-resolution when URL is fresh', () => {
      const channel = {
        id: 'test-2',
        streamUrl: 'https://cdn.example.com/stream.m3u8',
        resolvedAt: Date.now() - (5 * 60 * 1000), // 5 min ago
      };
      expect(channelManager.needsReResolution(channel)).toBe(false);
    });

    test('should need re-resolution when no resolvedAt', () => {
      const channel = { id: 'test-3', streamUrl: 'https://cdn.example.com/stream.m3u8' };
      expect(channelManager.needsReResolution(channel)).toBe(true);
    });

    test('should need re-resolution when no streamUrl', () => {
      const channel = { id: 'test-4', resolvedAt: Date.now() };
      expect(channelManager.needsReResolution(channel)).toBe(true);
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
});
