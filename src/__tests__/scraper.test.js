process.env.SCRAPER_RENDER_WITH_JS = 'false';

const nock = require('nock');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { parseFrontPage, parseEmbedPage, resolveStreamFromEmbed, createProgrammeFromEvent } = require('../scraper');

dayjs.extend(utc);
dayjs.extend(timezone);

const frontPageHtml = `
<div class="match-card" data-category="football" onclick="openMatch('https://ntvstream.cx/embed?a')">
  <div class="match-title">Match A</div>
  <select id="sourceSelect">
    <option value="https://ntvstream.cx/embed?a">Source A</option>
    <option value="https://ntvstream.cx/embed?b">Source B</option>
  </select>
  <select id="qualitySelect">
    <option value="https://ntvstream.cx/embed?a&quality=720">720p</option>
    <option value="https://ntvstream.cx/embed?a&quality=480">480p</option>
  </select>
</div>
<div class="match-card" data-category="basketball" onclick="openMatch('https://ntvstream.cx/embed?c')">
  <div class="match-title">Match B</div>
  <span class="time-badge">10:00</span>
</div>
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

const matchesContentHtml = `
<div id="matchesContent">
  <div class="match-card" data-category="football" onclick="watchMatch('https://ntvstream.cx/embed?d')">
    <div class="match-title">Team A vs Team B</div>
    <span class="time-badge">13:30</span>
    <select id="sourceSelect">
      <option value="https://ntvstream.cx/embed?d">Main</option>
    </select>
  </div>
</div>
`;

describe('scraper helpers', () => {
  test('parses front page events', async () => {
    nock('https://ntvstream.cx')
      .get('/embed?c')
      .reply(200, '<iframe id="streamPlayer" src="https://ntvstream.cx/embed?c"></iframe>');

    const events = await parseFrontPage(frontPageHtml);
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

  test('parses matchesContent events and extracts scheduled time', async () => {
    const timezoneName = 'Europe/London';
    const events = await parseFrontPage(matchesContentHtml, timezoneName);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'football',
      title: 'Team A vs Team B',
      embedUrl: 'https://ntvstream.cx/embed?d',
    });
    expect(events[0].sourceOptions).toHaveLength(1);
    expect(events[0].startTime).toBeInstanceOf(Date);
    const eventTime = dayjs(events[0].startTime).tz(timezoneName);
    expect(eventTime.hour()).toBe(13);
    expect(eventTime.minute()).toBe(30);
  });

  test('fetches embedUrl from onclick target when no embed is present on the card', async () => {
    const onclickOnlyHtml = `
    <div class="match-card" data-category="football" onclick="openMatch('/embedded/xyz')">
      <div class="match-title">Onclick Only</div>
    </div>`;

    nock('https://ntvstream.cx').get('/embedded/xyz').reply(
      200,
      '<iframe id="streamPlayer" src="https://ntvstream.cx/embed/xyz"></iframe>',
    );

    const events = await parseFrontPage(onclickOnlyHtml, 'UTC');
    expect(events).toHaveLength(1);
    expect(events[0].embedUrl).toBe('https://ntvstream.cx/embed/xyz');
  });

  test('resolves stream from embed via HTTP', async () => {
    nock('https://ntvstream.cx').get('/embed?a').reply(200, embedHtml);
    const result = await resolveStreamFromEmbed('https://ntvstream.cx/embed?a');
    expect(result.streamUrl).toContain('stream.m3u8');
  });

  test('creates programme with default lifetime', () => {
    const programme = createProgrammeFromEvent({ title: 'Match A', category: 'football' }, 'football-1', 24, 'UTC');
    expect(programme.channelId).toBe('football-1');
    expect(programme.start).toBeInstanceOf(Date);
    expect(programme.stop).toBeInstanceOf(Date);
  });

  test('creates programme honoring event start time and timezone', () => {
    const timezoneName = 'America/New_York';
    const startTime = dayjs().tz(timezoneName).hour(9).minute(15).second(0).millisecond(0).toDate();
    const programme = createProgrammeFromEvent(
      { title: 'Morning Match', category: 'basketball', startTime },
      'basketball-1',
      2,
      timezoneName,
    );

    const start = dayjs(programme.start).tz(timezoneName);
    const stop = dayjs(programme.stop).tz(timezoneName);
    expect(start.hour()).toBe(9);
    expect(start.minute()).toBe(15);
    expect(stop.diff(start, 'hour')).toBe(2);
  });
});
