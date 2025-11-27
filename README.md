# redcarrd

Self-hosted IPTV proxy that scrapes events  and exposes dynamic playlists and EPG data. The app runs on port 3005 by default and includes a configuration UI for selecting categories, tuning rebuild cadence, previewing streams, and inspecting logs.

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
