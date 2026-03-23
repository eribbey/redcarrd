# Web UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-page stacked layout with a tabbed UI (Channels/Settings/Logs), clean up channel cards, and add copyable playlist/EPG URLs.

**Architecture:** Pure frontend changes to 3 static files (HTML, CSS, JS). No backend changes. Tab switching via show/hide divs with URL hash routing. Copy-to-clipboard via `navigator.clipboard.writeText()`.

**Tech Stack:** Vanilla HTML/CSS/JS, HLS.js (CDN)

**Spec:** `docs/superpowers/specs/2026-03-22-web-ui-redesign.md`

---

## File Structure

### Modified Files
| File | Changes |
|------|---------|
| `src/public/index.html` | Restructure into tab containers, add tab bar, add URL copy inputs to Settings, restructure channel template |
| `src/public/styles.css` | Add tab styles, update channel card layout, full-height logs, copy-to-clipboard input styles |
| `src/public/main.js` | Add tab switching with hash routing, add copy-to-clipboard, update `renderChannels` for new card layout, update `renderPlaylistStatus` for Settings tab |

---

## Task 1: Restructure HTML into tabbed layout

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: Replace the current HTML body structure with tabbed layout**

Replace the entire `<body>` content of `index.html` with:

```html
<body>
  <div class="page">
    <header>
      <h1>Redcarrd</h1>
      <nav class="tabs" role="tablist">
        <button class="tab active" data-tab="channels" role="tab" aria-selected="true">Channels</button>
        <button class="tab" data-tab="settings" role="tab" aria-selected="false">Settings</button>
        <button class="tab" data-tab="logs" role="tab" aria-selected="false">Logs</button>
      </nav>
    </header>

    <div id="errorBanner" class="toast hidden" role="status" aria-live="polite"></div>

    <main>
      <!-- Channels Tab -->
      <section id="tab-channels" class="tab-content active">
        <p id="playlistStatus" class="muted"></p>
        <div id="channels" class="channel-grid"></div>
      </section>

      <!-- Settings Tab -->
      <section id="tab-settings" class="tab-content hidden">
        <div class="card">
          <h2>Playlist & EPG URLs</h2>
          <p class="muted">Copy these into your IPTV client</p>
          <div class="url-group">
            <label>
              Playlist URL
              <div class="copy-row">
                <input id="playlistUrl" type="text" readonly />
                <button id="copyPlaylist" class="secondary copy-btn" type="button">Copy</button>
              </div>
            </label>
            <label>
              EPG URL
              <div class="copy-row">
                <input id="epgUrl" type="text" readonly />
                <button id="copyEpg" class="secondary copy-btn" type="button">Copy</button>
              </div>
            </label>
          </div>
          <p id="settingsPlaylistStatus" class="muted"></p>
        </div>

        <div class="card">
          <h2>Configuration</h2>
          <p class="muted">Select categories and refresh cadence</p>
          <form id="configForm" class="config-grid">
            <label>
              Categories
              <input id="categories" type="text" placeholder="football,basketball" />
              <small>Comma-separated list. Leave empty to include everything.</small>
            </label>
            <label>
              Rebuild interval (minutes)
              <input id="interval" type="number" min="5" step="5" />
            </label>
            <label>
              Lifetime (hours)
              <input id="lifetime" type="number" min="1" step="1" />
            </label>
            <div class="button-row">
              <button type="submit" class="secondary">Save configuration</button>
              <button id="rebuildBtn" class="primary" type="button">Rebuild now</button>
            </div>
          </form>
        </div>
      </section>

      <!-- Logs Tab -->
      <section id="tab-logs" class="tab-content hidden">
        <div class="log-header">
          <div class="log-status-text">
            <span id="logStatus">Live</span>
          </div>
          <div class="log-actions">
            <label class="inline-label">
              Level
              <select id="logLevelFilter">
                <option value="all">All</option>
                <option value="debug">Debug & above</option>
                <option value="info">Info & above</option>
                <option value="warn">Warnings & errors</option>
                <option value="error">Errors only</option>
              </select>
            </label>
            <button id="toggleLogs" class="secondary" type="button">Pause logs</button>
          </div>
        </div>
        <pre id="logs" class="logs"></pre>
      </section>
    </main>
  </div>

  <template id="channelTemplate">
    <div class="channel-card">
      <div class="channel-header">
        <div class="channel-title"></div>
        <select class="source"></select>
      </div>
      <div class="muted channel-meta"></div>
      <div class="preview">
        <video class="preview-player hidden" controls muted playsinline></video>
        <div class="preview-actions">
          <button class="preview-link text-link" type="button">Preview</button>
        </div>
      </div>
    </div>
  </template>

  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
  <script src="/main.js"></script>
</body>
```

- [ ] **Step 2: Verify the page loads in a browser**

Open `http://localhost:3005` — the page will look broken (no tab styles yet, JS errors from missing handlers). That's expected. Confirm the HTML structure renders.

- [ ] **Step 3: Commit**

```bash
git add src/public/index.html
git commit -m "Restructure HTML into tabbed layout with channels/settings/logs"
```

---

## Task 2: Add CSS for tabs, updated cards, and full-height logs

**Files:**
- Modify: `src/public/styles.css`

- [ ] **Step 1: Replace the entire stylesheet**

Replace `src/public/styles.css` with:

```css
:root {
  --bg: #0f172a;
  --panel: #111827;
  --muted: #9ca3af;
  --text: #f8fafc;
  --primary: #3b82f6;
  --border: #1f2937;
  --input-bg: #0b1220;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
}

.page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px clamp(16px, 4vw, 32px);
}

.hidden {
  display: none !important;
}

/* Header & Tabs */
header {
  margin-bottom: 20px;
}

h1 {
  margin: 0 0 12px 0;
  font-size: 24px;
}

h2 {
  margin: 0 0 4px 0;
  font-size: 18px;
}

.tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
}

.tab {
  padding: 10px 20px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.tab:hover {
  color: var(--text);
}

.tab.active {
  color: var(--text);
  border-bottom-color: var(--primary);
}

/* Tab Content */
.tab-content {
  padding-top: 16px;
}

/* Toast / Error Banner */
.toast {
  background: rgba(248, 113, 113, 0.15);
  border: 1px solid rgba(248, 113, 113, 0.5);
  color: #fecdd3;
  padding: 12px 14px;
  border-radius: 10px;
  margin-bottom: 16px;
}

/* Cards */
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
  margin-bottom: 16px;
}

/* Config Form */
.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin-top: 12px;
}

.button-row {
  display: flex;
  gap: 10px;
  align-items: end;
}

/* URL Copy Section */
.url-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.copy-row {
  display: flex;
  gap: 8px;
}

.copy-row input {
  flex: 1;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
}

.copy-btn {
  white-space: nowrap;
  min-width: 60px;
}

/* Form Elements */
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-weight: 600;
}

input, select, button {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--input-bg);
  color: var(--text);
  font-size: 14px;
}

button.primary {
  background: linear-gradient(135deg, #3b82f6, #6366f1);
  color: white;
  border: none;
  cursor: pointer;
  padding: 12px 16px;
}

button.secondary {
  background: transparent;
  border: 1px solid var(--border);
  cursor: pointer;
}

button:hover {
  opacity: 0.9;
}

.muted {
  color: var(--muted);
  font-size: 14px;
}

small {
  color: var(--muted);
}

/* Channel Grid */
.channel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}

.channel-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  background: var(--input-bg);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.channel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.channel-header select {
  max-width: 180px;
  font-size: 13px;
  padding: 6px 8px;
}

.channel-title {
  font-size: 15px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-meta {
  font-size: 13px;
}

/* Preview */
.preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preview-player {
  width: 100%;
  max-height: 220px;
  border-radius: 6px;
  background: #000;
}

.preview-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.text-link {
  background: none;
  border: none;
  color: var(--primary);
  cursor: pointer;
  font-size: 13px;
  padding: 4px 0;
}

.text-link:hover {
  text-decoration: underline;
}

/* Logs */
.log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.log-status-text {
  font-weight: 600;
  font-size: 14px;
}

.log-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.inline-label {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.logs {
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  height: calc(100vh - 200px);
  min-height: 300px;
  overflow: auto;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
  color: #e5e7eb;
}
```

- [ ] **Step 2: Verify tabs look correct visually**

Open `http://localhost:3005` — the tab bar should render with "Channels" underlined. Content sections won't switch yet (JS not updated). Cards and logs should look styled.

- [ ] **Step 3: Commit**

```bash
git add src/public/styles.css
git commit -m "Restyle UI with tab navigation, tighter channel cards, full-height logs"
```

---

## Task 3: Update JavaScript for tab switching, copy URLs, and new card layout

**Files:**
- Modify: `src/public/main.js`

- [ ] **Step 1: Replace the entire main.js**

Replace `src/public/main.js` with the updated code. Key changes from the current version:
- Add `initTabs()` for tab switching with hash routing
- Add `initCopyButtons()` for clipboard copy
- Add `renderUrls()` to populate playlist/EPG URL inputs
- Update `renderChannels()` for new card template (title + select on same row, text links)
- Update `renderPlaylistStatus()` to also update the Settings tab status
- Move rebuild button handler (same logic, new location)
- Remove playlist/EPG download button handlers (replaced by copy URLs)

```javascript
const state = {
  channels: [],
  logs: [],
  config: {},
  logsPaused: false,
  pendingLogs: 0,
  playlistReady: false,
  hydrating: false,
  logLevelFilter: 'all',
};

const logKeys = new Set();
let logStream = null;
const previewPlayers = new WeakMap();
const logLevelRank = { debug: 0, info: 1, warn: 2, error: 3 };

// --- Tab Navigation ---

function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Restore tab from URL hash
  const hash = window.location.hash.replace('#', '') || 'channels';
  switchTab(hash);

  window.addEventListener('hashchange', () => {
    const h = window.location.hash.replace('#', '') || 'channels';
    switchTab(h);
  });
}

function switchTab(tabName) {
  const validTabs = ['channels', 'settings', 'logs'];
  if (!validTabs.includes(tabName)) tabName = 'channels';

  // Update tab buttons
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tabName);
    t.setAttribute('aria-selected', t.dataset.tab === tabName);
  });

  // Show/hide content
  document.querySelectorAll('.tab-content').forEach((c) => {
    c.classList.toggle('hidden', c.id !== `tab-${tabName}`);
    c.classList.toggle('active', c.id === `tab-${tabName}`);
  });

  // Update hash without triggering scroll
  if (window.location.hash !== `#${tabName}`) {
    history.replaceState(null, '', `#${tabName}`);
  }
}

// --- Error Banner ---

function showError(message) {
  const banner = document.getElementById('errorBanner');
  if (!banner) return;
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function clearError() {
  const banner = document.getElementById('errorBanner');
  if (!banner) return;
  banner.textContent = '';
  banner.classList.add('hidden');
}

// --- Copy to Clipboard ---

function initCopyButtons() {
  document.getElementById('copyPlaylist').addEventListener('click', () => {
    copyToClipboard('playlistUrl', 'copyPlaylist');
  });
  document.getElementById('copyEpg').addEventListener('click', () => {
    copyToClipboard('epgUrl', 'copyEpg');
  });
}

function copyToClipboard(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input) return;

  navigator.clipboard.writeText(input.value).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => {
    // Fallback: select the input text
    input.select();
  });
}

function renderUrls() {
  const origin = window.location.origin;
  const playlistInput = document.getElementById('playlistUrl');
  const epgInput = document.getElementById('epgUrl');
  if (playlistInput) playlistInput.value = `${origin}/playlist.m3u8`;
  if (epgInput) epgInput.value = `${origin}/epg.xml`;
}

// --- State & Config ---

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('Failed to fetch state');
    const data = await res.json();
    state.channels = data.channels;
    state.config = data.config;
    state.playlistReady = data.playlistReady;
    state.hydrating = data.hydrating;
    renderConfig();
    renderChannels();
    syncLogs(data.logs);
    renderPlaylistStatus();
    clearError();
  } catch (error) {
    console.error('Unable to fetch state', error);
    showError('Unable to load the latest state. Please try again.');
  }
}

function renderConfig() {
  document.getElementById('categories').value = (state.config.categories || []).join(',');
  document.getElementById('interval').value = state.config.rebuildIntervalMinutes || '';
  document.getElementById('lifetime').value = state.config.lifetimeHours || '';
}

// --- Channels ---

function renderChannels() {
  const container = document.getElementById('channels');
  container.innerHTML = '';
  if (!state.channels.length) {
    container.innerHTML = '<p class="muted">No channels built yet. Hit Rebuild in Settings to fetch from streamed.pk.</p>';
    return;
  }

  const template = document.getElementById('channelTemplate');

  state.channels.forEach((channel) => {
    const node = template.content.cloneNode(true);
    node.querySelector('.channel-title').textContent = `${channel.category} ${channel.id.split('-').pop()}`;
    node.querySelector('.channel-meta').textContent = channel.title;

    const sourceSelect = node.querySelector('.source');
    const previewLink = node.querySelector('.preview-link');
    const previewPlayer = node.querySelector('.preview-player');
    const previewActions = node.querySelector('.preview-actions');

    fillSelect(sourceSelect, channel.sourceOptions, channel.embedUrl);
    sourceSelect.dataset.currentValue = channel.embedUrl;

    sourceSelect.addEventListener('change', async (e) => {
      const select = e.target;
      const previousValue = select.dataset.currentValue || select.value;
      select.disabled = true;
      try {
        const res = await fetch(`/api/channel/${channel.id}/source`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ embedUrl: select.value }),
        });
        if (!res.ok) throw new Error('Failed to update source');
        await fetchState();
        select.dataset.currentValue = select.value;
        clearError();
      } catch (error) {
        console.error('Failed to update channel source', error);
        showError('Unable to update channel source. Please try again.');
        select.value = previousValue;
      } finally {
        select.disabled = false;
      }
    });

    const streamPath = `/hls/${encodeURIComponent(channel.id)}`;
    previewLink.textContent = 'Preview';
    previewPlayer?.classList.add('hidden');

    previewLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (previewPlayer.classList.contains('hidden')) {
        loadPreview(previewPlayer, streamPath);
        previewPlayer.classList.remove('hidden');
        previewLink.textContent = 'Hide';
      } else {
        destroyPreviewPlayer(previewPlayer);
        previewPlayer.classList.add('hidden');
        previewLink.textContent = 'Preview';
      }
    });

    if (channel.embedUrl) {
      const embedLink = document.createElement('button');
      embedLink.type = 'button';
      embedLink.className = 'text-link';
      embedLink.textContent = 'Embed';
      embedLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.open(channel.embedUrl, '_blank', 'noopener');
      });
      previewActions?.appendChild(embedLink);
    }

    container.appendChild(node);
  });
}

function renderPlaylistStatus() {
  const statusEl = document.getElementById('playlistStatus');
  const settingsStatusEl = document.getElementById('settingsPlaylistStatus');

  let statusText;
  if (state.hydrating) {
    statusText = 'Resolving streams...';
  } else if (state.playlistReady) {
    statusText = `${state.channels.length} channels ready`;
  } else {
    statusText = 'Waiting for streams to resolve...';
  }

  if (statusEl) statusEl.textContent = statusText;
  if (settingsStatusEl) settingsStatusEl.textContent = state.playlistReady
    ? 'Playlist and EPG are ready.'
    : state.hydrating
      ? 'Resolving streams before playlist is available...'
      : 'Waiting for streams to resolve before playlist is available.';
}

function fillSelect(select, options, current) {
  select.innerHTML = '';
  if (!options?.length) {
    const opt = document.createElement('option');
    opt.textContent = 'N/A';
    opt.disabled = true;
    opt.selected = true;
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  options.forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.embedUrl;
    option.textContent = opt.label || opt.embedUrl;
    if (opt.embedUrl === current) option.selected = true;
    select.appendChild(option);
  });
}

// --- Preview Player ---

function destroyPreviewPlayer(videoEl) {
  const player = previewPlayers.get(videoEl);
  if (player?.hls) {
    player.hls.destroy();
  }
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
  }
}

function loadPreview(videoEl, url) {
  if (!videoEl || !url) return;

  destroyPreviewPlayer(videoEl);

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls();
    hls.loadSource(url);
    hls.attachMedia(videoEl);
    previewPlayers.set(videoEl, { hls });
  } else {
    videoEl.src = url;
    previewPlayers.set(videoEl, { hls: null });
  }

  videoEl.play()?.catch(() => {});
}

// --- Logs ---

function renderLogs() {
  if (state.logsPaused) return;
  const logs = state.logs
    .filter((l) => shouldDisplayLog(l))
    .map((l) => {
      const metaText = l.meta && Object.keys(l.meta || {}).length ? ` ${JSON.stringify(l.meta)}` : '';
      return `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}${metaText}`;
    })
    .join('\n');
  document.getElementById('logs').textContent = logs;
  state.pendingLogs = 0;
  updateLogStatus();
}

function getLogKey(entry) {
  return `${entry.timestamp}|${entry.level}|${entry.message}|${JSON.stringify(entry.meta || {})}`;
}

function addLogEntry(entry, { render = true } = {}) {
  if (!entry || !entry.timestamp || !entry.level || !entry.message) return;
  const key = getLogKey(entry);
  if (logKeys.has(key)) return;

  state.logs.unshift(entry);
  logKeys.add(key);

  if (state.logs.length > 500) {
    const removed = state.logs.pop();
    logKeys.delete(getLogKey(removed));
  }

  if (state.logsPaused) {
    state.pendingLogs += 1;
    updateLogStatus();
    return;
  }

  if (render) renderLogs();
}

function syncLogs(entries = []) {
  entries
    .slice()
    .reverse()
    .forEach((entry) => addLogEntry(entry, { render: false }));
  renderLogs();
}

function shouldDisplayLog(entry) {
  if (!entry) return false;
  if (state.logLevelFilter === 'all') return true;
  const entryRank = logLevelRank[entry.level] ?? Number.POSITIVE_INFINITY;
  const threshold = logLevelRank[state.logLevelFilter] ?? 0;
  return entryRank >= threshold;
}

function updateLogStatus() {
  const statusEl = document.getElementById('logStatus');
  const toggleBtn = document.getElementById('toggleLogs');
  if (!statusEl || !toggleBtn) return;

  if (state.logsPaused) {
    const queued = state.pendingLogs;
    statusEl.textContent = queued ? `Paused (${queued} queued)` : 'Paused';
    toggleBtn.textContent = 'Resume';
  } else {
    statusEl.textContent = 'Live';
    toggleBtn.textContent = 'Pause';
  }
}

function toggleLogs() {
  state.logsPaused = !state.logsPaused;
  if (!state.logsPaused) {
    renderLogs();
  } else {
    updateLogStatus();
  }
}

function startLogStream() {
  if (logStream) logStream.close();
  logStream = new EventSource('/api/logs/stream');
  logStream.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data);
      addLogEntry(entry);
    } catch (error) {
      console.error('Failed to parse log entry', error);
    }
  };

  logStream.onerror = () => {
    logStream.close();
    setTimeout(startLogStream, 3000);
  };
}

// --- Config Actions ---

async function saveConfig(evt) {
  evt.preventDefault();
  const submitBtn = evt.submitter || document.querySelector('#configForm button[type="submit"]');
  const originalText = submitBtn?.textContent;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';
  }
  const categories = document
    .getElementById('categories')
    .value.split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const rebuildIntervalMinutes = Number(document.getElementById('interval').value);
  const lifetimeHours = Number(document.getElementById('lifetime').value);

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories, rebuildIntervalMinutes, lifetimeHours }),
    });
    if (!res.ok) throw new Error('Failed to save configuration');
    await fetchState();
    clearError();
  } catch (error) {
    console.error('Failed to save configuration', error);
    showError('Unable to save configuration. Please try again.');
  } finally {
    if (submitBtn) {
      submitBtn.textContent = originalText || 'Save configuration';
      submitBtn.disabled = false;
    }
  }
}

async function rebuild() {
  const button = document.getElementById('rebuildBtn');
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Rebuilding...';
  }
  try {
    const res = await fetch('/api/rebuild', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to rebuild');
    await fetchState();
    clearError();
  } catch (error) {
    console.error('Failed to rebuild channels', error);
    showError('Rebuild failed. Please try again.');
  } finally {
    if (button) {
      button.textContent = originalText || 'Rebuild now';
      button.disabled = false;
    }
  }
}

// --- Init ---

document.getElementById('configForm').addEventListener('submit', saveConfig);
document.getElementById('rebuildBtn').addEventListener('click', rebuild);
document.getElementById('toggleLogs').addEventListener('click', toggleLogs);
document.getElementById('logLevelFilter').addEventListener('change', (event) => {
  state.logLevelFilter = event.target.value;
  renderLogs();
});

initTabs();
initCopyButtons();
renderUrls();
fetchState();
startLogStream();
updateLogStatus();
setInterval(fetchState, 15000);
```

- [ ] **Step 2: Verify the full UI works**

Open `http://localhost:3005` and test:
1. Tab switching works — clicking Channels/Settings/Logs shows correct content
2. URL hash updates and persists on refresh
3. Settings tab shows playlist/EPG URLs with copy buttons
4. Copy buttons work (click, see "Copied!" feedback)
5. Channel cards render with title + source on same row
6. Preview/Embed text links work
7. Config save and rebuild still work
8. Logs stream and filter correctly
9. Error banner shows on any tab

- [ ] **Step 3: Commit**

```bash
git add src/public/main.js
git commit -m "Add tab switching, copy-to-clipboard URLs, and updated channel card rendering"
```

---

## Task 4: Final verification and cleanup

- [ ] **Step 1: Full manual test pass**

Verify all functionality end-to-end:
- Load page → Channels tab active by default
- Channels show with tighter cards, source dropdown inline
- Switch to Settings → URLs are populated, copy works
- Save config → success
- Rebuild → channels update
- Switch to Logs → logs fill the viewport height, filter works
- Refresh page on each tab → correct tab restores via hash
- Error states (stop server, try rebuild → error banner shows)

- [ ] **Step 2: Commit all files together if any fixes needed**

```bash
git add src/public/
git commit -m "Fix issues found during UI verification"
```
