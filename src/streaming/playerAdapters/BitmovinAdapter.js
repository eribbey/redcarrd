/**
 * Bitmovin adapter for detecting streams from Bitmovin player instances
 */
class BitmovinAdapter {
  constructor() {
    this.name = 'Bitmovin';
  }

  detect() {
    function inferType(url, mime) {
      if (!url) return null;
      const urlLower = url.toLowerCase();
      const mimeLower = (mime || '').toLowerCase();

      if (urlLower.includes('.m3u8') || mimeLower.includes('mpegurl') || mimeLower.includes('m3u8') || mimeLower.includes('hls')) {
        return 'hls';
      }
      if (urlLower.includes('.mpd') || mimeLower.includes('dash')) {
        return 'dash';
      }
      return 'progressive';
    }

    try {
      if (typeof window.bitmovin === 'undefined' || !window.bitmovin.player) {
        console.debug('[BitmovinAdapter] Bitmovin player not found');
        return null;
      }

      const playerInstances = window.bitmovin.player.instances || [];

      for (const instance of playerInstances) {
        if (instance && typeof instance.getSource === 'function') {
          try {
            const source = instance.getSource();
            if (source) {
              const src = source.hls || source.dash || source.progressive;
              const detectedType = source.hls ? 'hls' : source.dash ? 'dash' : 'progressive';

              if (src && detectedType !== 'progressive') {
                console.debug('[BitmovinAdapter] Detected from player instance:', { src, type: detectedType });
                return { url: src, type: detectedType };
              }
            }
          } catch (error) {
            console.debug('[BitmovinAdapter] Failed to get source from instance');
          }
        }
      }

      const bitmovinElements = document.querySelectorAll('[class*="bitmovin"], [id*="bitmovin"]');
      for (const elem of bitmovinElements) {
        const dataSrc = elem.getAttribute('data-source') || elem.getAttribute('data-src');
        if (dataSrc) {
          const type = inferType(dataSrc);
          if (type && type !== 'progressive') {
            console.debug('[BitmovinAdapter] Detected from data attribute:', { src: dataSrc, type });
            return { url: dataSrc, type };
          }
        }
      }

      console.debug('[BitmovinAdapter] No stream found');
      return null;
    } catch (error) {
      console.debug('[BitmovinAdapter] Detection error:', error.message);
      return null;
    }
  }
}

module.exports = BitmovinAdapter;
