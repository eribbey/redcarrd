/**
 * jPlayer adapter for detecting streams from jQuery jPlayer instances
 * Supports standard jPlayer and variants
 */
class JPlayerAdapter {
  constructor() {
    this.name = 'jPlayer';
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

    function normalizeUrl(url) {
      if (!url) return null;
      if (typeof url === 'object' && url.src) return url.src;
      if (typeof url === 'string') return url;
      return null;
    }

    try {
      if (typeof jQuery === 'undefined' || typeof jQuery.jPlayer === 'undefined') {
        console.debug('[JPlayerAdapter] jQuery or jPlayer not found');
        return null;
      }

      const jPlayerElements = jQuery('.jp-jplayer, [id^="jquery_jplayer"], [id*="jplayer"], .jplayer, [class*="jplayer"]');

      console.debug('[JPlayerAdapter] Found jPlayer elements:', jPlayerElements.length);

      for (let i = 0; i < jPlayerElements.length; i++) {
        const elem = jPlayerElements.eq(i);

        const data = elem.data('jPlayer');
        if (data && data.status) {
          const src = normalizeUrl(data.status.src);
          if (src) {
            const type = inferType(src);
            console.debug('[JPlayerAdapter] Detected from jPlayer data:', { src, type });
            if (type !== 'progressive') {
              return { url: src, type };
            }
          }
        }

        if (data && data.html && data.html.video && data.html.video.used) {
          const src = normalizeUrl(data.html.video.used.src);
          if (src) {
            const type = inferType(src);
            console.debug('[JPlayerAdapter] Detected from jPlayer html.video:', { src, type });
            if (type !== 'progressive') {
              return { url: src, type };
            }
          }
        }

        if (data && data.html && data.html.audio && data.html.audio.used) {
          const src = normalizeUrl(data.html.audio.used.src);
          if (src) {
            const type = inferType(src);
            console.debug('[JPlayerAdapter] Detected from jPlayer html.audio:', { src, type });
            if (type !== 'progressive') {
              return { url: src, type };
            }
          }
        }

        const media = elem.find('video, audio');
        if (media.length > 0) {
          const mediaElem = media[0];
          const src = normalizeUrl(mediaElem.src || mediaElem.currentSrc);
          if (src) {
            const type = inferType(src, mediaElem.type || mediaElem.currentType);
            console.debug('[JPlayerAdapter] Detected from media element inside jPlayer:', { src, type });
            if (type !== 'progressive') {
              return { url: src, type };
            }
          }

          const sources = media.find('source');
          for (let j = 0; j < sources.length; j++) {
            const sourceElem = sources[j];
            const src = normalizeUrl(sourceElem.src);
            if (src) {
              const type = inferType(src, sourceElem.type);
              console.debug('[JPlayerAdapter] Detected from source element inside jPlayer:', { src, type });
              if (type !== 'progressive') {
                return { url: src, type };
              }
            }
          }
        }

        const jPlayerData = elem.data();
        for (const key in jPlayerData) {
          if (key.toLowerCase().includes('src') || key.toLowerCase().includes('url') || key.toLowerCase().includes('stream')) {
            const value = jPlayerData[key];
            const src = normalizeUrl(value);
            if (src && typeof src === 'string' && (src.startsWith('http') || src.startsWith('//'))) {
              const type = inferType(src);
              console.debug('[JPlayerAdapter] Detected from data attribute:', { key, src, type });
              if (type !== 'progressive') {
                return { url: src, type };
              }
            }
          }
        }
      }

      if (typeof window.jpPlayerId !== 'undefined') {
        const jplayerInstance = jQuery('#' + window.jpPlayerId);
        if (jplayerInstance.length > 0) {
          const data = jplayerInstance.data('jPlayer');
          if (data && data.status && data.status.src) {
            const src = normalizeUrl(data.status.src);
            const type = inferType(src);
            console.debug('[JPlayerAdapter] Detected from window.jpPlayerId:', { src, type });
            if (type !== 'progressive') {
              return { url: src, type };
            }
          }
        }
      }

      console.debug('[JPlayerAdapter] No non-progressive stream found');
      return null;
    } catch (error) {
      console.debug('[JPlayerAdapter] Detection error:', error.message);
      return null;
    }
  }
}

module.exports = JPlayerAdapter;
