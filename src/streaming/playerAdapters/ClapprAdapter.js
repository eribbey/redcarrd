/**
 * Clappr adapter for detecting streams from Clappr player instances
 */
class ClapprAdapter {
  constructor() {
    this.name = 'Clappr';
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
      if (typeof window.Clappr === 'undefined' && typeof window.clappr === 'undefined') {
        console.debug('[ClapprAdapter] Clappr not found');
        return null;
      }

      const Clappr = window.Clappr || window.clappr;

      if (Clappr.instances && Clappr.instances.length > 0) {
        for (const instance of Clappr.instances) {
          if (instance && instance.options && instance.options.source) {
            const src = instance.options.source;
            const type = inferType(src, instance.options.mimeType);
            if (type && type !== 'progressive') {
              console.debug('[ClapprAdapter] Detected from instance:', { src, type });
              return { url: src, type };
            }
          }
        }
      }

      const clapprElements = document.querySelectorAll('[data-player], .clappr-player, [class*="clappr"]');
      for (const elem of clapprElements) {
        const dataSrc = elem.getAttribute('data-source') || elem.getAttribute('data-src');
        if (dataSrc) {
          const type = inferType(dataSrc);
          if (type && type !== 'progressive') {
            console.debug('[ClapprAdapter] Detected from data attribute:', { src: dataSrc, type });
            return { url: dataSrc, type };
          }
        }
      }

      console.debug('[ClapprAdapter] No stream found');
      return null;
    } catch (error) {
      console.debug('[ClapprAdapter] Detection error:', error.message);
      return null;
    }
  }
}

module.exports = ClapprAdapter;
