/**
 * Player configuration detector using modular adapters
 * Runs multiple player adapters in parallel to detect stream URLs
 */
class PlayerDetector {
  constructor({ logger, adapters = [] }) {
    this.logger = logger;
    this.adapters = adapters;

    if (this.adapters.length === 0) {
      this.logger?.warn('PlayerDetector initialized with no adapters');
    } else {
      this.logger?.debug('PlayerDetector initialized', {
        adapterCount: this.adapters.length,
        adapterNames: this.adapters.map(a => a.name),
      });
    }
  }

  async inspect(page) {
    if (this.adapters.length === 0) {
      this.logger?.warn('No player adapters available');
      return null;
    }

    this.logger?.debug('Inspecting page for player configs', {
      adapterCount: this.adapters.length,
    });

    const results = await Promise.allSettled(
      this.adapters.map(adapter => this.tryAdapter(page, adapter))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        return result.value;
      }
    }

    this.logger?.debug('No player config detected', {
      attemptedAdapters: this.adapters.length,
    });

    return null;
  }

  async tryAdapter(page, adapter) {
    try {
      this.logger?.debug('Trying player adapter', { adapter: adapter.name });

      const detected = await page.evaluate((adapterCode) => {
        try {
          const adapter = eval(`(${adapterCode})`);
          return adapter();
        } catch (error) {
          console.debug('[PlayerDetector] Adapter execution error:', error.message);
          return null;
        }
      }, adapter.detect.toString());

      if (detected) {
        this.logger?.info('Player detected successfully', {
          player: adapter.name,
          url: detected.url,
          type: detected.type,
        });
        return { ...detected, player: adapter.name };
      }

      this.logger?.debug('Adapter returned no detection', { adapter: adapter.name });
      return null;
    } catch (error) {
      this.logger?.debug('Adapter failed', {
        adapter: adapter.name,
        error: error.message,
      });
      return null;
    }
  }
}

module.exports = PlayerDetector;
