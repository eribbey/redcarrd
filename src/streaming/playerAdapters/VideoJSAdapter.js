/**
 * VideoJS adapter for detecting streams from VideoJS player instances
 */
class VideoJSAdapter {
  constructor() {
    this.name = 'VideoJS';
  }

  detect() {
    function inferType(url, mime) {
      if (!url) return null;
      const urlLower = url.toLowerCase();
      const mimeLower = (mime || '').toLowerCase();

      if (urlLower.includes('.m3u8') || mimeLower.includes('mpegurl') || mimeLower.includes('m3u8')) {
        return 'hls';
      }
      if (urlLower.includes('.mpd') || mimeLower.includes('dash')) {
        return 'dash';
      }
      return 'progressive';
    }

    try {
      if (typeof videojs === 'undefined') {
        console.debug('[VideoJSAdapter] videojs not found');
        return null;
      }

      const players = videojs.players || {};

      for (const id in players) {
        const player = players[id];
        if (player && typeof player.currentSrc === 'function') {
          const src = player.currentSrc();
          if (src) {
            const currentType = typeof player.currentType === 'function' ? player.currentType() : '';
            const type = inferType(src, currentType);
            if (type && type !== 'progressive') {
              console.debug('[VideoJSAdapter] Detected from player instance:', { id, src, type });
              return { url: src, type };
            }
          }
        }
      }

      const vjsElements = document.querySelectorAll('.video-js, .vjs-player, [class*="video-js"]');
      for (const elem of vjsElements) {
        if (elem.src) {
          const type = inferType(elem.src);
          if (type && type !== 'progressive') {
            console.debug('[VideoJSAdapter] Detected from element:', { src: elem.src, type });
            return { url: elem.src, type };
          }
        }

        const sources = elem.querySelectorAll('source');
        for (const source of sources) {
          if (source.src) {
            const type = inferType(source.src, source.type);
            if (type && type !== 'progressive') {
              console.debug('[VideoJSAdapter] Detected from source element:', { src: source.src, type });
              return { url: source.src, type };
            }
          }
        }
      }

      console.debug('[VideoJSAdapter] No stream found');
      return null;
    } catch (error) {
      console.debug('[VideoJSAdapter] Detection error:', error.message);
      return null;
    }
  }
}

module.exports = VideoJSAdapter;
