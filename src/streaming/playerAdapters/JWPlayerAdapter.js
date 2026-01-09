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

      if (player) {
        const candidates = [];

        // Method 1: getPlaylist()
        if (typeof player.getPlaylist === 'function') {
          const playlist = player.getPlaylist() || [];
          for (const item of playlist) {
            if (item.file) {
              const candidate = normalizeCandidate(item.file, item.type);
              if (candidate) candidates.push(candidate);
            }

            const sources = item.sources || [];
            for (const source of sources) {
              if (source.file) {
                const candidate = normalizeCandidate(source.file, source.type);
                if (candidate) candidates.push(candidate);
              }
            }
          }
        }

        // Method 2: getPlaylistItem() - current item
        if (typeof player.getPlaylistItem === 'function') {
          try {
            const currentItem = player.getPlaylistItem();
            if (currentItem) {
              if (currentItem.file) {
                const candidate = normalizeCandidate(currentItem.file, currentItem.type);
                if (candidate) candidates.push(candidate);
              }
              const sources = currentItem.sources || [];
              for (const source of sources) {
                if (source.file) {
                  const candidate = normalizeCandidate(source.file, source.type);
                  if (candidate) candidates.push(candidate);
                }
              }
            }
          } catch (error) {
            console.debug('[JWPlayerAdapter] getPlaylistItem failed');
          }
        }

        // Method 3: getConfig().sources
        if (typeof player.getConfig === 'function') {
          try {
            const config = player.getConfig();
            if (config) {
              // Check config.sources directly
              if (config.sources && Array.isArray(config.sources)) {
                for (const source of config.sources) {
                  if (source.file) {
                    const candidate = normalizeCandidate(source.file, source.type);
                    if (candidate) candidates.push(candidate);
                  }
                }
              }
              // Check config.file directly
              if (config.file) {
                const candidate = normalizeCandidate(config.file, config.type);
                if (candidate) candidates.push(candidate);
              }
              // Check config.playlist
              if (config.playlist && Array.isArray(config.playlist)) {
                for (const item of config.playlist) {
                  if (item.file) {
                    const candidate = normalizeCandidate(item.file, item.type);
                    if (candidate) candidates.push(candidate);
                  }
                  if (item.sources && Array.isArray(item.sources)) {
                    for (const source of item.sources) {
                      if (source.file) {
                        const candidate = normalizeCandidate(source.file, source.type);
                        if (candidate) candidates.push(candidate);
                      }
                    }
                  }
                }
              }
            }
          } catch (error) {
            console.debug('[JWPlayerAdapter] getConfig failed');
          }
        }

        // Method 4: Check video element src directly
        const jwContainer = document.querySelector('.jwplayer, [id^="jwplayer"], [id^="vplayer"]');
        if (jwContainer) {
          const video = jwContainer.querySelector('video');
          if (video && (video.src || video.currentSrc)) {
            const src = video.currentSrc || video.src;
            const candidate = normalizeCandidate(src);
            if (candidate) candidates.push(candidate);
          }
        }

        // Return first non-progressive candidate
        const nonProgressiveCandidate = candidates.find(c => c.type !== 'progressive');
        if (nonProgressiveCandidate) {
          console.debug('[JWPlayerAdapter] Detected:', nonProgressiveCandidate);
          return nonProgressiveCandidate;
        }

        // Fallback to progressive
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
