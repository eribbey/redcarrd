/**
 * Network-based stream detector using Playwright request interception
 * Detects HLS, DASH, and progressive streams via network sniffing
 */
class NetworkDetector {
  constructor({ logger }) {
    this.logger = logger;
    this.streamCandidates = new Map();
  }

  async sniff(page, timeout = 90000) {
    this.streamCandidates.clear();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.logger?.debug('Network sniffing timeout, selecting best candidate', {
          candidateCount: this.streamCandidates.size,
        });
        const best = this.selectBestCandidate();
        if (best) {
          resolve(best);
        } else {
          reject(new Error('No stream detected via network sniffing'));
        }
      }, timeout);

      const onRequest = async (request) => {
        try {
          const url = request.url();
          const resourceType = request.resourceType();

          const patterns = [
            { regex: /playlist\.m3u8/i, type: 'hls', priority: 11 },
            { regex: /\.m3u8(\?|$)/i, type: 'hls', priority: 10 },
            { regex: /chunklist.*\.m3u8/i, type: 'hls', priority: 8 },
            { regex: /manifest\.mpd/i, type: 'dash', priority: 10 },
            { regex: /\.mpd(\?|$)/i, type: 'dash', priority: 9 },
            { regex: /\.mp4(\?|$)/i, type: 'progressive', priority: 3 },
            { regex: /\.ts(\?|$)/i, type: 'hls-segment', priority: 1 },
          ];

          for (const { regex, type, priority } of patterns) {
            if (regex.test(url)) {
              if (type === 'hls-segment') {
                continue;
              }

              try {
                const response = await request.response();
                if (response) {
                  const contentType = response.headers()['content-type'] || '';
                  const isValidType = this.validateContentType(contentType, type);

                  if (isValidType || resourceType === 'media' || resourceType === 'xhr' || resourceType === 'fetch') {
                    this.streamCandidates.set(url, {
                      url,
                      type,
                      priority,
                      contentType,
                      resourceType,
                      timestamp: Date.now(),
                    });

                    this.logger?.debug('Stream candidate detected', {
                      url,
                      type,
                      priority,
                      contentType,
                      resourceType,
                    });

                    if (priority >= 10 && type !== 'progressive') {
                      this.logger?.info('High-priority stream detected, resolving immediately', {
                        url,
                        type,
                        priority,
                      });
                      clearTimeout(timer);
                      page.off('request', onRequest);
                      resolve({ url, type });
                      return;
                    }
                  }
                }
              } catch (error) {
                this.streamCandidates.set(url, {
                  url,
                  type,
                  priority,
                  timestamp: Date.now(),
                });

                this.logger?.debug('Stream candidate detected (no response validation)', {
                  url,
                  type,
                  priority,
                });
              }
            }
          }
        } catch (error) {
          this.logger?.debug('Error in request handler', { error: error.message });
        }
      };

      page.on('request', onRequest);

      const cleanup = () => {
        clearTimeout(timer);
        page.off('request', onRequest);
      };

      timer.unref = cleanup;
    });
  }

  validateContentType(contentType, expectedType) {
    const lowerContentType = contentType.toLowerCase();

    const typeMap = {
      hls: ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'video/mp2t', 'audio/mpegurl'],
      dash: ['application/dash+xml'],
      progressive: ['video/mp4', 'video/webm', 'video/ogg'],
    };

    const validTypes = typeMap[expectedType] || [];
    return validTypes.some(t => lowerContentType.includes(t));
  }

  selectBestCandidate() {
    if (this.streamCandidates.size === 0) {
      this.logger?.debug('No stream candidates available');
      return null;
    }

    const sorted = Array.from(this.streamCandidates.values())
      .filter(c => c.type !== 'progressive')
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.timestamp - b.timestamp;
      });

    if (sorted.length === 0) {
      const progressiveSorted = Array.from(this.streamCandidates.values())
        .filter(c => c.type === 'progressive')
        .sort((a, b) => a.timestamp - b.timestamp);

      if (progressiveSorted.length > 0) {
        const best = progressiveSorted[0];
        this.logger?.debug('Selected progressive stream (fallback)', {
          url: best.url,
          type: best.type,
          priority: best.priority,
        });
        return { url: best.url, type: best.type };
      }

      return null;
    }

    const best = sorted[0];
    this.logger?.info('Selected best stream candidate', {
      url: best.url,
      type: best.type,
      priority: best.priority,
      totalCandidates: this.streamCandidates.size,
    });

    return { url: best.url, type: best.type };
  }
}

module.exports = NetworkDetector;
