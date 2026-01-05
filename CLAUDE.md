# CLAUDE.md - AI Assistant Guide for Redcarrd

This document provides comprehensive guidance for AI assistants working on the Redcarrd codebase.

## Table of Contents
1. [Project Overview](#project-overview)
2. [Codebase Structure](#codebase-structure)
3. [Technology Stack](#technology-stack)
4. [Development Workflows](#development-workflows)
5. [Coding Conventions](#coding-conventions)
6. [Testing Guidelines](#testing-guidelines)
7. [Common Tasks](#common-tasks)
8. [Important Patterns](#important-patterns)
9. [Troubleshooting](#troubleshooting)

---

## Project Overview

**Redcarrd** is a self-hosted IPTV proxy that scrapes live sports events and exposes dynamic playlists and EPG data. It serves as a replacement for dlhd-proxy.

### Core Functionality
- Scrapes events from streamed.pk APIs
- Resolves and restreams embed URLs using Playwright + FFmpeg
- Generates M3U8 playlists and XMLTV EPG for IPTV clients
- Provides web UI for configuration and stream preview
- Handles Cloudflare challenge bypass via solver services

### Key Capabilities
- Category-based channel organization with sequential numbering
- Automatic stream URL refresh on schedules
- Multiple stream quality/source selection
- HLS manifest proxying and rewriting
- FFmpeg-based transmuxing for non-HLS streams

---

## Codebase Structure

```
/home/user/redcarrd/
├── src/
│   ├── __tests__/                          # Jest test suites
│   │   ├── channelManager.test.js          # Channel lifecycle tests
│   │   ├── restreamer.test.js              # Restream job tests
│   │   ├── scraper.test.js                 # Non-Playwright scraper tests
│   │   ├── scraper.playwright.test.js      # Playwright unit tests
│   │   └── scraper.playwright.integration.test.js  # Integration tests
│   ├── public/                             # Frontend assets (static)
│   │   ├── index.html                      # Web UI
│   │   ├── main.js                         # Vanilla JS frontend
│   │   └── styles.css                      # Styling
│   ├── server.js                           # Main entry point - Express server
│   ├── channelManager.js                   # Channel lifecycle management
│   ├── scraper.js                          # Web scraping engine
│   ├── restreamer.js                       # Restream job orchestration
│   ├── restream.js                         # Worker script (spawned as child process)
│   ├── transmuxer.js                       # FFmpeg transmuxing
│   ├── solverClient.js                     # Cloudflare solver integration
│   ├── config.js                           # Configuration persistence
│   └── logger.js                           # Event-based logging system
├── package.json                            # Dependencies and scripts
├── Dockerfile                              # Container build
├── docker-compose.yml.example              # Docker Compose template
└── README.md                               # User documentation
```

### Module Responsibilities

#### Core Modules

**`server.js`** - Application Entry Point
- Express.js server on port 3005
- REST API endpoints (`/api/*`)
- Static file serving for UI
- M3U8 playlist (`/playlist.m3u8`) and EPG (`/epg.xml`)
- Rebuild scheduling and orchestration

**`channelManager.js`** - Channel Lifecycle
- Builds channels from scraped events
- Reconciles channel changes (add/update/remove)
- Generates M3U8 playlists and XMLTV EPG
- Proxies and rewrites HLS manifests
- Coordinates transmuxing/restreaming jobs
- Expires stale channels based on event time + lifetime

**`scraper.js`** - Event & Stream Scraping
- Fetches live events from streamed.pk API
- Two modes: Playwright (JS-rendered) or axios (static HTML)
- Extracts embed URLs and stream manifests
- Cloudflare challenge detection and bypass
- Multiple user agent fallback strategy

**`restreamer.js`** - Job Management
- Spawns Node.js child processes running `restream.js`
- Manages job lifecycle (create, monitor, cleanup)
- Validates FFmpeg and Playwright dependencies
- Handles job staleness and reuse
- Temp directory management

**`restream.js`** - Worker Process (Standalone)
- Launched as child process by restreamer.js
- Uses Playwright to load embed pages
- Detects HLS/DASH streams from network traffic
- Pipes through FFmpeg to generate local HLS output
- Graceful SIGTERM/SIGINT shutdown handling

**`transmuxer.js`** - Stream Conversion
- Converts non-HLS streams to HLS format
- Spawns FFmpeg processes with HLS output
- Creates temp working directories for segments
- Process cleanup on completion

**`solverClient.js`** - Challenge Bypass
- Integrates Flaresolverr and Byparr solver services
- Pre-fetches cookies to bypass Cloudflare challenges
- Normalizes cookie formats for Playwright
- Configurable timeout and retry logic

**`config.js`** - Configuration Management
- Loads/saves `config.json` (gitignored)
- Default configuration values
- Persists user settings (categories, rebuild interval, lifetime, timezone)

**`logger.js`** - Logging System
- EventEmitter-based logging
- Emits log events for SSE streaming to frontend
- Structured logging with timestamps and metadata
- Log levels: INFO, WARN, ERROR

---

## Technology Stack

### Backend
- **Runtime**: Node.js with CommonJS modules
- **Framework**: Express.js 5.1.0
- **Browser Automation**: Playwright 1.57.0 (Chromium)
- **HTTP Client**: Axios 1.13.2
- **HTML Parsing**: Cheerio 1.1.2 (server-side jQuery)
- **XML Generation**: xmlbuilder 15.1.1
- **Date/Time**: Day.js 1.11.19 with UTC/timezone plugins
- **Streaming**: FFmpeg (external binary dependency)

### Frontend
- **No frameworks**: Vanilla JavaScript
- **HLS Playback**: HLS.js 1.5.17 (CDN-loaded)
- **Real-time Updates**: Server-Sent Events (SSE)
- **Styling**: Modern CSS with custom properties

### Testing
- **Framework**: Jest 30.2.0
- **HTTP Mocking**: Nock 14.0.10
- **HTTP Testing**: Supertest 7.1.4

### DevOps
- **Containerization**: Docker with Playwright base image
- **Orchestration**: Docker Compose support

---

## Development Workflows

### Local Development Setup

```bash
# Install dependencies
npm install

# Run server (default port 3005)
npm start

# Run tests
npm test

# Access UI
http://localhost:3005
```

### Docker Development

```bash
# Build image
docker build -t redcarrd .

# Run container
docker run -p 3005:3005 redcarrd

# Docker Compose
docker-compose up --build
```

### Environment Variables

Key environment variables to configure:

```bash
# Server Configuration
PORT=3005                              # HTTP server port

# Scraping Configuration
FRONT_PAGE_URL=https://streamed.pk     # Target website
SCRAPER_RENDER_WITH_JS=true           # Use Playwright vs axios

# Restreaming Configuration
HYDRATION_CONCURRENCY=5                # Parallel restream jobs
RESTREAM_MAX_ATTEMPTS=4                # Stream detection retries
RESTREAM_DETECT_CONFIG_FALLBACK=true  # Player config fallback

# Solver Configuration (Cloudflare bypass)
SOLVER_ENDPOINT_URL=http://solver:8191/v1  # Flaresolverr/Byparr endpoint
SOLVER_PROVIDER=flaresolverr           # Solver type
SOLVER_ENABLED=true                    # Enable solver integration
SOLVER_MAX_TIMEOUT_MS=45000           # Solver timeout
SOLVER_API_KEY=                        # Optional API key
```

### Git Workflow

**Branch Naming**: Feature branches with descriptive names (e.g., `claude/feature-name-sessionid`)

**Commit Message Style**: Imperative mood, component-focused
- Good: "Add restream config fallback", "Fix SIGTERM handling", "Document solver endpoint"
- Bad: "Added stuff", "Fixed bug", "Updates"

**Current Branch**: Always develop on the designated feature branch (check git status)

**Before Pushing**: Ensure tests pass and code follows conventions

---

## Coding Conventions

### General Style

- **Module System**: CommonJS (`require`/`module.exports`)
- **Indentation**: 2 spaces
- **Quotes**: Single quotes for strings
- **Semicolons**: Always use semicolons
- **Naming**:
  - camelCase for functions and variables
  - PascalCase for classes
  - UPPER_CASE for constants

### File Organization

1. Requires at top (Node.js builtins, then npm packages, then local modules)
2. Constants and configuration
3. Class/function definitions
4. Module exports
5. Main execution logic (if applicable)

### Error Handling

```javascript
// GOOD: Detailed error logging with metadata
try {
  await somethingRisky();
} catch (error) {
  logger.error('Failed to process stream', {
    error: error.message,
    channelId,
    embedUrl
  });
  throw error; // Re-throw if caller should handle
}

// BAD: Silent failures or generic errors
try {
  await somethingRisky();
} catch (error) {
  console.log('Error'); // No context
}
```

### Logging Best Practices

```javascript
// GOOD: Structured logging with context
logger.info('Starting restream job', { channelId, embedUrl });
logger.warn('Stream detection failed, retrying', { attempt, maxAttempts });
logger.error('FFmpeg process crashed', { code, signal, channelId });

// BAD: String concatenation without structure
logger.info('Starting restream job for ' + channelId);
```

### Async/Await Patterns

```javascript
// GOOD: Proper error handling
async function processChannel(channel) {
  try {
    const result = await restreamer.startJob(channel);
    return result;
  } catch (error) {
    logger.error('Restream failed', { channelId: channel.id, error: error.message });
    throw error;
  }
}

// GOOD: Concurrent operations with Promise.allSettled
const results = await Promise.allSettled(
  channels.map(ch => hydrateChannel(ch))
);
```

### Dependency Injection

```javascript
// GOOD: Logger injected via constructor
class ChannelManager {
  constructor({ logger }) {
    this.logger = logger;
  }

  buildChannels(events) {
    this.logger.info('Building channels', { count: events.length });
    // ...
  }
}

// USAGE
const manager = new ChannelManager({ logger });
```

---

## Testing Guidelines

### Test Structure

Tests are located in `src/__tests__/` with the pattern `*.test.js`.

### Test Types

1. **Unit Tests** (Non-Playwright)
   - Fast, isolated tests with HTTP mocking
   - Set `SCRAPER_RENDER_WITH_JS=false` for scraper tests
   - Use Nock to mock axios requests

2. **Playwright Unit Tests**
   - Mock network responses within Playwright
   - Test browser automation logic
   - Set `SCRAPER_RENDER_WITH_JS=true`

3. **Integration Tests**
   - Real network requests
   - End-to-end workflows
   - Use sparingly due to external dependencies

### Writing Tests

```javascript
// File: src/__tests__/myModule.test.js

describe('MyModule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should handle success case', async () => {
    // Arrange
    const input = { foo: 'bar' };

    // Act
    const result = await myFunction(input);

    // Assert
    expect(result).toEqual({ success: true });
  });

  test('should handle error case', async () => {
    // Mock setup
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('Network error'));

    // Assert error thrown
    await expect(myFunction()).rejects.toThrow('Network error');
  });
});
```

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npx jest src/__tests__/channelManager.test.js

# Run with coverage
npx jest --coverage

# Watch mode
npx jest --watch
```

### Testing Conventions

- Use descriptive test names: `should [expected behavior] when [condition]`
- Arrange-Act-Assert pattern
- Mock external dependencies (HTTP, filesystem, child processes)
- Clean up resources in `afterEach` or `afterAll`
- Use snapshots for complex outputs (M3U8, XML)

---

## Common Tasks

### Adding a New Scraping Source

1. **Update `scraper.js`**:
   - Add URL extraction logic in `extractStreamUrlsFromEmbed()`
   - Handle new embed iframe patterns
   - Test with both Playwright and axios modes

2. **Test thoroughly**:
   - Add test cases in `scraper.test.js`
   - Include sample HTML fixtures
   - Test error cases

3. **Update documentation**:
   - Document new source patterns
   - Update README if user-facing

### Adding Environment Variables

1. **Define in appropriate module**:
   ```javascript
   const MY_CONFIG = process.env.MY_CONFIG || 'default-value';
   ```

2. **Document in README.md**:
   - Add to environment variables section
   - Explain purpose and valid values

3. **Add to Dockerfile/docker-compose**:
   - Update example configurations

4. **Update CLAUDE.md**:
   - Add to environment variables list

### Modifying Channel Structure

1. **Update `channelManager.js`**:
   - Modify `buildChannels()` for new fields
   - Update ID generation if needed (affects channel stability)

2. **Update playlist/EPG generation**:
   - Modify `generatePlaylistContent()` or `generateEpgXml()`
   - Ensure backward compatibility

3. **Test reconciliation**:
   - Verify add/update/remove logic handles new structure
   - Test with existing channels

4. **Update tests**:
   - Adjust snapshots if output changed
   - Add new test cases for new fields

### Adding New API Endpoints

1. **Add route in `server.js`**:
   ```javascript
   app.get('/api/my-endpoint', async (req, res) => {
     try {
       const result = await someOperation();
       res.json({ success: true, data: result });
     } catch (error) {
       logger.error('Endpoint failed', { error: error.message });
       res.status(500).json({ error: error.message });
     }
   });
   ```

2. **Update frontend** (`public/main.js`):
   - Add fetch call to new endpoint
   - Update UI if needed

3. **Add tests**:
   - Use Supertest for HTTP endpoint testing

### Debugging Restream Issues

1. **Check logs**: SSE endpoint `/logs/stream` or console output
2. **Verify FFmpeg**: Ensure binary is in PATH
3. **Check Playwright**: Validate browser installation
4. **Review temp directories**: `/tmp/restream-*` for output files
5. **Test embed URL manually**: Open in browser to verify accessibility
6. **Check solver**: Verify Flaresolverr/Byparr is reachable if configured

---

## Important Patterns

### Pattern: Event-Driven Logging

The logger extends EventEmitter, allowing the frontend to subscribe to log events:

```javascript
// Backend: Emit log events
logger.info('Message', { metadata });

// Frontend: Listen via SSE
const eventSource = new EventSource('/logs/stream');
eventSource.onmessage = (event) => {
  const log = JSON.parse(event.data);
  displayLog(log);
};
```

### Pattern: Job Management with Staleness Checks

Restream jobs are reused if still valid:

```javascript
const existingJob = this.jobs.get(channelId);
if (existingJob && !this.isJobStale(existingJob)) {
  return existingJob.manifest; // Reuse
}

// Otherwise, create new job
const job = await this.createJob(channelId, embedUrl);
this.jobs.set(channelId, job);
```

### Pattern: Graceful Degradation

Multiple fallback strategies for resilience:

```javascript
// 1. Try Playwright with multiple user agents
for (const userAgent of USER_AGENTS) {
  try {
    return await fetchWithPlaywright(url, userAgent);
  } catch (error) {
    logger.warn('Failed with user agent', { userAgent });
  }
}

// 2. Fallback to axios if Playwright fails
return await fetchWithAxios(url);
```

### Pattern: URL Normalization

Consistent URL handling across the codebase:

```javascript
function normalizeUrl(url, baseUrl) {
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return new URL(url, baseUrl).href;
  return url;
}
```

### Pattern: Manifest Rewriting

HLS manifests are rewritten line-by-line to proxy through server:

```javascript
function rewriteManifest(manifest, channelId, baseUrl) {
  return manifest.split('\n').map(line => {
    if (line.startsWith('#')) return line; // Keep comments
    if (line.trim() === '') return line;   // Keep empty lines

    const segmentUrl = normalizeUrl(line, baseUrl);
    return `/hls/${channelId}/segment?url=${encodeURIComponent(segmentUrl)}`;
  }).join('\n');
}
```

### Pattern: Concurrent with Limits

Hydrate multiple channels concurrently with configurable limit:

```javascript
const concurrency = parseInt(process.env.HYDRATION_CONCURRENCY) || 5;

for (let i = 0; i < channels.length; i += concurrency) {
  const batch = channels.slice(i, i + concurrency);
  await Promise.allSettled(batch.map(ch => hydrateChannel(ch)));
}
```

### Anti-Pattern: Avoid Hardcoding Timeouts

```javascript
// BAD: Hardcoded timeout
await page.waitForLoadState('load', { timeout: 30000 });

// GOOD: Configurable from environment
const timeout = parseInt(process.env.PAGE_LOAD_TIMEOUT_MS) || 30000;
await page.waitForLoadState('load', { timeout });
```

### Anti-Pattern: Avoid Silent Failures

```javascript
// BAD: Swallow errors without logging
try {
  await dangerousOperation();
} catch (error) {
  // Silent failure
}

// GOOD: Log and handle appropriately
try {
  await dangerousOperation();
} catch (error) {
  logger.error('Operation failed', { error: error.message, context });
  // Decide: rethrow, return default, or continue
}
```

---

## Troubleshooting

### Common Issues

#### Playlist Not Ready
- **Symptom**: `/playlist.m3u8` returns 503 error
- **Cause**: Rebuild in progress or failed
- **Solution**: Check logs, trigger manual rebuild, verify scraper is working

#### Streams Not Playing
- **Symptom**: Channels listed but streams fail to load
- **Cause**: Restream jobs failing, FFmpeg missing, or embed URLs expired
- **Solution**:
  - Check FFmpeg: `which ffmpeg`
  - Check Playwright: `npx playwright install`
  - Review restream logs for specific errors
  - Test embed URL manually in browser

#### Cloudflare Challenges Blocking Scraper
- **Symptom**: Scraper fails with Cloudflare challenge page
- **Cause**: No solver configured or solver failing
- **Solution**:
  - Set `SOLVER_ENDPOINT_URL` to Flaresolverr/Byparr instance
  - Verify solver is reachable: `curl $SOLVER_ENDPOINT_URL`
  - Check solver logs for errors

#### Memory/CPU High Usage
- **Symptom**: Server unresponsive or slow
- **Cause**: Too many concurrent restream jobs or browser contexts
- **Solution**:
  - Reduce `HYDRATION_CONCURRENCY`
  - Increase rebuild interval
  - Monitor with `docker stats` or `htop`
  - Ensure restream jobs are properly cleaned up

#### Channels Expiring Too Quickly
- **Symptom**: Channels disappear before events end
- **Cause**: `lifetime` configuration too short
- **Solution**: Increase lifetime in config UI or `config.json`

### Debugging Strategies

1. **Enable verbose logging**: Check `logger.js` for log levels
2. **Inspect temp files**: `/tmp/restream-*` and `/tmp/transmux-*`
3. **Test components in isolation**: Use Node.js REPL to test functions
4. **Check process list**: `ps aux | grep node` to see restream workers
5. **Monitor network**: Use browser DevTools when testing embeds
6. **Review recent commits**: Recent changes may have introduced issues

### Getting Help

- **Check logs**: Both server logs and frontend logs panel
- **Review tests**: Test files often demonstrate correct usage
- **Read source**: Code is well-documented with comments
- **Test in isolation**: Create minimal reproduction case

---

## Key Files Reference

### Configuration Files

- **`config.json`** (runtime, gitignored): User configuration
- **`package.json`**: Dependencies and scripts
- **`Dockerfile`**: Container build instructions
- **`.gitignore`**: Ignored files (node_modules, config.json, temp files)

### Entry Points

- **`src/server.js`**: HTTP server and API
- **`src/restream.js`**: Worker process (spawned by restreamer)
- **`src/public/index.html`**: Frontend entry

### Critical Paths

- **Channel Build**: `server.js` → `scraper.js` → `channelManager.js`
- **Hydration**: `channelManager.js` → `restreamer.js` → `restream.js`
- **Playlist Serving**: `server.js` → `channelManager.js` → client
- **Stream Serving**: `server.js` → `channelManager.js` → HLS proxy/transmux/restream

---

## Notes for AI Assistants

### When Making Changes

1. **Read before modifying**: Always read files before editing
2. **Understand context**: Review related files to understand dependencies
3. **Test thoroughly**: Run relevant tests after changes
4. **Update documentation**: Keep README.md and CLAUDE.md in sync
5. **Follow conventions**: Match existing code style and patterns
6. **Log appropriately**: Use structured logging with metadata
7. **Handle errors**: Never swallow exceptions silently
8. **Commit properly**: Use imperative mood, component-focused messages

### When Adding Features

1. **Check existing patterns**: Reuse established patterns
2. **Consider configuration**: Make behavior configurable when appropriate
3. **Add tests**: Unit tests for logic, integration tests for workflows
4. **Update documentation**: README for users, CLAUDE.md for developers
5. **Think about deployment**: Docker, environment variables, dependencies

### When Debugging

1. **Reproduce reliably**: Ensure you can trigger the issue consistently
2. **Check logs first**: Most issues are visible in logs
3. **Test hypotheses**: Make one change at a time
4. **Verify fix**: Add test case to prevent regression
5. **Document solution**: Update troubleshooting section if novel

### Red Flags to Avoid

- Changing ID generation logic (breaks channel stability)
- Removing error logging (makes debugging impossible)
- Hardcoding values that should be configurable
- Skipping tests for "simple" changes
- Committing `config.json` (contains user settings)
- Breaking backward compatibility without migration path

---

## Version Information

**Last Updated**: 2026-01-05
**Node.js Version**: 20+ recommended
**Playwright Version**: 1.57.0
**Express Version**: 5.1.0

---

## Additional Resources

- **README.md**: User-facing documentation
- **GitHub Issues**: Bug reports and feature requests
- **Docker Hub**: Container images (if published)
- **Playwright Docs**: https://playwright.dev
- **FFmpeg Docs**: https://ffmpeg.org/documentation.html

---

*This document is maintained for AI assistants working on the Redcarrd codebase. Keep it updated as the project evolves.*
