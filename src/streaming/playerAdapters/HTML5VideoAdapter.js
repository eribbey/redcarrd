/**
 * HTML5 Video adapter for detecting streams from generic <video> and <audio> elements
 * Generic fallback adapter
 */
class HTML5VideoAdapter {
  constructor() {
    this.name = 'HTML5Video';
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

    function normalizeCandidate(srcUrl, mimeType) {
      if (!srcUrl) return null;
      const type = inferType(srcUrl, mimeType);
      if (!type) return null;
      return { url: srcUrl, type };
    }

    try {
      const candidates = [];

      const videoElements = document.querySelectorAll('video, audio');
      for (const vid of videoElements) {
        const currentSrc = vid.currentSrc || vid.src;
        if (currentSrc) {
          const candidate = normalizeCandidate(currentSrc, vid.type || vid.currentType);
          if (candidate) {
            candidates.push(candidate);
          }
        }

        const sources = vid.querySelectorAll('source');
        for (const source of sources) {
          if (source.src) {
            const candidate = normalizeCandidate(source.src, source.type);
            if (candidate) {
              candidates.push(candidate);
            }
          }
        }
      }

      const nonProgressiveCandidate = candidates.find(c => c.type !== 'progressive');
      if (nonProgressiveCandidate) {
        console.debug('[HTML5VideoAdapter] Detected non-progressive stream:', nonProgressiveCandidate);
        return nonProgressiveCandidate;
      }

      if (candidates.length > 0) {
        console.debug('[HTML5VideoAdapter] Found progressive fallback:', candidates[0]);
        return candidates[0];
      }

      console.debug('[HTML5VideoAdapter] No streams found in HTML5 video/audio elements');
      return null;
    } catch (error) {
      console.debug('[HTML5VideoAdapter] Detection error:', error.message);
      return null;
    }
  }
}

module.exports = HTML5VideoAdapter;
