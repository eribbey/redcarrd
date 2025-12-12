#!/usr/bin/env node

/**
 * jw_restream_playwright.js
 *
 * Usage:
 *   node jw_restream_playwright.js <page-url> [stream-name] [output-dir]
 *
 * Example:
 *   node jw_restream_playwright.js "https://example.com/embed/jwplayer.html" mychannel ./hls_out
 *
 * Requirements (install in your container):
 *   npm install playwright
 *   ffmpeg must be available in PATH
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const PLAYWRIGHT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-notifications',
  '--mute-audio',
  '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
  '--disable-site-isolation-trials',
];

function randomDesktopViewport() {
  const widths = [1280, 1366, 1440, 1536, 1920];
  const width = widths[Math.floor(Math.random() * widths.length)];
  const height = Math.floor(width * (9 / 16) + Math.random() * 60);
  return { width, height };
}

async function main() {
  const pageUrl = process.argv[2];
  const streamName = process.argv[3] || 'stream';
  const outputDir = path.resolve(process.argv[4] || path.join(__dirname, 'hls_output'));

  if (!pageUrl) {
    console.error('Usage: node jw_restream_playwright.js <page-url> [stream-name] [output-dir]');
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[+] Starting JWPlayer restreamer (Playwright)`);
  console.log(`[+] Page URL: ${pageUrl}`);
  console.log(`[+] Stream name: ${streamName}`);
  console.log(`[+] Output dir: ${outputDir}`);

  let browser;
  let context;
  let page;
  let ffmpegProc;
  const userAgent = DEFAULT_STREAM_UA;
  const viewport = randomDesktopViewport();

  try {
    browser = await chromium.launch({
      headless: true,
      args: PLAYWRIGHT_LAUNCH_ARGS
    });

    context = await browser.newContext({
      userAgent,
      viewport,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    await context.addInitScript(() => {
      // Disable popups
      window.open = () => null;
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4] });
      window.chrome = window.chrome || { runtime: {} };
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) =>
          parameters?.name === 'notifications'
            ? Promise.resolve({ state: 'denied' })
            : originalQuery(parameters);
      }
    });

    page = await context.newPage();

    // Dismiss JS dialogs
    page.on('dialog', async (dialog) => {
      try {
        await dialog.dismiss();
      } catch (_) {}
    });

    // Close popup windows immediately if any slip through
    page.on('popup', async (popup) => {
      try {
        await popup.close();
      } catch (_) {}
    });

    console.log('[+] Navigating to page…');
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });

    const maxDetectionAttempts = 2;
    let streamInfo = null;
    let lastDetectionError = null;

    for (let attempt = 1; attempt <= maxDetectionAttempts; attempt += 1) {
      const streamUrlPromise = waitForHlsUrl(page, 90000);

      if (attempt > 1) {
        console.warn(`[!] Retrying playback/HLS detection (attempt ${attempt}/${maxDetectionAttempts})…`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
      }

      console.log('[+] Trying to start playback…');
      await autoplayVideo(page);

      console.log('[+] Waiting for underlying stream manifest (HLS/DASH)…');
      try {
        streamInfo = await streamUrlPromise;
        break;
      } catch (error) {
        lastDetectionError = error;
      }
    }

    if (!streamInfo) {
      throw lastDetectionError || new Error('Failed to detect HLS/DASH URL');
    }
    console.log(`[+] Detected source stream (${streamInfo.type}): ${streamInfo.url}`);

    // Collect user-agent and cookies to help ffmpeg mimic the browser
    const cookies = await context.cookies(streamInfo.url).catch(() => []);
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const headerLines = [];
    headerLines.push(`Referer: ${pageUrl}`);
    if (cookieHeader) headerLines.push(`Cookie: ${cookieHeader}`);
    const headersArg = headerLines.join('\r\n') + '\r\n';

    const outPlaylist = path.join(outputDir, `${streamName}.m3u8`);
    const outSegments = path.join(outputDir, `${streamName}_%03d.ts`);

    console.log('[+] Starting ffmpeg HLS restream…');
    console.log(`[+] Output playlist: ${outPlaylist}`);

    const isDash = streamInfo.type === 'dash';

    const ffmpegArgs = [
      '-loglevel', 'warning',
      '-fflags', '+genpts',
      // Read input in real-time to simulate live rebroadcast
      '-re',
      // Browser-like headers
      '-headers', headersArg,
      '-user_agent', userAgent,
      // DASH manifests sometimes require explicit protocol allowlisting
      ...(isDash ? ['-protocol_whitelist', 'file,http,https,tcp,tls'] : []),
      // Input
      ...(isDash ? ['-i', streamInfo.url, '-map', '0'] : ['-i', streamInfo.url]),
      // Copy codecs (no re-encode); change to -c:v libx264 -c:a aac if transcoding needed
      '-c', 'copy',
      // HLS output options
      '-f', 'hls',
      '-hls_time', '4',                     // seconds per segment
      '-hls_list_size', '8',                // sliding window size
      '-hls_flags', 'delete_segments+append_list+program_date_time',
      '-hls_playlist_type', 'live',
      '-start_number', '0',
      '-hls_segment_filename', outSegments,
      outPlaylist
    ];

    ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    ffmpegProc.stdout.on('data', (data) => {
      console.log(`[ffmpeg] ${data.toString().trim()}`);
    });

    ffmpegProc.stderr.on('data', (data) => {
      console.error(`[ffmpeg] ${data.toString().trim()}`);
    });

    ffmpegProc.on('exit', (code, signal) => {
      console.log(`[!] ffmpeg exited (code=${code}, signal=${signal})`);
      process.exit(code || 0);
    });

    // You can keep the browser open if the origin uses very short-lived, session-bound tokens.
    // Here we close it once we have the HLS URL.
    await browser.close();
    browser = null;
    context = null;
    page = null;

    console.log('===================================================');
    console.log('[+] Restream running.');
    console.log('[+] HLS output playlist (for your collector):');
    console.log(`    ${outPlaylist}`);
    console.log('===================================================');

    // Keep Node process alive as long as ffmpeg is running
  } catch (err) {
    console.error('[!] Error:', err.message || err);
    if (ffmpegProc && !ffmpegProc.killed) {
      ffmpegProc.kill('SIGINT');
    }
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    process.exit(1);
  }

  // Handle Ctrl+C for clean shutdown
  process.on('SIGINT', () => {
    console.log('\n[!] Caught SIGINT, shutting down…');
    if (ffmpegProc && !ffmpegProc.killed) {
      ffmpegProc.kill('SIGINT');
    }
    process.exit(0);
  });
}

/**
 * Resolve with first streaming URL seen in network requests.
 * Supports HLS (.m3u8), DASH (.mpd), and progressive MP4 as a fallback.
 */
function waitForHlsUrl(page, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;

    function finish(err, info) {
      if (done) return;
      done = true;
      page.removeListener('request', onRequest);
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(info);
    }

    const timer = setTimeout(() => {
      finish(new Error('Timed out waiting for stream URL'));
    }, timeoutMs);

    function onRequest(request) {
      try {
        const url = request.url();
        if (/\.m3u8(\?|$)/i.test(url)) {
          finish(null, { type: 'hls', url });
        } else if (/\.mpd(\?|$)/i.test(url)) {
          finish(null, { type: 'dash', url });
        } else if (/\.(mp4)(\?|$)/i.test(url)) {
          finish(null, { type: 'progressive', url });
        }
      } catch (e) {
        // ignore
      }
    }

    page.on('request', onRequest);
  });
}

/**
 * Try to autoplay the video in the page:
 * - HTML5 <video> element (muted)
 * - JWPlayer API if available (jwplayer())
 */
async function autoplayVideo(page) {
  // Give page scripts a moment to set up the player
  await page.waitForTimeout(2000);

  await page.evaluate(() => {
    function tryPlay() {
      try {
        // HTML5 <video>
        const vid = document.querySelector('video');
        if (vid) {
          vid.muted = true;
          const p = vid.play();
          if (p && p.catch) p.catch(() => {});
        }

        // JWPlayer global API
        if (typeof window.jwplayer === 'function') {
          try {
            let player;
            try {
              // Default instance
              player = window.jwplayer();
            } catch (_) {
              // Try to locate a player element
              const jwElem =
                document.querySelector('.jwplayer, [id^="jwplayer"], [id^="vplayer"]');
              if (jwElem) {
                player = window.jwplayer(jwElem);
              }
            }
            if (player) {
              player.setMute(true);
              player.play();
            }
          } catch (_) {
            // ignore
          }
        }
      } catch (_) {
        // ignore
      }
    }

    // initial attempt
    tryPlay();

    // also bind to user interaction events in case the site insists
    document.body.addEventListener('click', tryPlay, { once: true });
    document.body.addEventListener('keydown', tryPlay, { once: true });
  });

  await page.waitForTimeout(5000);
}

main();

