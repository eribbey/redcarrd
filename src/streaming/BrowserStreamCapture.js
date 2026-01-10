const { chromium } = require('playwright');
const { EventEmitter } = require('events');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BROWSER_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-notifications',
  '--use-fake-ui-for-media-stream',
  '--allow-file-access-from-files',
  '--enable-features=AudioServiceOutOfProcess',
];

/**
 * Captures video and audio from a browser tab using CDP and MediaRecorder
 */
class BrowserStreamCapture extends EventEmitter {
  constructor({
    logger,
    width = parseInt(process.env.CAPTURE_WIDTH) || 1280,
    height = parseInt(process.env.CAPTURE_HEIGHT) || 720,
    quality = parseInt(process.env.CAPTURE_QUALITY) || 80,
    fps = parseInt(process.env.CAPTURE_FPS) || 30,
  }) {
    super();
    this.logger = logger;
    this.width = width;
    this.height = height;
    this.quality = quality;
    this.targetFps = fps;

    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdpSession = null;

    this.isCapturing = false;
    this.isPaused = false;
    this.frameCount = 0;
    this.lastFrameTime = 0;
    this.minFrameInterval = 1000 / fps;
    this.audioInterval = null;
  }

  async start(embedUrl) {
    this.logger?.info('Starting browser capture', { embedUrl, width: this.width, height: this.height });

    try {
      // Launch browser
      this.browser = await chromium.launch({
        headless: true,
        args: BROWSER_LAUNCH_ARGS,
      });

      this.context = await this.browser.newContext({
        userAgent: DEFAULT_USER_AGENT,
        viewport: { width: this.width, height: this.height },
        ignoreHTTPSErrors: true,
        bypassCSP: true,
      });

      // Anti-detection scripts
      await this.context.addInitScript(() => {
        window.open = () => null;
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4] });
        window.chrome = window.chrome || { runtime: {} };
      });

      this.page = await this.context.newPage();
      this.page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      this.page.on('popup', popup => popup.close().catch(() => {}));

      // Navigate to embed
      this.logger?.debug('Navigating to embed URL', { embedUrl });
      await this.page.goto(embedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // Wait for video element
      await this.waitForVideo();

      // Trigger playback
      await this.triggerPlayback();

      // Resize viewport to match video
      await this.resizeToVideo();

      // Create CDP session
      this.cdpSession = await this.context.newCDPSession(this.page);

      // Start video capture
      await this.startVideoCapture();

      // Start audio capture
      await this.startAudioCapture();

      this.isCapturing = true;
      this.emit('ready');

      this.logger?.info('Browser capture started successfully', {
        frameCount: this.frameCount,
        width: this.width,
        height: this.height,
      });

      return true;
    } catch (error) {
      this.logger?.error('Failed to start browser capture', {
        error: error.message,
        embedUrl,
      });
      await this.stop();
      throw error;
    }
  }

  async waitForVideo() {
    this.logger?.debug('Waiting for video element');

    try {
      await this.page.waitForSelector('video', { timeout: 30000 });
      this.logger?.debug('Video element found');
    } catch (error) {
      this.logger?.warn('No video element found, continuing anyway');
    }
  }

  async triggerPlayback() {
    this.logger?.debug('Triggering video playback');

    // Initial wait for page to settle
    await this.page.waitForTimeout(2000);

    // Try to play the video
    await this.page.evaluate(() => {
      function tryPlay() {
        // Try native video element
        const video = document.querySelector('video');
        if (video) {
          video.muted = true;
          video.volume = 0;
          const playPromise = video.play();
          if (playPromise && playPromise.catch) {
            playPromise.catch(() => {});
          }
        }

        // Try audio elements
        const audios = document.querySelectorAll('audio');
        audios.forEach(audio => {
          audio.muted = true;
          audio.volume = 0;
          const p = audio.play();
          if (p && p.catch) p.catch(() => {});
        });

        // Try JWPlayer
        if (typeof window.jwplayer === 'function') {
          try {
            let player = window.jwplayer();
            if (!player || !player.play) {
              const jwElem = document.querySelector('.jwplayer, [id^="jwplayer"], [id^="vplayer"]');
              if (jwElem) player = window.jwplayer(jwElem);
            }
            if (player && player.setMute && player.play) {
              player.setMute(true);
              player.play();
            }
          } catch (e) {}
        }

        // Try VideoJS
        if (typeof window.videojs !== 'undefined') {
          try {
            const players = window.videojs.players || {};
            Object.keys(players).forEach(id => {
              const p = players[id];
              if (p && p.muted && p.play) {
                p.muted(true);
                p.play();
              }
            });
          } catch (e) {}
        }
      }

      tryPlay();
      // Also set up click handler in case user interaction is needed
      document.body.addEventListener('click', tryPlay, { once: true });
    });

    // Wait for video to start playing
    try {
      await this.page.waitForFunction(
        () => {
          const video = document.querySelector('video');
          return video && !video.paused && video.readyState >= 3;
        },
        { timeout: 15000 }
      );
      this.logger?.debug('Video is playing');
    } catch (error) {
      this.logger?.warn('Could not confirm video playback, continuing anyway');
    }

    // Additional wait for stream to stabilize
    await this.page.waitForTimeout(3000);
  }

  async resizeToVideo() {
    try {
      const videoRect = await this.page.evaluate(() => {
        const video = document.querySelector('video');
        if (!video) return null;
        const rect = video.getBoundingClientRect();
        return {
          width: Math.ceil(rect.width),
          height: Math.ceil(rect.height),
          x: rect.x,
          y: rect.y,
        };
      });

      if (videoRect && videoRect.width > 100 && videoRect.height > 100) {
        // Clamp to reasonable dimensions
        const width = Math.min(Math.max(videoRect.width, 640), 1920);
        const height = Math.min(Math.max(videoRect.height, 360), 1080);

        await this.page.setViewportSize({ width, height });
        this.width = width;
        this.height = height;

        this.logger?.debug('Viewport resized to match video', { width, height });
      }
    } catch (error) {
      this.logger?.debug('Could not resize viewport to video', { error: error.message });
    }
  }

  async startVideoCapture() {
    this.logger?.debug('Starting CDP screencast');

    // Listen for screencast frames
    this.cdpSession.on('Page.screencastFrame', async (frame) => {
      if (!this.isCapturing || this.isPaused) return;

      try {
        const now = Date.now();
        const elapsed = now - this.lastFrameTime;

        // Frame rate limiting - drop frames if coming too fast
        if (elapsed < this.minFrameInterval * 0.8) {
          // Acknowledge but don't process (drop frame)
          await this.cdpSession.send('Page.screencastFrameAck', {
            sessionId: frame.sessionId,
          });
          return;
        }

        this.lastFrameTime = now;
        this.frameCount++;

        // Decode base64 frame to buffer
        const frameBuffer = Buffer.from(frame.data, 'base64');

        // Emit frame for pipeline
        this.emit('frame', frameBuffer, {
          timestamp: now,
          frameNumber: this.frameCount,
          metadata: frame.metadata,
        });

        // Acknowledge frame to request next one
        await this.cdpSession.send('Page.screencastFrameAck', {
          sessionId: frame.sessionId,
        });
      } catch (error) {
        this.logger?.debug('Error processing screencast frame', { error: error.message });
      }
    });

    // Start screencast
    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.quality,
      maxWidth: this.width,
      maxHeight: this.height,
      everyNthFrame: 1,
    });

    this.logger?.debug('CDP screencast started');
  }

  async startAudioCapture() {
    this.logger?.debug('Starting audio capture');

    try {
      // Inject audio capture script
      const success = await this.page.evaluate(() => {
        try {
          // Find video/audio elements
          const mediaElements = document.querySelectorAll('video, audio');
          if (mediaElements.length === 0) {
            console.debug('[AudioCapture] No media elements found');
            return false;
          }

          // Create audio context
          const AudioContext = window.AudioContext || window.webkitAudioContext;
          if (!AudioContext) {
            console.debug('[AudioCapture] AudioContext not available');
            return false;
          }

          const audioContext = new AudioContext();
          const destination = audioContext.createMediaStreamDestination();

          // Track connected elements to avoid double-connecting
          const connectedElements = new Set();

          // Connect media elements to our destination
          mediaElements.forEach(media => {
            if (connectedElements.has(media)) return;

            try {
              // Check if element already has a source
              if (media.__audioSource) {
                media.__audioSource.connect(destination);
              } else {
                const source = audioContext.createMediaElementSource(media);
                media.__audioSource = source;
                source.connect(destination);
                source.connect(audioContext.destination); // Also play to speakers (muted)
              }
              connectedElements.add(media);
            } catch (e) {
              // Element might already be connected to another context
              console.debug('[AudioCapture] Could not connect element:', e.message);
            }
          });

          // Set up MediaRecorder
          const mediaRecorder = new MediaRecorder(destination.stream, {
            mimeType: 'audio/webm;codecs=opus',
          });

          window.__audioCapture = {
            context: audioContext,
            recorder: mediaRecorder,
            chunks: [],
            isRecording: false,
          };

          mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
              window.__audioCapture.chunks.push(e.data);
            }
          };

          mediaRecorder.start(100); // Capture every 100ms
          window.__audioCapture.isRecording = true;

          console.debug('[AudioCapture] Audio capture started');
          return true;
        } catch (error) {
          console.debug('[AudioCapture] Error starting audio capture:', error.message);
          return false;
        }
      });

      if (success) {
        // Poll for audio chunks
        this.audioInterval = setInterval(async () => {
          if (!this.isCapturing || this.isPaused) return;

          try {
            const chunks = await this.page.evaluate(async () => {
              if (!window.__audioCapture || !window.__audioCapture.chunks.length) {
                return [];
              }

              const chunks = window.__audioCapture.chunks;
              window.__audioCapture.chunks = [];

              // Convert blobs to base64
              const results = [];
              for (const chunk of chunks) {
                try {
                  const buffer = await chunk.arrayBuffer();
                  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
                  results.push(base64);
                } catch (e) {}
              }
              return results;
            });

            // Emit audio chunks
            for (const base64Chunk of chunks) {
              const audioBuffer = Buffer.from(base64Chunk, 'base64');
              this.emit('audioChunk', audioBuffer);
            }
          } catch (error) {
            // Page might be closed
            if (this.isCapturing) {
              this.logger?.debug('Error getting audio chunks', { error: error.message });
            }
          }
        }, 100);

        this.logger?.debug('Audio capture started');
      } else {
        this.logger?.warn('Audio capture could not be started (no media elements or unsupported)');
      }
    } catch (error) {
      this.logger?.warn('Failed to start audio capture', { error: error.message });
    }
  }

  pause() {
    this.isPaused = true;
    this.logger?.debug('Browser capture paused');
  }

  resume() {
    this.isPaused = false;
    this.logger?.debug('Browser capture resumed');
  }

  async stop() {
    this.logger?.info('Stopping browser capture', { frameCount: this.frameCount });

    this.isCapturing = false;

    // Stop audio polling
    if (this.audioInterval) {
      clearInterval(this.audioInterval);
      this.audioInterval = null;
    }

    // Stop screencast
    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Page.stopScreencast');
      } catch (error) {}
      try {
        await this.cdpSession.detach();
      } catch (error) {}
      this.cdpSession = null;
    }

    // Close browser
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {}
      this.browser = null;
      this.context = null;
      this.page = null;
    }

    this.emit('stopped');
    this.logger?.info('Browser capture stopped');
  }

  getMetrics() {
    return {
      isCapturing: this.isCapturing,
      isPaused: this.isPaused,
      frameCount: this.frameCount,
      width: this.width,
      height: this.height,
      quality: this.quality,
      targetFps: this.targetFps,
    };
  }
}

module.exports = BrowserStreamCapture;
