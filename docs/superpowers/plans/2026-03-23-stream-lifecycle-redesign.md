# Stream Lifecycle Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic scrape-build-hydrate rebuild cycle with three independent loops (event discovery, stream resolution, health checking) so the IPTV playlist only contains verified-playable channels.

**Architecture:** Three async loops run continuously from `server.js`. The event loop scrapes the API and builds channels (no resolution). The resolution loop picks pending/failed/expiring channels one at a time and resolves via Playwright. The health check loop validates resolved streams every 30s and removes broken ones from the playlist.

**Tech Stack:** Node.js (CommonJS), Express.js, Playwright, Axios, Jest

**Spec:** `docs/superpowers/specs/2026-03-23-stream-lifecycle-redesign-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/channelManager.js` | Modify | Add status fields to channel schema, resolution loop, health check loop, update playlist/EPG filtering, update `selectSource`/`selectQuality`, remove `hydrateStreams`/`playlistReady`/`hydrationInProgress`/`needsReResolution`/cooldown |
| `src/server.js` | Modify | Replace `rebuildChannels` with event loop, start resolution + health loops at boot, add graceful shutdown, update `/api/state` and `/playlist.m3u8` endpoints |
| `src/__tests__/channelManager.test.js` | Modify | Update existing tests for new schema, add tests for resolution loop, health check loop, status lifecycle |
| `src/__tests__/server.test.js` | Create | Tests for updated endpoints (playlist always-200, state endpoint status counts) |

---

## Task 1: Add Status Fields to Channel Schema

> **Note:** This task adds the new fields alongside the existing hydration system. Both systems coexist temporarily. Task 2 removes the legacy system. This incremental approach keeps the code buildable/testable between commits.

**Files:**
- Modify: `src/channelManager.js:126-149` (`createOrUpdateChannel`)
- Test: `src/__tests__/channelManager.test.js`

- [ ] **Step 1: Write failing test for new channel status fields**

Add to `src/__tests__/channelManager.test.js`:

```javascript
test('creates channels with pending status and lifecycle fields', async () => {
  const manager = new ChannelManager({ lifetimeHours: 24, logger });
  const events = [
    {
      title: 'Game A',
      startTime: '2024-01-01T12:00:00Z',
      category: 'football',
      embedUrl: 'https://example.com/embed/a',
      sourceOptions: [],
      qualityOptions: [],
    },
  ];

  await manager.buildChannels(events, ['football']);
  const channel = manager.channels[0];

  expect(channel.status).toBe('pending');
  expect(channel.failCount).toBe(0);
  expect(channel.nextRetryAt).toBeNull();
  expect(channel.lastHealthCheck).toBeNull();
  expect(channel.healthFailCount).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/channelManager.test.js -t "creates channels with pending status"`
Expected: FAIL — `channel.status` is `undefined`

- [ ] **Step 3: Add status fields to `createOrUpdateChannel`**

In `src/channelManager.js`, update `createOrUpdateChannel` to include new fields:

```javascript
createOrUpdateChannel(id, event, existing, expiresAt) {
  const embedUrlChanged = existing?.embedUrl && existing.embedUrl !== event.embedUrl;
  const requestHeaders =
    event.requestHeaders ||
    (embedUrlChanged ? buildDefaultStreamHeaders(event.embedUrl) : existing?.requestHeaders || buildDefaultStreamHeaders(event.embedUrl));

  // Reset dead channels to pending on event refresh
  const preserveStatus = existing?.status && existing.status !== 'dead';
  const status = embedUrlChanged ? 'pending' : (preserveStatus ? existing.status : 'pending');

  return {
    id,
    category: event.category || 'uncategorized',
    title: event.title,
    embedUrl: event.embedUrl,
    streamUrl: embedUrlChanged ? null : event.streamUrl || existing?.streamUrl || null,
    streamMimeType: embedUrlChanged ? null : event.streamMimeType || existing?.streamMimeType || null,
    requestHeaders,
    sourceOptions: event.sourceOptions || existing?.sourceOptions || [],
    qualityOptions: event.qualityOptions || existing?.qualityOptions || [],
    cookies: embedUrlChanged ? [] : existing?.cookies || [],
    selectedSource: event.sourceOptions?.length
      ? { source: event.sourceOptions[0].source, sourceId: event.sourceOptions[0].sourceId }
      : existing?.selectedSource || null,
    streamMode: existing?.streamMode || null,
    streamHeaders: embedUrlChanged ? null : existing?.streamHeaders || null,
    expiresAt,
    // Lifecycle fields
    status,
    resolvedAt: embedUrlChanged ? null : existing?.resolvedAt || null,
    lastHealthCheck: embedUrlChanged ? null : existing?.lastHealthCheck || null,
    failCount: (embedUrlChanged || !preserveStatus) ? 0 : existing?.failCount || 0,
    nextRetryAt: (embedUrlChanged || !preserveStatus) ? null : existing?.nextRetryAt || null,
    healthFailCount: embedUrlChanged ? 0 : existing?.healthFailCount || 0,
    healthFailTimestamps: embedUrlChanged ? [] : existing?.healthFailTimestamps || [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/channelManager.test.js -t "creates channels with pending status"`
Expected: PASS

- [ ] **Step 5: Write test for dead channel reset on event refresh**

```javascript
test('resets dead channels to pending on event refresh', async () => {
  const manager = new ChannelManager({ lifetimeHours: 24, logger });
  const events = [
    {
      title: 'Game A',
      startTime: '2024-01-01T12:00:00Z',
      category: 'football',
      embedUrl: 'https://example.com/embed/a',
      sourceOptions: [],
      qualityOptions: [],
    },
  ];

  await manager.buildChannels(events, ['football']);
  manager.channels[0].status = 'dead';
  manager.channels[0].failCount = 5;

  // Rebuild with same events — dead should reset
  await manager.buildChannels(events, ['football']);
  expect(manager.channels[0].status).toBe('pending');
  expect(manager.channels[0].failCount).toBe(0);
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/__tests__/channelManager.test.js -t "resets dead channels"`
Expected: PASS (implementation already handles this)

- [ ] **Step 7: Commit**

```bash
git add src/channelManager.js src/__tests__/channelManager.test.js
git commit -m "Add status lifecycle fields to channel schema"
```

---

## Task 2: Remove Legacy Hydration System

**Files:**
- Modify: `src/channelManager.js:36-55` (constructor), `src/channelManager.js:151-192` (`hydrateStreams`), `src/channelManager.js:226-230` (`generatePlaylist`), `src/channelManager.js:415-420` (`needsReResolution`)
- Modify: `src/channelManager.js:194-224` (`selectSource`, `selectQuality`)
- Test: `src/__tests__/channelManager.test.js`

- [ ] **Step 1: Write failing test for playlist without playlistReady gate**

```javascript
test('generatePlaylist returns healthy channels without playlistReady gate', () => {
  const manager = new ChannelManager({ lifetimeHours: 24, logger });
  manager.channels = [
    { id: 'ch-1', category: 'football', title: 'Game A', streamUrl: 'https://stream.test/a.m3u8', status: 'healthy' },
    { id: 'ch-2', category: 'football', title: 'Game B', streamUrl: 'https://stream.test/b.m3u8', status: 'resolved' },
    { id: 'ch-3', category: 'football', title: 'Game C', streamUrl: null, status: 'pending' },
  ];

  const playlist = manager.generatePlaylist('http://localhost:3005');
  expect(playlist).toContain('ch-1');
  expect(playlist).not.toContain('ch-2');
  expect(playlist).not.toContain('ch-3');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/channelManager.test.js -t "generatePlaylist returns healthy"`
Expected: FAIL — current code checks `playlistReady` flag

- [ ] **Step 3: Update `generatePlaylist` to filter by status**

```javascript
generatePlaylist(baseUrl) {
  const lines = ['#EXTM3U'];
  this.channels
    .filter((ch) => ch.status === 'healthy' && ch.streamUrl)
    .forEach((channel) => {
      lines.push(
        `#EXTINF:-1 tvg-id="${channel.id}" group-title="${channel.category}",${channel.title || channel.category}`,
      );
      lines.push(`${baseUrl}/hls/${encodeURIComponent(channel.id)}`);
    });
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/channelManager.test.js -t "generatePlaylist returns healthy"`
Expected: PASS

- [ ] **Step 5: Update `generateEpg` to filter by healthy channel IDs**

```javascript
generateEpg() {
  const xml = create('tv', { version: '1.0', encoding: 'UTF-8' });
  const healthyIds = new Set(
    this.channels.filter((ch) => ch.status === 'healthy').map((ch) => ch.id)
  );

  this.channels.filter((ch) => healthyIds.has(ch.id)).forEach((channel) => {
    xml
      .ele('channel', { id: channel.id })
      .ele('display-name')
      .txt(channel.title || channel.category)
      .up()
      .up();
  });

  this.programmes.filter((p) => healthyIds.has(p.channelId)).forEach((programme) => {
    xml
      .ele('programme', {
        start: dayjs(programme.start).tz(this.timezone).format('YYYYMMDDHHmmss ZZ'),
        stop: dayjs(programme.stop).tz(this.timezone).format('YYYYMMDDHHmmss ZZ'),
        channel: programme.channelId,
      })
      .ele('title')
      .txt(programme.title)
      .up()
      .ele('category')
      .txt(programme.category)
      .up()
      .up();
  });

  return xml.end({ pretty: true });
}
```

- [ ] **Step 6: Update `selectSource` and `selectQuality` — replace `playlistReady = false` with `status: 'pending'`**

In `selectSource`:
```javascript
channel.streamMode = null;
channel.status = 'pending';
channel.failCount = 0;
channel.nextRetryAt = null;
channel.healthFailCount = 0;
```
Remove: `this.playlistReady = false;` and `this.hydrationInProgress = false;`

In `selectQuality`:
```javascript
channel.streamMode = null;
channel.status = 'pending';
channel.failCount = 0;
channel.nextRetryAt = null;
channel.healthFailCount = 0;
```
Remove: `this.playlistReady = false;` and `this.hydrationInProgress = false;`

- [ ] **Step 7: Remove from constructor: `playlistReady`, `hydrationInProgress`, `hydrationConcurrency`**

Update constructor to:
```javascript
constructor({
  lifetimeHours = 24,
  logger,
  frontPageUrl,
  timezoneName = 'UTC',
}) {
  this.channels = [];
  this.programmes = [];
  this.lifetimeHours = lifetimeHours;
  this.logger = logger;
  this.frontPageUrl = frontPageUrl;
  this.timezone = timezoneName;
  this.streamResolver = new StreamResolver({ logger });
  this.transmuxer = new Transmuxer({ logger });
  this.running = true; // graceful shutdown flag
}
```

- [ ] **Step 8: Delete `hydrateStreams()` method entirely (lines 151-192)**

- [ ] **Step 9: Delete `needsReResolution()` method entirely (lines 415-420)**

- [ ] **Step 10: Remove inline re-resolution and cooldown from `fetchStream()`**

Replace `fetchStream` with:
```javascript
async fetchStream(channel, targetUrl) {
  const headers = this.buildStreamHeaders(channel);
  this.logger?.debug('Proxying stream fetch', { channelId: channel?.id, targetUrl });

  const response = await axios.get(targetUrl, {
    headers,
    responseType: 'arraybuffer',
    validateStatus: (status) => status >= 200 && status < 500,
    httpsAgent: createHttpsAgent(this.logger),
  });

  this.updateCookies(channel, response.headers['set-cookie']);

  if (response.status === 403 || response.status === 410) {
    this.logger.warn('Upstream rejected request', {
      channelId: channel.id,
      status: response.status,
    });
    channel.streamUrl = null;
    channel.resolvedAt = null;
    channel.status = 'pending';
    const err = new Error(`Upstream returned ${response.status}`);
    err.upstreamStatus = response.status;
    throw err;
  }

  return response;
}
```

- [ ] **Step 11: Remove `resolveStream()` cooldown**

Replace `resolveStream` with (remove `COOLDOWN_MS` and `lastResolutionAttempt` logic):
```javascript
async resolveStream(channel) {
  const result = await this.streamResolver.resolve(channel.embedUrl, {
    referer: channel.referer || process.env.FRONT_PAGE_URL || 'https://streamed.pk',
    maxAttempts: parseInt(process.env.RESTREAM_MAX_ATTEMPTS) || 4,
  });

  if (!result) {
    this.logger.warn('Stream resolution failed', { channelId: channel.id, embedUrl: channel.embedUrl });
    return null;
  }

  channel.streamUrl = result.url;
  channel.streamHeaders = result.headers;
  channel.streamMode = result.type === 'hls' ? 'hls' : 'transmux';
  channel.resolvedAt = Date.now();

  this.logger.info('Stream resolved', {
    channelId: channel.id,
    type: result.type,
    streamMode: channel.streamMode,
  });

  return result;
}
```

- [ ] **Step 12: Remove `DEFAULT_HYDRATION_CONCURRENCY` constant at top of file**

- [ ] **Step 13: Update existing tests that reference `playlistReady` or `hydrationInProgress`**

Search tests for `playlistReady` and `hydrationInProgress` references and update or remove them.

- [ ] **Step 14: Run all channelManager tests**

Run: `npx jest src/__tests__/channelManager.test.js`
Expected: All tests PASS

- [ ] **Step 15: Commit**

```bash
git add src/channelManager.js src/__tests__/channelManager.test.js
git commit -m "Remove legacy hydration system, filter playlist by healthy status"
```

---

## Task 3: Implement Resolution Loop

**Files:**
- Modify: `src/channelManager.js` (add `getNextChannelForResolution()` and `runResolutionLoop()`)
- Test: `src/__tests__/channelManager.test.js`

- [ ] **Step 1: Write failing test for channel priority selection**

```javascript
describe('getNextChannelForResolution', () => {
  test('prioritizes pending over failed over expiring', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    const now = Date.now();
    manager.channels = [
      { id: 'ch-expiring', status: 'healthy', streamUrl: 'https://s.test/a.m3u8', resolvedAt: now - 25 * 60 * 1000, failCount: 0 },
      { id: 'ch-failed', status: 'failed', failCount: 1, nextRetryAt: now - 1000 },
      { id: 'ch-pending', status: 'pending', failCount: 0 },
    ];

    const next = manager.getNextChannelForResolution();
    expect(next.id).toBe('ch-pending');
  });

  test('respects backoff for failed channels', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.channels = [
      { id: 'ch-failed', status: 'failed', failCount: 1, nextRetryAt: Date.now() + 60000 },
    ];

    const next = manager.getNextChannelForResolution();
    expect(next).toBeNull();
  });

  test('returns null when no channels need resolution', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.channels = [
      { id: 'ch-healthy', status: 'healthy', streamUrl: 'https://s.test/a.m3u8', resolvedAt: Date.now(), failCount: 0 },
    ];

    const next = manager.getNextChannelForResolution();
    expect(next).toBeNull();
  });

  test('skips dead channels', () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.channels = [
      { id: 'ch-dead', status: 'dead', failCount: 5 },
    ];

    const next = manager.getNextChannelForResolution();
    expect(next).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/channelManager.test.js -t "getNextChannelForResolution"`
Expected: FAIL — method doesn't exist

- [ ] **Step 3: Implement `getNextChannelForResolution()`**

Add to `ChannelManager`:

```javascript
getNextChannelForResolution() {
  const now = Date.now();
  const ttlMs = (parseInt(process.env.STREAM_URL_TTL_MINUTES) || 30) * 60 * 1000;
  const maxFailures = parseInt(process.env.RESOLUTION_MAX_FAILURES) || 5;

  // Priority 1: pending channels
  const pending = this.channels.filter((ch) => ch.status === 'pending');
  if (pending.length) return pending[pending.length - 1]; // newest first

  // Priority 2: failed channels past their backoff
  const retriable = this.channels.filter(
    (ch) => ch.status === 'failed' && ch.failCount < maxFailures && (!ch.nextRetryAt || now >= ch.nextRetryAt)
  );
  if (retriable.length) return retriable[0];

  // Priority 3: expiring channels (>80% of TTL)
  const expiring = this.channels.filter(
    (ch) => (ch.status === 'healthy' || ch.status === 'resolved') &&
            ch.streamUrl && ch.resolvedAt && (now - ch.resolvedAt > ttlMs * 0.8)
  );
  if (expiring.length) return expiring[0];

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/__tests__/channelManager.test.js -t "getNextChannelForResolution"`
Expected: All PASS

- [ ] **Step 5: Write test for resolution loop status transitions**

```javascript
describe('resolution loop', () => {
  test('resolveAndUpdateStatus sets resolved on success', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.streamResolver = {
      resolve: jest.fn().mockResolvedValue({ url: 'https://s.test/live.m3u8', type: 'hls', headers: {} }),
    };

    const channel = { id: 'ch-1', status: 'pending', embedUrl: 'https://embed.test/1', failCount: 0, healthFailCount: 0 };
    manager.channels = [channel];

    await manager.resolveAndUpdateStatus(channel);

    expect(channel.status).toBe('resolved');
    expect(channel.streamUrl).toBe('https://s.test/live.m3u8');
    expect(channel.failCount).toBe(0);
    expect(channel.resolvedAt).toBeGreaterThan(0);
  });

  test('resolveAndUpdateStatus sets failed with backoff on failure', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.streamResolver = {
      resolve: jest.fn().mockResolvedValue(null),
    };

    const channel = { id: 'ch-1', status: 'pending', embedUrl: 'https://embed.test/1', failCount: 0, healthFailCount: 0 };
    manager.channels = [channel];

    await manager.resolveAndUpdateStatus(channel);

    expect(channel.status).toBe('failed');
    expect(channel.failCount).toBe(1);
    expect(channel.nextRetryAt).toBeGreaterThan(Date.now());
  });

  test('resolveAndUpdateStatus sets dead after max failures', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.streamResolver = {
      resolve: jest.fn().mockResolvedValue(null),
    };

    const channel = { id: 'ch-1', status: 'failed', embedUrl: 'https://embed.test/1', failCount: 4, healthFailCount: 0 };
    manager.channels = [channel];

    await manager.resolveAndUpdateStatus(channel);

    expect(channel.status).toBe('dead');
    expect(channel.failCount).toBe(5);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx jest src/__tests__/channelManager.test.js -t "resolution loop"`
Expected: FAIL — `resolveAndUpdateStatus` doesn't exist

- [ ] **Step 7: Implement `resolveAndUpdateStatus()`**

```javascript
async resolveAndUpdateStatus(channel) {
  const maxFailures = parseInt(process.env.RESOLUTION_MAX_FAILURES) || 5;
  const BACKOFF_STEPS = [30000, 60000, 120000, 300000, 600000]; // 30s, 1m, 2m, 5m, 10m

  try {
    const result = await this.resolveStream(channel);

    if (result) {
      channel.status = 'resolved';
      channel.failCount = 0;
      channel.nextRetryAt = null;
      this.logger.info('Channel resolved', { channelId: channel.id, streamUrl: result.url });
    } else {
      channel.failCount = (channel.failCount || 0) + 1;
      if (channel.failCount >= maxFailures) {
        channel.status = 'dead';
        this.logger.warn('Channel marked dead after max failures', { channelId: channel.id, failCount: channel.failCount });
      } else {
        channel.status = 'failed';
        const backoffMs = BACKOFF_STEPS[Math.min(channel.failCount - 1, BACKOFF_STEPS.length - 1)];
        channel.nextRetryAt = Date.now() + backoffMs;
        this.logger.info('Channel resolution failed, will retry', { channelId: channel.id, failCount: channel.failCount, nextRetryIn: backoffMs });
      }
    }
  } catch (error) {
    channel.failCount = (channel.failCount || 0) + 1;
    if (channel.failCount >= maxFailures) {
      channel.status = 'dead';
      this.logger.warn('Channel marked dead after max failures', { channelId: channel.id, failCount: channel.failCount });
    } else {
      channel.status = 'failed';
      const backoffMs = BACKOFF_STEPS[Math.min(channel.failCount - 1, BACKOFF_STEPS.length - 1)];
      channel.nextRetryAt = Date.now() + backoffMs;
      this.logger.warn('Channel resolution threw error', { channelId: channel.id, error: error.message, failCount: channel.failCount });
    }
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx jest src/__tests__/channelManager.test.js -t "resolution loop"`
Expected: All PASS

- [ ] **Step 9: Implement `runResolutionLoop()`**

```javascript
async runResolutionLoop() {
  const sleepMs = parseInt(process.env.RESOLUTION_LOOP_SLEEP_MS) || 2000;

  this.logger.info('Resolution loop started');

  while (this.running) {
    const channel = this.getNextChannelForResolution();

    if (channel) {
      await this.resolveAndUpdateStatus(channel);
    }

    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  this.logger.info('Resolution loop stopped');
}
```

- [ ] **Step 10: Run all tests**

Run: `npx jest src/__tests__/channelManager.test.js`
Expected: All PASS

- [ ] **Step 11: Commit**

```bash
git add src/channelManager.js src/__tests__/channelManager.test.js
git commit -m "Add resolution loop with priority selection and backoff"
```

---

## Task 4: Implement Health Check Loop

**Files:**
- Modify: `src/channelManager.js` (add `checkChannelHealth()` and `runHealthCheckLoop()`)
- Test: `src/__tests__/channelManager.test.js`

- [ ] **Step 1: Write failing test for HLS health check (valid manifest)**

```javascript
describe('checkChannelHealth', () => {
  test('marks HLS channel healthy when manifest contains segments', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    const hlsManifest = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment0.ts\n';

    axios.get.mockResolvedValue({
      status: 200,
      data: Buffer.from(hlsManifest),
      headers: {},
    });

    const channel = {
      id: 'ch-1', status: 'resolved', streamUrl: 'https://s.test/live.m3u8',
      streamMode: 'hls', embedUrl: 'https://embed.test/1',
      requestHeaders: {}, streamHeaders: {}, cookies: [],
      healthFailCount: 0, healthFailTimestamps: [],
    };

    await manager.checkChannelHealth(channel);
    expect(channel.status).toBe('healthy');
    expect(channel.lastHealthCheck).toBeGreaterThan(0);
  });

  test('marks HLS channel unhealthy when manifest is empty', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });

    axios.get.mockResolvedValue({
      status: 200,
      data: Buffer.from('#EXTM3U\n'),
      headers: {},
    });

    const channel = {
      id: 'ch-1', status: 'resolved', streamUrl: 'https://s.test/live.m3u8',
      streamMode: 'hls', embedUrl: 'https://embed.test/1',
      requestHeaders: {}, streamHeaders: {}, cookies: [],
      healthFailCount: 0, healthFailTimestamps: [],
    };

    await manager.checkChannelHealth(channel);
    expect(channel.status).toBe('pending');
    expect(channel.streamUrl).toBeNull();
  });

  test('marks channel unhealthy on 403', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });

    axios.get.mockResolvedValue({ status: 403, data: Buffer.from(''), headers: {} });

    const channel = {
      id: 'ch-1', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
      streamMode: 'hls', embedUrl: 'https://embed.test/1',
      requestHeaders: {}, streamHeaders: {}, cookies: [],
      healthFailCount: 0, healthFailTimestamps: [],
    };

    await manager.checkChannelHealth(channel);
    expect(channel.status).toBe('pending');
    expect(channel.streamUrl).toBeNull();
  });

  test('marks channel dead after rapid fail cycles within time window', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });

    axios.get.mockResolvedValue({ status: 403, data: Buffer.from(''), headers: {} });

    const now = Date.now();
    const channel = {
      id: 'ch-1', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
      streamMode: 'hls', embedUrl: 'https://embed.test/1',
      requestHeaders: {}, streamHeaders: {}, cookies: [],
      healthFailCount: 0,
      healthFailTimestamps: [now - 120000, now - 60000], // 2 recent failures within window
    };

    await manager.checkChannelHealth(channel);
    expect(channel.status).toBe('dead');
  });

  test('does not mark dead if failures are outside time window', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });

    axios.get.mockResolvedValue({ status: 403, data: Buffer.from(''), headers: {} });

    const now = Date.now();
    const channel = {
      id: 'ch-1', status: 'healthy', streamUrl: 'https://s.test/live.m3u8',
      streamMode: 'hls', embedUrl: 'https://embed.test/1',
      requestHeaders: {}, streamHeaders: {}, cookies: [],
      healthFailCount: 0,
      healthFailTimestamps: [now - 700000, now - 650000], // 2 old failures outside 10min window
    };

    await manager.checkChannelHealth(channel);
    // Should be pending (re-resolve), not dead — old failures pruned
    expect(channel.status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/channelManager.test.js -t "checkChannelHealth"`
Expected: FAIL — method doesn't exist

- [ ] **Step 3: Implement `checkChannelHealth()`**

```javascript
async checkChannelHealth(channel) {
  const rapidFailThreshold = parseInt(process.env.HEALTH_RAPID_FAIL_THRESHOLD) || 3;
  const rapidFailWindowMs = parseInt(process.env.HEALTH_RAPID_FAIL_WINDOW_MS) || 600000;

  try {
    const headers = this.buildStreamHeaders(channel);
    const isHls = this.isHlsChannel(channel);

    let healthy;
    if (isHls) {
      // HLS: fetch manifest and validate it contains segments
      const response = await axios.get(channel.streamUrl, {
        headers,
        responseType: 'arraybuffer',
        timeout: 10000,
        validateStatus: (status) => status >= 200 && status < 500,
        httpsAgent: createHttpsAgent(),
      });
      healthy = response.status >= 200 && response.status < 300;
      if (healthy) {
        const body = response.data?.toString('utf8') || '';
        healthy = body.includes('#EXTINF');
      }
    } else {
      // Non-HLS: HEAD request is sufficient
      const response = await axios.head(channel.streamUrl, {
        headers,
        timeout: 10000,
        validateStatus: (status) => status >= 200 && status < 500,
        httpsAgent: createHttpsAgent(),
      });
      healthy = response.status >= 200 && response.status < 300;
    }

    if (healthy) {
      channel.status = 'healthy';
      channel.lastHealthCheck = Date.now();
      // Don't reset healthFailTimestamps — they track the window for rapid-fail detection
    } else {
      this._markUnhealthy(channel, 'non-2xx or invalid manifest', rapidFailThreshold, rapidFailWindowMs);
    }
  } catch (error) {
    this._markUnhealthy(channel, error.message, rapidFailThreshold, rapidFailWindowMs);
  }
}

_markUnhealthy(channel, reason, rapidFailThreshold, rapidFailWindowMs) {
  const now = Date.now();

  // Track failure timestamps within the window
  if (!channel.healthFailTimestamps) channel.healthFailTimestamps = [];
  channel.healthFailTimestamps.push(now);

  // Prune timestamps outside the window
  channel.healthFailTimestamps = channel.healthFailTimestamps.filter(
    (ts) => now - ts < rapidFailWindowMs
  );

  if (channel.healthFailTimestamps.length >= rapidFailThreshold) {
    channel.status = 'dead';
    this.logger.warn('Channel marked dead after rapid health failures', {
      channelId: channel.id,
      failuresInWindow: channel.healthFailTimestamps.length,
      reason,
    });
  } else {
    channel.status = 'pending';
    channel.streamUrl = null;
    channel.resolvedAt = null;
    channel.failCount = 0;
    channel.nextRetryAt = null;
    this.logger.warn('Channel health check failed, queued for re-resolution', {
      channelId: channel.id, reason,
      failuresInWindow: channel.healthFailTimestamps.length,
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/__tests__/channelManager.test.js -t "checkChannelHealth"`
Expected: All PASS

- [ ] **Step 5: Implement `runHealthCheckLoop()`**

```javascript
async runHealthCheckLoop() {
  const intervalSeconds = parseInt(process.env.HEALTH_CHECK_INTERVAL_SECONDS) || 30;

  this.logger.info('Health check loop started', { intervalSeconds });

  while (this.running) {
    const checkable = this.channels.filter(
      (ch) => ch.status === 'resolved' || ch.status === 'healthy'
    );

    for (const channel of checkable) {
      if (!this.running) break;
      await this.checkChannelHealth(channel);
    }

    // Clean up transmux jobs for channels that went unhealthy
    const unhealthyIds = this.channels
      .filter((ch) => ch.status !== 'healthy' && ch.status !== 'resolved')
      .map((ch) => ch.id);
    await this.cleanupTransmuxJobs(unhealthyIds);

    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }

  this.logger.info('Health check loop stopped');
}
```

- [ ] **Step 6: Run all tests**

Run: `npx jest src/__tests__/channelManager.test.js`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/channelManager.js src/__tests__/channelManager.test.js
git commit -m "Add health check loop with HLS manifest validation"
```

---

## Task 5: Update Server — Event Loop, Boot Sequence, Shutdown

**Files:**
- Modify: `src/server.js:35-88` (replace `rebuildChannels`, `scheduleRebuild`, boot)
- Modify: `src/server.js:90-98` (`/api/state` endpoint)
- Modify: `src/server.js:168-171` (`/api/rebuild` endpoint)
- Modify: `src/server.js:185-192` (`/playlist.m3u8` endpoint)

- [ ] **Step 1: Replace `rebuildChannels` with event-only `refreshEvents`**

```javascript
async function refreshEvents() {
  const timezone = config.timezone || defaultConfig.timezone;
  const metaContext = { frontPageUrl: FRONT_PAGE_URL, timezone };

  try {
    logger.info('Starting event refresh', metaContext);

    const events = await scrapeFrontPage(FRONT_PAGE_URL, timezone, logger);
    const categoryCounts = events.reduce((acc, event) => {
      const category = (event.category || 'uncategorized').toString();
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});

    logger.info('Scraped front page events', { ...metaContext, totalEvents: events.length, categoryCounts });
    if (!events.length) {
      logger.warn('No events parsed from front page', metaContext);
    }

    await channelManager.buildChannels(events, config.categories);
    lastRebuild = new Date().toISOString();
    logger.info('Event refresh completed', { ...metaContext, channelCount: channelManager.channels.length });
  } catch (error) {
    logger.error('Failed to refresh events', { ...metaContext, error: error.message, stack: error.stack });
  }
}
```

- [ ] **Step 2: Replace `scheduleRebuild` with event loop timer**

```javascript
let eventLoopTimer = null;
function scheduleEventLoop() {
  if (eventLoopTimer) clearInterval(eventLoopTimer);
  const minutes = parseInt(process.env.EVENT_POLL_INTERVAL_MINUTES) || config.rebuildIntervalMinutes || defaultConfig.rebuildIntervalMinutes;
  eventLoopTimer = setInterval(refreshEvents, minutes * 60 * 1000);
  logger.info(`Scheduled event refresh every ${minutes} minutes`);
}
```

- [ ] **Step 3: Update boot sequence**

Replace:
```javascript
scheduleRebuild();
rebuildChannels();
```

With:
```javascript
// Boot sequence
(async () => {
  await refreshEvents();
  scheduleEventLoop();
  channelManager.runResolutionLoop();
  channelManager.runHealthCheckLoop();
})();
```

- [ ] **Step 4: Add graceful shutdown handler**

```javascript
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  channelManager.running = false;
  if (eventLoopTimer) clearInterval(eventLoopTimer);
  channelManager.streamResolver.closeBrowser().then(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

- [ ] **Step 5: Update `/playlist.m3u8` — remove `playlistReady` check**

```javascript
app.get('/playlist.m3u8', (req, res) => {
  res.set('Content-Type', 'application/x-mpegurl');
  res.send(channelManager.generatePlaylist(`${req.protocol}://${req.get('host')}`));
});
```

- [ ] **Step 6: Update `/api/state` — remove `playlistReady`/`hydrating`, add status counts**

```javascript
app.get('/api/state', (req, res) => {
  const statusCounts = channelManager.channels.reduce((acc, ch) => {
    acc[ch.status] = (acc[ch.status] || 0) + 1;
    return acc;
  }, {});

  res.json({
    config,
    channels: channelManager.channels,
    logs: logger.getEntries(),
    lastRebuild,
    statusCounts,
  });
});
```

- [ ] **Step 7: Update `/api/rebuild` to call `refreshEvents`**

```javascript
app.post('/api/rebuild', async (req, res) => {
  await refreshEvents();
  res.json({ status: 'ok', lastRebuild });
});
```

- [ ] **Step 8: Remove `HYDRATION_CONCURRENCY` import and ChannelManager constructor arg**

Remove from top of file:
```javascript
const HYDRATION_CONCURRENCY = Number(process.env.HYDRATION_CONCURRENCY) || 5;
```

Update ChannelManager construction:
```javascript
const channelManager = new ChannelManager({
  lifetimeHours: config.lifetimeHours || defaultConfig.lifetimeHours,
  logger,
  frontPageUrl: FRONT_PAGE_URL,
  timezoneName: config.timezone || defaultConfig.timezone,
});
```

- [ ] **Step 9: Update `/api/config` handler — replace `scheduleRebuild()` with `scheduleEventLoop()`**

Find `scheduleRebuild()` call in the config endpoint and replace with `scheduleEventLoop()`.

- [ ] **Step 10: Run all tests**

Run: `npx jest`
Expected: All PASS

- [ ] **Step 11: Commit**

```bash
git add src/server.js
git commit -m "Replace rebuild cycle with event loop, start resolution and health loops at boot"
```

---

## Task 6: Integration Smoke Test

**Files:**
- Test: `src/__tests__/channelManager.test.js`

- [ ] **Step 1: Write integration test for full lifecycle**

```javascript
describe('lifecycle integration', () => {
  test('channel goes from pending to resolved to healthy', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });
    manager.streamResolver = {
      resolve: jest.fn().mockResolvedValue({ url: 'https://s.test/live.m3u8', type: 'hls', headers: {} }),
    };

    // Build channel — should be pending
    await manager.buildChannels([
      { title: 'Game', startTime: '2024-01-01T12:00:00Z', category: 'football', embedUrl: 'https://embed.test/1', sourceOptions: [], qualityOptions: [] },
    ], ['football']);
    expect(manager.channels[0].status).toBe('pending');

    // Playlist should be empty (no healthy channels)
    let playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).not.toContain('ch-');

    // Resolution picks it up
    const channel = manager.getNextChannelForResolution();
    expect(channel).not.toBeNull();
    await manager.resolveAndUpdateStatus(channel);
    expect(channel.status).toBe('resolved');

    // Still not in playlist (not yet health-checked)
    playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).not.toContain('ch-');

    // Health check passes
    const hlsManifest = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment0.ts\n';
    axios.get.mockResolvedValue({ status: 200, data: Buffer.from(hlsManifest), headers: {} });
    await manager.checkChannelHealth(channel);
    expect(channel.status).toBe('healthy');

    // Now in playlist
    playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toContain(channel.id);
  });

  test('channel removed from playlist when health check fails', async () => {
    const manager = new ChannelManager({ lifetimeHours: 24, logger });

    manager.channels = [{
      id: 'ch-test', category: 'football', title: 'Game', embedUrl: 'https://embed.test/1',
      streamUrl: 'https://s.test/live.m3u8', streamMode: 'hls', status: 'healthy',
      requestHeaders: {}, streamHeaders: {}, cookies: [], healthFailCount: 0,
    }];

    // Verify in playlist
    let playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toContain('ch-test');

    // Health check fails
    axios.get.mockResolvedValue({ status: 403, data: Buffer.from(''), headers: {} });
    await manager.checkChannelHealth(manager.channels[0]);

    // Removed from playlist, queued for re-resolution
    playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).not.toContain('ch-test');
    expect(manager.channels[0].status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx jest src/__tests__/channelManager.test.js -t "lifecycle integration"`
Expected: All PASS

- [ ] **Step 3: Run full test suite**

Run: `npx jest`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/channelManager.test.js
git commit -m "Add lifecycle integration tests for channel status transitions"
```

---

## Task 7: Server Endpoint Tests

**Files:**
- Create: `src/__tests__/server.test.js`

- [ ] **Step 1: Write test for `/playlist.m3u8` always returning 200**

```javascript
const request = require('supertest');

// Mock dependencies before requiring server
jest.mock('../scraper', () => ({
  scrapeFrontPage: jest.fn().mockResolvedValue([]),
  createProgrammeFromEvent: jest.fn().mockReturnValue({ channelId: 'ch-1', title: 'T', category: 'c', start: new Date(), stop: new Date() }),
  buildDefaultStreamHeaders: jest.fn().mockReturnValue({}),
}));

jest.mock('playwright', () => ({
  chromium: { launch: jest.fn().mockResolvedValue({ isConnected: () => true, newContext: jest.fn(), close: jest.fn(), on: jest.fn() }) },
}));

describe('Server endpoints', () => {
  let app;

  beforeAll(() => {
    // Require app after mocks are set up
    // The server module needs to export app for testing
    // For now, test via the channelManager directly
  });

  test('playlist.m3u8 returns valid M3U8 even with no channels', async () => {
    const ChannelManager = require('../channelManager');
    const manager = new ChannelManager({
      lifetimeHours: 24,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    manager.channels = [];

    const playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toBe('#EXTM3U');
  });

  test('playlist only includes healthy channels', () => {
    const ChannelManager = require('../channelManager');
    const manager = new ChannelManager({
      lifetimeHours: 24,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    manager.channels = [
      { id: 'ch-ok', category: 'football', title: 'OK', streamUrl: 'https://s.test/a.m3u8', status: 'healthy' },
      { id: 'ch-pending', category: 'football', title: 'Pending', streamUrl: null, status: 'pending' },
      { id: 'ch-dead', category: 'football', title: 'Dead', streamUrl: null, status: 'dead' },
    ];

    const playlist = manager.generatePlaylist('http://localhost:3005');
    expect(playlist).toContain('ch-ok');
    expect(playlist).not.toContain('ch-pending');
    expect(playlist).not.toContain('ch-dead');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx jest src/__tests__/server.test.js`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/server.test.js
git commit -m "Add server endpoint tests for playlist filtering"
```

---

## Task 8: Update CLAUDE.md Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update architecture section**

Update the Channel Build critical path:
```
Channel Build: server.js (event refresh) → scraper.js → channelManager.js (build only, no hydration)
Stream Resolution: channelManager.js (resolution loop) → streamResolver.js
Health Checks: channelManager.js (health loop) → upstream stream URLs
Playlist Serving: server.js → channelManager.js (healthy filter) → client
```

- [ ] **Step 2: Update environment variables section**

Add new variables:
- `EVENT_POLL_INTERVAL_MINUTES` (default 10)
- `HEALTH_CHECK_INTERVAL_SECONDS` (default 30)
- `RESOLUTION_LOOP_SLEEP_MS` (default 2000)
- `RESOLUTION_MAX_FAILURES` (default 5)
- `HEALTH_RAPID_FAIL_THRESHOLD` (default 3)
- `HEALTH_RAPID_FAIL_WINDOW_MS` (default 600000)

Remove: `HYDRATION_CONCURRENCY`

- [ ] **Step 3: Update module responsibilities for channelManager.js**

Reflect the three-loop architecture, removal of hydration, and health-check-based playlist filtering.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md for stream lifecycle redesign"
```
