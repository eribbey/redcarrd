process.env.SCRAPER_RENDER_WITH_JS = 'true';

const http = require('http');
const { chromium } = require('playwright');
const { parseFrontPage, parseEmbedPage } = require('../scraper');

jest.setTimeout(30000);

describe.skip('scraper rendering integration', () => {
  let server;
  let serverUrl;
  let browser;

  const frontPageHtml = `
    <!doctype html>
    <html>
      <body>
        <div id="matchesContent">
          <div class="match-card" data-category="football" onclick="openMatch('/embed/stream1')">
            <div class="match-title">Dynamic Match</div>
            <span class="live-badge">Live</span>
            <span class="time-badge">11:45 AM</span>
            <div id="dynamic-container"></div>
          </div>
        </div>
        <script>
          setTimeout(() => {
            const container = document.querySelector('#dynamic-container');
            const iframe = document.createElement('iframe');
            iframe.id = 'streamPlayer';
            iframe.src = '/embed/stream1';
            container.appendChild(iframe);

            const sourceSelect = document.createElement('select');
            sourceSelect.id = 'sourceSelect';
            sourceSelect.innerHTML = \`
              <option value="/embed/stream1">Main Source</option>
              <option value="/embed/stream2">Backup Source</option>
            \`;
            container.appendChild(sourceSelect);

            const qualitySelect = document.createElement('select');
            qualitySelect.id = 'qualitySelect';
            qualitySelect.innerHTML = \`
              <option value="/embed/stream1?quality=1080">1080p</option>
              <option value="/embed/stream1?quality=720">720p</option>
            \`;
            container.appendChild(qualitySelect);
          }, 50);
        </script>
      </body>
    </html>
  `;

  const embedHtml = `
    <!doctype html>
    <html>
      <body>
        <div id="playerHost"></div>
        <script>
          setTimeout(() => {
            const host = document.querySelector('#playerHost');
            const iframe = document.createElement('iframe');
            iframe.id = 'streamIframe';
            iframe.src = '/hls/primary.m3u8';
            host.appendChild(iframe);

            const sourceSelect = document.createElement('select');
            sourceSelect.id = 'sourceSelect';
            sourceSelect.innerHTML = \`
              <option value="/embed/stream1">Primary</option>
              <option value="/embed/stream2">Backup</option>
            \`;
            host.appendChild(sourceSelect);

            const qualitySelect = document.createElement('select');
            qualitySelect.id = 'qualitySelect';
            qualitySelect.innerHTML = \`
              <option value="/embed/stream1?quality=1080">1080p</option>
              <option value="/embed/stream1?quality=480">480p</option>
            \`;
            host.appendChild(qualitySelect);
          }, 50);
        </script>
      </body>
    </html>
  `;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/front')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(frontPageHtml);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(embedHtml);
    });

    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    serverUrl = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  });

  async function renderPath(path) {
    const page = await browser.newPage();
    await page.goto(`${serverUrl}${path}`, { waitUntil: 'domcontentloaded' });
    // Allow any client-side scripts to run and mutate the DOM.
    await page.waitForTimeout(600);
    const content = await page.content();
    await page.close();
    return content;
  }

  test('renders dynamic front page content with iframe and options', async () => {
    const rendered = await renderPath('/front');

    expect(rendered).toContain('iframe id="streamPlayer"');
    expect(rendered).toContain('option value="/embed/stream1"');

    const events = await parseFrontPage(rendered, 'UTC');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Dynamic Match',
      category: 'football',
      embedUrl: '/embed/stream1',
    });
    expect(events[0].sourceOptions).toHaveLength(2);
    expect(events[0].qualityOptions).toHaveLength(2);
  });

  test('renders dynamic embed page content and parses stream info', async () => {
    const rendered = await renderPath('/embed');

    expect(rendered).toContain('iframe id="streamIframe"');
    expect(rendered).toContain('option value="/embed/stream1"');

    const result = parseEmbedPage(rendered);
    expect(result.streamUrl).toContain('/hls/primary.m3u8');
    expect(result.sourceOptions).toHaveLength(2);
    expect(result.qualityOptions).toHaveLength(2);
  });
});
