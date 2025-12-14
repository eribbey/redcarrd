# redcarrd

**Work-in-progress to replace dlhd-proxy for sports**

Self-hosted IPTV proxy that scrapes events and exposes dynamic playlists and EPG data. The app runs on port 3005 by default and includes a configuration UI for selecting categories, tuning rebuild cadence, previewing streams, and inspecting logs.

## Features
- Scrape for events and build category-based channels with sequential numbering.
- Resolve stream URLs from embed iframes and keep them refreshed on a schedule.
- Generate `playlist.m3u8` and `epg.xml` endpoints for IPTV clients.
- Web UI for configuring categories, rebuild interval, and lifetime plus manual rebuild trigger.
- Optional source and quality selection per channel with preview links.
- Logging panel and JSON configuration persisted to `config.json`.

## Running locally
```bash
npm install
npm start
```

The server listens on `http://localhost:3005`.

## Tests
```bash
npm test
```

## Docker
Build and run with Docker:
```bash
docker build -t redcarrd .
docker run -p 3005:3005 redcarrd
```

Or with Docker Compose:
```bash
docker-compose up --build
```

### Using an existing Flaresolverr/Byparr solver
Set `SOLVER_ENDPOINT_URL` (or `SOLVER_URL`) to point at a reachable solver instance. For example, if you already run Flaresolverr in Docker Compose, you can reuse it by adding the environment variable to this service:

```yaml
environment:
  - SOLVER_ENDPOINT_URL=http://flaresolverr:8191/v1
```

This lets the app call the solver to obtain challenge-bypassed cookies before Playwright launches pages.
