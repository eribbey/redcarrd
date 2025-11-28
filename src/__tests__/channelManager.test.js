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
