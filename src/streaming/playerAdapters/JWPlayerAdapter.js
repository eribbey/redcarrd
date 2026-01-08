/**
 * JWPlayer adapter for detecting streams from JWPlayer instances
 * Ports existing logic from restream.js
 */
class JWPlayerAdapter {
  constructor() {
    this.name = 'JWPlayer';
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

    function normalizeCandidate(fileUrl, mimeType) {
      if (!fileUrl) return null;
      const type = inferType(fileUrl, mimeType);
      if (!type) return null;
      return { url: fileUrl, type };
    }

    try {
      if (typeof window.jwplayer !== 'function') {
        console.debug('[JWPlayerAdapter] jwplayer not found');
        return null;
      }

      let player = null;
      try {
        player = window.jwplayer();
      } catch (error) {
        console.debug('[JWPlayerAdapter] Failed to get default player instance');
      }

      if (!player || !player.getPlaylist) {
        const jwElem = document.querySelector('.jwplayer, [id^="jwplayer"], [id^="vplayer"], [class*="jwplayer"]');
        if (jwElem) {
          try {
            player = window.jwplayer(jwElem);
          } catch (error) {
            console.debug('[JWPlayerAdapter] Failed to get player from element');
          }
        }
      }

      if (player && typeof player.getPlaylist === 'function') {
        const playlist = player.getPlaylist() || [];
        const candidates = [];

        for (const item of playlist) {
          if (item.file) {
            const candidate = normalizeCandidate(item.file, item.type);
            if (candidate) {
              candidates.push(candidate);
            }
          }

          const sources = item.sources || [];
          for (const source of sources) {
            if (source.file) {
              const candidate = normalizeCandidate(source.file, source.type);
              if (candidate) {
                candidates.push(candidate);
              }
            }
          }
        }

        const nonProgressiveCandidate = candidates.find(c => c.type !== 'progressive');
        if (nonProgressiveCandidate) {
          console.debug('[JWPlayerAdapter] Detected from playlist:', nonProgressiveCandidate);
          return nonProgressiveCandidate;
        }

        if (candidates.length > 0) {
          console.debug('[JWPlayerAdapter] Found progressive fallback:', candidates[0]);
          return candidates[0];
        }
      }

      console.debug('[JWPlayerAdapter] No stream found in JWPlayer');
      return null;
    } catch (error) {
      console.debug('[JWPlayerAdapter] Detection error:', error.message);
      return null;
    }
  }
}

module.exports = JWPlayerAdapter;
