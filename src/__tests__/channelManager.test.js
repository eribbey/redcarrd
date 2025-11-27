const ChannelManager = require('../channelManager');

describe('ChannelManager', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  test('builds channels with grouping', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    const events = [
      { title: 'A', category: 'football', embedUrl: 'https://example.com/embed/a', sourceOptions: [], qualityOptions: [] },
      { title: 'B', category: 'football', embedUrl: 'https://example.com/embed/b', sourceOptions: [], qualityOptions: [] },
      { title: 'C', category: 'basketball', embedUrl: 'https://example.com/embed/c', sourceOptions: [], qualityOptions: [] },
    ];

    await manager.buildChannels(events, ['football']);
    expect(manager.channels).toHaveLength(2);
    expect(manager.channels[0].id).toBe('football-1');
    expect(manager.channels[1].id).toBe('football-2');
  });

  test('generates playlist and epg', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.channels = [
      {
        id: 'football-1',
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
        channelId: 'football-1',
        title: 'A',
        category: 'football',
        start: new Date(),
        stop: new Date(),
      },
    ];
    manager.playlistReady = true;
    const playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain('/hls/football-1');

    const epg = manager.generateEpg();
    expect(epg).toContain('<tv>');
    expect(epg).toContain('football-1');
  });

  test('returns placeholder playlist when hydration not finished', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.channels = [
      {
        id: 'football-1',
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
});
