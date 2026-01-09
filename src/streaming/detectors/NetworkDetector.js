/**
 * Network-based stream detector using Playwright request interception
 * Detects HLS, DASH, and progressive streams via network sniffing
 *
 * NOTE: This detector uses simple URL pattern matching without response validation
 * because request interception is not enabled. This matches the behavior of the
 * working restream.js implementation.
 */
class NetworkDetector {
  constructor({ logger }) {
    this.logger = logger;
    this.streamCandidates = new Map();
  }

  async sniff(page, timeout = 15000) {
    this.streamCandidates.clear();
    let listenerRemoved = false;
    let resolved = false;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (!listenerRemoved) {
          listenerRemoved = true;
          page.off('request', onRequest);
          this.logger?.debug('Network detector listener cleaned up');
        }
      };

      const timer = setTimeout(() => {
        cleanup();

        if (resolved) return;

        this.logger?.debug('Network sniffing timeout, selecting best candidate', {
          candidateCount: this.streamCandidates.size,
        });

        const best = this.selectBestCandidate();
        if (best) {
          resolved = true;
          resolve(best);
        } else {
          resolved = true;
          reject(new Error('No stream detected via network sniffing'));
        }
      }, timeout);

      // Use synchronous handler - no async/await, no response validation
      const onRequest = (request) => {
        if (resolved) return;

        try {
          const url = request.url();
          const resourceType = request.resourceType();

          // URL pattern matching only - no response header validation
          const patterns = [
            { regex: /playlist\.m3u8/i, type: 'hls', priority: 11 },
            { regex: /master\.m3u8/i, type: 'hls', priority: 11 },
            { regex: /index\.m3u8/i, type: 'hls', priority: 10 },
            { regex: /\.m3u8(\?|$)/i, type: 'hls', priority: 10 },
            { regex: /chunklist.*\.m3u8/i, type: 'hls', priority: 8 },
            { regex: /manifest\.mpd/i, type: 'dash', priority: 10 },
            { regex: /\.mpd(\?|$)/i, type: 'dash', priority: 9 },
            { regex: /\.mp4(\?|$)/i, type: 'progressive', priority: 3 },
          ];

          for (const { regex, type, priority } of patterns) {
            if (regex.test(url)) {
              // Skip .ts segment files - we want the manifest
              if (/\.ts(\?|$)/i.test(url)) {
                continue;
              }

              // Store candidate
              this.streamCandidates.set(url, {
                url,
                type,
                priority,
                resourceType,
                timestamp: Date.now(),
              });

              this.logger?.debug('Stream candidate detected', {
                url: url.substring(0, 100) + (url.length > 100 ? '...' : ''),
                type,
                priority,
                resourceType,
              });

              // Immediately resolve for high-priority HLS streams
              if (priority >= 10 && type === 'hls') {
                this.logger?.info('High-priority HLS stream detected, resolving immediately', {
                  url: url.substring(0, 100) + (url.length > 100 ? '...' : ''),
                  type,
                  priority,
                });

                clearTimeout(timer);
                cleanup();
                resolved = true;
                resolve({ url, type });
                return;
              }

              // For DASH, also resolve immediately
              if (priority >= 9 && type === 'dash') {
                this.logger?.info('High-priority DASH stream detected, resolving immediately', {
                  url: url.substring(0, 100) + (url.length > 100 ? '...' : ''),
                  type,
                  priority,
                });

                clearTimeout(timer);
                cleanup();
                resolved = true;
                resolve({ url, type });
                return;
              }

              // Found a match, break pattern loop
              break;
            }
          }
        } catch (error) {
          this.logger?.debug('Error in request handler', { error: error.message });
        }
      };

      page.on('request', onRequest);
    });
  }

  selectBestCandidate() {
    if (this.streamCandidates.size === 0) {
      this.logger?.debug('No stream candidates available');
      return null;
    }

    // Prefer HLS/DASH over progressive
    const sorted = Array.from(this.streamCandidates.values())
      .filter(c => c.type !== 'progressive')
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.timestamp - b.timestamp;
      });

    if (sorted.length === 0) {
      // Fallback to progressive
      const progressiveSorted = Array.from(this.streamCandidates.values())
        .filter(c => c.type === 'progressive')
        .sort((a, b) => a.timestamp - b.timestamp);

      if (progressiveSorted.length > 0) {
        const best = progressiveSorted[0];
        this.logger?.debug('Selected progressive stream (fallback)', {
          url: best.url.substring(0, 100),
          type: best.type,
          priority: best.priority,
        });
        return { url: best.url, type: best.type };
      }

      return null;
    }

    const best = sorted[0];
    this.logger?.info('Selected best stream candidate', {
      url: best.url.substring(0, 100) + (best.url.length > 100 ? '...' : ''),
      type: best.type,
      priority: best.priority,
      totalCandidates: this.streamCandidates.size,
    });

    return { url: best.url, type: best.type };
  }
}

module.exports = NetworkDetector;
