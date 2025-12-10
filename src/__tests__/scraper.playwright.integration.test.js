process.env.SCRAPER_RENDER_WITH_JS = 'true';

const http = require('http');
const { scrapeFrontPage, resolveStreamFromEmbed } = require('../scraper');

jest.setTimeout(60000);

describe.skip('scraper playwright end-to-end', () => {
  let server;
  let serverUrl;

  const frontPageHtml = (baseUrl) => `
    <!doctype html>
    <html>
      <body>
        <div id="matchesContent"></div>
        <script>
          setTimeout(() => {
            const container = document.querySelector('#matchesContent');
            const match = document.createElement('div');
            match.className = 'match-card';
            match.dataset.category = 'football';
            match.setAttribute('onclick', "openMatch('${baseUrl}/embed/stream1')");

            const title = document.createElement('div');
            title.className = 'match-title';
            title.textContent = 'Playwright Fixture Match';
            match.appendChild(title);

            const liveBadge = document.createElement('span');
            liveBadge.className = 'live-badge';
            liveBadge.textContent = 'Live';
            match.appendChild(liveBadge);

            const time = document.createElement('span');
            time.className = 'time-badge';
            time.textContent = '10:00 AM';
            match.appendChild(time);

            const iframe = document.createElement('iframe');
            iframe.id = 'streamPlayer';
            iframe.src = '${baseUrl}/embed/stream1';
            iframe.srcdoc = '<html><body>Placeholder</body></html>';
            match.appendChild(iframe);

            const sourceSelect = document.createElement('select');
            sourceSelect.id = 'sourceSelect';
            sourceSelect.innerHTML = \`
              <option value="${baseUrl}/embed/stream1">Primary</option>
              <option value="${baseUrl}/embed/stream2">Backup</option>
            \`;
            match.appendChild(sourceSelect);

            const qualitySelect = document.createElement('select');
            qualitySelect.id = 'qualitySelect';
            qualitySelect.innerHTML = \`
              <option value="${baseUrl}/embed/stream1?quality=1080">1080p</option>
              <option value="${baseUrl}/embed/stream1?quality=720">720p</option>
            \`;
            match.appendChild(qualitySelect);

            container.appendChild(match);
          }, 50);
        </script>
      </body>
    </html>
  `;

  const embedHtml = (baseUrl) => `
    <!doctype html>
    <html>
      <body>
        <div id="playerHost"></div>
        <script>
          setTimeout(() => {
            const host = document.querySelector('#playerHost');
            const iframe = document.createElement('iframe');
            iframe.id = 'streamIframe';
            iframe.src = '${baseUrl}/hls/primary.m3u8';
            iframe.srcdoc = '<html><body>Stream Placeholder</body></html>';
            host.appendChild(iframe);

            const sourceSelect = document.createElement('select');
            sourceSelect.id = 'sourceSelect';
            sourceSelect.innerHTML = \`
              <option value="${baseUrl}/embed/stream1">Primary</option>
              <option value="${baseUrl}/embed/stream2">Backup</option>
            \`;
            host.appendChild(sourceSelect);

            const qualitySelect = document.createElement('select');
            qualitySelect.id = 'qualitySelect';
            qualitySelect.innerHTML = \`
              <option value="${baseUrl}/embed/stream1?quality=1080">1080p</option>
              <option value="${baseUrl}/embed/stream1?quality=540">540p</option>
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
        res.end(frontPageHtml(serverUrl));
        return;
      }

      if (req.url.startsWith('/embed/')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(embedHtml(serverUrl));
        return;
      }

      if (req.url.startsWith('/hls/')) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U');
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('scrapes front page and resolves embed via Playwright renderer', async () => {
    const events = await scrapeFrontPage(`${serverUrl}/front`, 'UTC');

    expect(events.length).toBeGreaterThan(0);
    const [event] = events;
    expect(event.embedUrl).toBe(`${serverUrl}/embed/stream1`);
    expect(event.sourceOptions.length).toBeGreaterThan(0);
    expect(event.qualityOptions.length).toBeGreaterThan(0);

    const resolved = await resolveStreamFromEmbed(event.embedUrl, undefined, { useRenderer: true });

    expect(resolved.streamUrl).toBe(`${serverUrl}/hls/primary.m3u8`);
    expect(resolved.sourceOptions.length).toBeGreaterThan(0);
    expect(resolved.qualityOptions.length).toBeGreaterThan(0);
  });
});
