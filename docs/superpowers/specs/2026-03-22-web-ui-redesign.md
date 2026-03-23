# Web UI Redesign

## Problem

The current web interface is a single scrolling page with three stacked cards (Configuration, Channels, Logs). The channel cards have awkward spacing and visual hierarchy. Configuration and logs compete for attention with channels, which are the primary thing users interact with.

## Design

### Tab Structure

Replace the single-page layout with a tabbed SPA. Three tabs in a horizontal tab bar below the header:

- **Channels** (default, active on load)
- **Settings** (renamed from "Configuration")
- **Logs**

Tab switching is pure JS — show/hide content divs. URL hash updates (`#channels`, `#settings`, `#logs`) so refreshing preserves the active tab. On load, read the hash to restore the tab, defaulting to `#channels`.

The header simplifies to just "Redcarrd" and the tab bar. The subtitle moves to the Settings tab.

The error banner (`#errorBanner`) stays above the tab content area so it's visible on any tab.

### Channel Cards

Tighter, cleaner card layout:

- **Title and source dropdown on the same row** — title left-aligned, dropdown right-aligned. No "Source endpoint" label.
- **Meta text** (event title) on a second line, smaller/muted.
- **Preview and Embed as text links**, right-aligned, smaller visual weight than the current buttons.
- **Video player** hidden by default, toggles on "Preview" click. Same HLS.js behavior.
- **Tighter spacing** — 12px padding, smaller gaps between elements.
- **Grid min-width 260px** for denser packing.
- **Template restructure** — the `#channelTemplate` markup changes: remove the `<label>Source endpoint` wrapper, replace with a flex row containing the title and bare `<select>`.

### Settings Tab

Two sections, top to bottom:

**1. Playlist & EPG URLs**
- Two readonly text inputs showing the full URLs: `{origin}/playlist.m3u8` and `{origin}/epg.xml`
- Each has a copy-to-clipboard button
- URLs are derived from `window.location.origin`
- Playlist status text below (ready / hydrating / waiting)

**2. Configuration Form**
- Same fields: categories, rebuild interval, lifetime
- Same grid layout
- Save button and Rebuild button side by side at the bottom
- Rebuild button moves here from the Channels card header (it's a config action)

### Logs Tab

- Level filter and pause/resume controls in the tab header area
- Log panel fills available viewport height: `calc(100vh - header - tabs - controls)` instead of fixed 220px
- All existing SSE streaming, deduplication, and filtering logic unchanged

## Files Changed

| File | Changes |
|------|---------|
| `src/public/index.html` | Restructure into tab containers, add URL copy inputs, move rebuild button |
| `src/public/styles.css` | Add tab styles, update card layout, full-height logs |
| `src/public/main.js` | Add tab switching with hash routing, add copy-to-clipboard, update renderChannels for new card layout |

## What Stays the Same

- All backend API endpoints unchanged
- HLS.js preview player behavior unchanged
- SSE log streaming unchanged
- Source selection change handler unchanged
- Config save/load unchanged
- State polling (15s interval) unchanged
