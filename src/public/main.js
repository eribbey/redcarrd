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
