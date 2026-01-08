/**
 * Flowplayer adapter for detecting streams from Flowplayer instances
 */
class FlowplayerAdapter {
  constructor() {
    this.name = 'Flowplayer';
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
      if (typeof flowplayer === 'undefined') {
        console.debug('[FlowplayerAdapter] flowplayer not found');
        return null;
      }

      const fpElements = document.querySelectorAll('.flowplayer, [class*="flowplayer"]');

      for (const elem of fpElements) {
        try {
          const api = flowplayer(elem);
          if (api && api.video) {
            const src = api.video.src || api.video.url;
            if (src) {
              const type = inferType(src, api.video.type);
              if (type && type !== 'progressive') {
                console.debug('[FlowplayerAdapter] Detected from API:', { src, type });
                return { url: src, type };
              }
            }
          }
        } catch (error) {
          console.debug('[FlowplayerAdapter] Failed to get API for element');
        }
      }

      console.debug('[FlowplayerAdapter] No stream found');
      return null;
    } catch (error) {
      console.debug('[FlowplayerAdapter] Detection error:', error.message);
      return null;
    }
  }
}

module.exports = FlowplayerAdapter;
