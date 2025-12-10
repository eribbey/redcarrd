process.env.SCRAPER_RENDER_WITH_JS = 'false';

const nock = require('nock');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const {
  parseEmbedPage,
  resolveStreamFromEmbed,
  createProgrammeFromEvent,
  extractHlsStreamsFromJwPlayerBundle,
  scrapeFrontPage,
  buildEventsFromApi,
} = require('../scraper');

dayjs.extend(utc);
dayjs.extend(timezone);

const embedHtml = `
<div>
  <iframe id="streamIframe" src="https://cdn.example.com/stream.m3u8"></iframe>
  <select id="sourceSelect">
    <option value="https://streamed.pk/embed?a">Primary</option>
  </select>
  <select id="qualitySelect">
    <option value="https://streamed.pk/embed?a&quality=1080">1080p</option>
    <option value="https://streamed.pk/embed?a&quality=720">720p</option>
  </select>
</div>
`;

const embedHtmlWithOnclickOptions = `
<div>
  <select id="sourceSelect">
    <option onclick="changeSource('/embed/stream1')">Primary</option>
    <option data-url="/embed/stream2">Backup</option>
  </select>
</div>
`;

describe('scraper helpers', () => {
  test('buildEventsFromApi keeps all sources and maps start time', () => {
    const timezoneName = 'UTC';
    const matches = [
      {
        title: 'Admin Match',
        category: 'soccer',
        date: 1736420400000,
        sources: [
          { source: 'admin', id: 'admin-1' },
          { source: 'bravo', id: 'other' },
        ],
      },
      {
        title: 'Non Admin Match',
        category: 'hockey',
        sources: [{ source: 'echo', id: 'other' }],
      },
    ];

    const events = buildEventsFromApi(matches, 'https://streamed.pk', timezoneName);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ category: 'soccer', title: 'Admin Match' });
    expect(events[0].sources).toHaveLength(2);
    expect(events[0].startTime).toBeInstanceOf(Date);
    expect(events[1]).toMatchObject({ category: 'hockey', title: 'Non Admin Match' });
  });

  test('scrapeFrontPage builds hydrated events from streamed.pk APIs', async () => {
    const liveMatches = [
      {
        title: 'API Match',
        category: 'basketball',
        date: 1736420400000,
        sources: [
          { source: 'admin', id: 'api-match-1' },
          { source: 'charlie', id: 'api-match-1' },
        ],
      },
    ];

    const adminStreams = [
      {
        id: 'api-match-1',
        streamNo: 1,
        language: 'English',
        hd: true,
        embedUrl: 'https://embedsports.top/embed/admin/api-match-1/1',
        source: 'admin',
      },
    ];

    const charlieStreams = [
      {
        id: 'api-match-1',
        streamNo: 2,
        language: 'Spanish',
        hd: false,
        embedUrl: 'https://embedsports.top/embed/charlie/api-match-1/2',
        source: 'charlie',
      },
    ];

    nock('https://streamed.pk').get('/api/matches/live').reply(200, liveMatches);
    nock('https://streamed.pk').get('/api/stream/admin/api-match-1').reply(200, adminStreams);
    nock('https://streamed.pk').get('/api/stream/charlie/api-match-1').reply(200, charlieStreams);

    const events = await scrapeFrontPage('https://streamed.pk', 'UTC');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'API Match',
      category: 'basketball',
      embedUrl: 'https://embedsports.top/embed/admin/api-match-1/1',
    });
    expect(events[0].sourceOptions).toHaveLength(2);
    expect(events[0].sourceOptions[0].label).toContain('ADMIN');
    expect(events[0].sourceOptions[1].label).toContain('CHARLIE');
    expect(events[0].qualityOptions).toHaveLength(0);
  });

  test('parses embed page', () => {
    const result = parseEmbedPage(embedHtml);
    expect(result.streamUrl).toContain('stream.m3u8');
    expect(result.sourceOptions[0].embedUrl).toContain('embed?a');
    expect(result.qualityOptions).toHaveLength(2);
  });

  test('parses embed options when value attribute is missing', () => {
    const result = parseEmbedPage(embedHtmlWithOnclickOptions);
    expect(result.sourceOptions.map((opt) => opt.embedUrl)).toEqual(['/embed/stream1', '/embed/stream2']);
  });

  test('resolves stream from embed via HTTP', async () => {
    nock('https://streamed.pk').get('/embed?a').reply(200, embedHtml);
    const result = await resolveStreamFromEmbed('https://streamed.pk/embed?a');
    expect(result.streamUrl).toContain('stream.m3u8');
  });

  test('creates programme with default lifetime', () => {
    const programme = createProgrammeFromEvent({ title: 'Match A', category: 'football' }, 'ch-football', 24, 'UTC');
    expect(programme.channelId).toBe('ch-football');
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

  test('extracts HLS streams from JWPlayer bundles', () => {
    const bundle = `!function(){jwplayer("v").setup({file:"https:\\/\\/cdn.example.com\\/live\\/alpha.m3u8",sources:[{file:'/beta/stream.m3u8'}]})}();`;
    const streams = extractHlsStreamsFromJwPlayerBundle(bundle);

    expect(streams).toEqual([
      'https://cdn.example.com/live/alpha.m3u8',
      'https://streamed.pk/beta/stream.m3u8',
    ]);
  });
});
