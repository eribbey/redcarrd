const NetworkDetector = require('./detectors/NetworkDetector');
const PlayerDetector = require('./detectors/PlayerDetector');

/**
 * Multi-phase stream detector
 * Phase 1: Network sniffing (primary)
 * Phase 2: Player config inspection (fallback)
 */
class StreamDetector {
  constructor({ logger, timeout = 90000, adapters = [] }) {
    this.logger = logger;
    this.timeout = parseInt(process.env.RESTREAM_NETWORK_TIMEOUT_MS) || timeout;
    this.networkDetector = new NetworkDetector({ logger });
    this.playerDetector = new PlayerDetector({ logger, adapters });

    this.logger?.debug('StreamDetector initialized', {
      timeout: this.timeout,
      adapterCount: adapters.length,
    });
  }

  async detect(page, options = {}) {
    const { enableConfigFallback = true } = options;

    this.logger?.info('Starting stream detection', {
      timeout: this.timeout,
      enableConfigFallback,
    });

    try {
      this.logger?.debug('Phase 1: Network sniffing');
      const networkResult = await this.networkDetector.sniff(page, this.timeout);

      if (networkResult) {
        this.logger?.info('Stream detected via network sniffing', {
          type: networkResult.type,
          url: networkResult.url,
        });
        return networkResult;
      }
    } catch (error) {
      this.logger?.debug('Network sniffing failed', { error: error.message });
    }

    if (enableConfigFallback) {
      try {
        this.logger?.debug('Phase 2: Player config inspection');
        const configResult = await this.playerDetector.inspect(page);

        if (configResult) {
          this.logger?.info('Stream detected via player config', {
            type: configResult.type,
            player: configResult.player,
            url: configResult.url,
          });
          return configResult;
        }
      } catch (error) {
        this.logger?.debug('Player config inspection failed', { error: error.message });
      }
    }

    throw new Error('No stream detected via network or player config');
  }
}

module.exports = StreamDetector;
