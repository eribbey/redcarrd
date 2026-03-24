jest.mock('axios');

jest.mock('playwright', () => ({
  chromium: { launch: jest.fn().mockResolvedValue({ isConnected: () => true, newContext: jest.fn(), close: jest.fn(), on: jest.fn() }) },
}));

const ChannelManager = require('../channelManager');

describe('Server endpoints (via ChannelManager)', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  test('playlist.m3u8 returns valid M3U8 even with no channels', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.channels = [];

    const playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toBe('#EXTM3U');
  });

  test('playlist only includes healthy channels', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.channels = [
      { id: 'ch-ok', category: 'football', title: 'OK', streamUrl: 'https://s.test/a.m3u8', status: 'healthy' },
      { id: 'ch-pending', category: 'football', title: 'Pending', streamUrl: null, status: 'pending' },
      { id: 'ch-dead', category: 'football', title: 'Dead', streamUrl: null, status: 'dead' },
    ];

    const playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toContain('ch-ok');
    expect(playlist).not.toContain('ch-pending');
    expect(playlist).not.toContain('ch-dead');
  });
});
