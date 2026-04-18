'use strict';

const { StreamResolver } = require('../streamResolver');

const runWhenEnabled = process.env.RESOLVER_INTEGRATION === '1' ? describe : describe.skip;

runWhenEnabled('StreamResolver integration (opt-in)', () => {
  jest.setTimeout(90_000);

  test('resolves a real embedsports.top embed URL to an .m3u8', async () => {
    const embedUrl = process.env.RESOLVER_INTEGRATION_EMBED_URL;
    if (!embedUrl) {
      throw new Error('Set RESOLVER_INTEGRATION_EMBED_URL to a live embedsports.top embed URL');
    }

    const resolver = new StreamResolver({
      logger: { info: console.log, warn: console.warn, error: console.error, debug: () => {} },
    });
    const result = await resolver.resolve(embedUrl);

    expect(result.streamUrl).toMatch(/\.m3u8/);
    expect(result.contentType).toBe('application/vnd.apple.mpegurl');
    expect(result.headers.referer).toBeDefined();
  });
});
