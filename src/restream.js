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

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-notifications',
        '--mute-audio'
      ]
    });

    // Add init script to neuter window.open before any page scripts run
    context = await browser.newContext();
    await context.addInitScript(() => {
      // Disable popups
      window.open = () => null;
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

    // Promise that resolves when we see a .m3u8 request
    const hlsUrlPromise = waitForHlsUrl(page, 45000);

    console.log('[+] Navigating to page…');
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('[+] Trying to start playback…');
    await autoplayVideo(page);

    console.log('[+] Waiting for underlying HLS (.m3u8) URL…');
    const hlsUrl = await hlsUrlPromise;
    console.log(`[+] Detected source HLS URL: ${hlsUrl}`);

    // Collect user-agent and cookies to help ffmpeg mimic the browser
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cookies = await context.cookies(hlsUrl).catch(() => []);
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const headerLines = [];
    headerLines.push(`Referer: ${pageUrl}`);
    if (cookieHeader) headerLines.push(`Cookie: ${cookieHeader}`);
    const headersArg = headerLines.join('\r\n') + '\r\n';

    const outPlaylist = path.join(outputDir, `${streamName}.m3u8`);
    const outSegments = path.join(outputDir, `${streamName}_%03d.ts`);

    console.log('[+] Starting ffmpeg HLS restream…');
    console.log(`[+] Output playlist: ${outPlaylist}`);

    const ffmpegArgs = [
      '-loglevel', 'warning',
      '-fflags', '+genpts',
      // Read input in real-time to simulate live rebroadcast
      '-re',
      // Browser-like headers
      '-headers', headersArg,
      '-user_agent', userAgent,
      // Input
      '-i', hlsUrl,
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
 * Resolve with first .m3u8 URL seen in network requests.
 */
function waitForHlsUrl(page, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;

    function finish(err, url) {
      if (done) return;
      done = true;
      page.removeListener('request', onRequest);
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(url);
    }

    const timer = setTimeout(() => {
      finish(new Error('Timed out waiting for .m3u8 URL'));
    }, timeoutMs);

    function onRequest(request) {
      try {
        const url = request.url();
        if (/\.m3u8(\?|$)/i.test(url)) {
          finish(null, url);
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

