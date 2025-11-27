const nock = require('nock');
const { parseFrontPage, parseEmbedPage, resolveStreamFromEmbed, createProgrammeFromEvent } = require('../scraper');

const frontPageHtml = `
<ul>
  <li data-category="football">
    <h3>Match A</h3>
    <iframe id="streamPlayer" src="https://ntvstream.cx/embed?a"></iframe>
    <select id="sourceSelect">
      <option value="https://ntvstream.cx/embed?a">Source A</option>
      <option value="https://ntvstream.cx/embed?b">Source B</option>
    </select>
    <select id="qualitySelect">
      <option value="https://ntvstream.cx/embed?a&quality=720">720p</option>
      <option value="https://ntvstream.cx/embed?a&quality=480">480p</option>
    </select>
  </li>
  <li data-category="basketball">
    <h3>Match B</h3>
    <iframe id="streamPlayer" src="https://ntvstream.cx/embed?c"></iframe>
  </li>
</ul>
`;

const embedHtml = `
<div>
  <iframe id="streamIframe" src="https://cdn.example.com/stream.m3u8"></iframe>
  <select id="sourceSelect">
    <option value="https://ntvstream.cx/embed?a">Primary</option>
  </select>
  <select id="qualitySelect">
    <option value="https://ntvstream.cx/embed?a&quality=1080">1080p</option>
    <option value="https://ntvstream.cx/embed?a&quality=720">720p</option>
  </select>
</div>
`;

describe('scraper helpers', () => {
  test('parses front page events', () => {
    const events = parseFrontPage(frontPageHtml);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ category: 'football', title: 'Match A' });
    expect(events[0].sourceOptions).toHaveLength(2);
    expect(events[0].qualityOptions).toHaveLength(2);
  });

  test('parses embed page', () => {
    const result = parseEmbedPage(embedHtml);
    expect(result.streamUrl).toContain('stream.m3u8');
    expect(result.sourceOptions[0].embedUrl).toContain('embed?a');
    expect(result.qualityOptions).toHaveLength(2);
  });

  test('resolves stream from embed via HTTP', async () => {
    nock('https://ntvstream.cx').get('/embed?a').reply(200, embedHtml);
    const result = await resolveStreamFromEmbed('https://ntvstream.cx/embed?a');
    expect(result.streamUrl).toContain('stream.m3u8');
  });

  test('creates programme with default lifetime', () => {
    const programme = createProgrammeFromEvent({ title: 'Match A', category: 'football' }, 'football-1');
    expect(programme.channelId).toBe('football-1');
    expect(programme.start).toBeInstanceOf(Date);
    expect(programme.stop).toBeInstanceOf(Date);
  });
});
