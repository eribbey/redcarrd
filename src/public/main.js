const state = {
  channels: [],
  logs: [],
  config: {},
  logsPaused: false,
  pendingLogs: 0,
  playlistReady: false,
  hydrating: false,
};

const logKeys = new Set();
let logStream = null;
const previewPlayers = new WeakMap();

async function fetchState() {
  const res = await fetch('/api/state');
  const data = await res.json();
  state.channels = data.channels;
  state.config = data.config;
  state.playlistReady = data.playlistReady;
  state.hydrating = data.hydrating;
  renderConfig();
  renderChannels();
  syncLogs(data.logs);
  renderPlaylistStatus();
}

function renderConfig() {
  document.getElementById('categories').value = (state.config.categories || []).join(',');
  document.getElementById('interval').value = state.config.rebuildIntervalMinutes || '';
  document.getElementById('lifetime').value = state.config.lifetimeHours || '';
}

function renderChannels() {
  const container = document.getElementById('channels');
  container.innerHTML = '';
  if (!state.channels.length) {
    container.innerHTML = '<p class="muted">No channels built yet. Use rebuild to fetch from ntvstream.cx.</p>';
    return;
  }

  const template = document.getElementById('channelTemplate');

  state.channels.forEach((channel) => {
    const node = template.content.cloneNode(true);
    node.querySelector('.channel-title').textContent = `${channel.category} ${channel.id.split('-').pop()}`;
    node.querySelector('.channel-meta').textContent = channel.title;

    const sourceSelect = node.querySelector('.source');
    const qualitySelect = node.querySelector('.quality');
    const previewLink = node.querySelector('.preview-link');
    const previewPlayer = node.querySelector('.preview-player');

    fillSelect(sourceSelect, channel.sourceOptions, channel.embedUrl);
    fillSelect(qualitySelect, channel.qualityOptions, channel.embedUrl);

    sourceSelect.addEventListener('change', async (e) => {
      await fetch(`/api/channel/${channel.id}/source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embedUrl: e.target.value }),
      });
      await fetchState();
    });

    qualitySelect.addEventListener('change', async (e) => {
      await fetch(`/api/channel/${channel.id}/quality`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embedUrl: e.target.value }),
      });
      await fetchState();
    });

    const streamPath = channel.streamUrl ? `/hls/${encodeURIComponent(channel.id)}` : null;
    if (streamPath) {
      previewLink.disabled = false;
      previewLink.textContent = 'Preview stream';
      previewPlayer?.classList.add('hidden');
      previewLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (previewPlayer.classList.contains('hidden')) {
          loadPreview(previewPlayer, streamPath);
          previewPlayer.classList.remove('hidden');
          previewLink.textContent = 'Hide preview';
        } else {
          destroyPreviewPlayer(previewPlayer);
          previewPlayer.classList.add('hidden');
          previewLink.textContent = 'Preview stream';
        }
      });
    } else {
      previewLink.disabled = false;
      previewLink.textContent = 'Open embed';
      previewPlayer?.classList.add('hidden');
      previewLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.open(channel.embedUrl, '_blank', 'noopener');
      });
    }

    container.appendChild(node);
  });
}

function renderPlaylistStatus() {
  const statusEl = document.getElementById('playlistStatus');
  const playlistBtn = document.getElementById('playlistBtn');
  if (!statusEl || !playlistBtn) return;

  if (state.hydrating) {
    statusEl.textContent = 'Resolving streams before building playlist...';
    playlistBtn.disabled = true;
    return;
  }

  if (state.playlistReady) {
    statusEl.textContent = 'playlist.m3u8 is ready to download.';
    playlistBtn.disabled = false;
  } else {
    statusEl.textContent = 'Waiting for streams to resolve before playlist is available.';
    playlistBtn.disabled = true;
  }
}

function fillSelect(select, options, current) {
  select.innerHTML = '';
  if (!options?.length) {
    const opt = document.createElement('option');
    opt.textContent = 'Not available';
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

function renderLogs() {
  if (state.logsPaused) return;
  const logs = state.logs
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

function updateLogStatus() {
  const statusEl = document.getElementById('logStatus');
  const toggleBtn = document.getElementById('toggleLogs');
  if (!statusEl || !toggleBtn) return;

  if (state.logsPaused) {
    const queued = state.pendingLogs;
    statusEl.textContent = queued ? `Paused (${queued} new entries queued)` : 'Paused';
    toggleBtn.textContent = 'Resume logs';
  } else {
    statusEl.textContent = 'Live';
    toggleBtn.textContent = 'Pause logs';
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

async function saveConfig(evt) {
  evt.preventDefault();
  const categories = document
    .getElementById('categories')
    .value.split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const rebuildIntervalMinutes = Number(document.getElementById('interval').value);
  const lifetimeHours = Number(document.getElementById('lifetime').value);

  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ categories, rebuildIntervalMinutes, lifetimeHours }),
  });
  await fetchState();
}

async function rebuild() {
  const button = document.getElementById('rebuildBtn');
  button.disabled = true;
  button.textContent = 'Rebuilding...';
  await fetch('/api/rebuild', { method: 'POST' });
  await fetchState();
  button.textContent = 'Rebuild now';
  button.disabled = false;
}

document.getElementById('configForm').addEventListener('submit', saveConfig);
document.getElementById('rebuildBtn').addEventListener('click', rebuild);
document.getElementById('playlistBtn').addEventListener('click', () => {
  window.open('/playlist.m3u8', '_blank', 'noopener');
});
document.getElementById('epgBtn').addEventListener('click', () => {
  window.open('/epg.xml', '_blank', 'noopener');
});
document.getElementById('toggleLogs').addEventListener('click', toggleLogs);

fetchState();
startLogStream();
updateLogStatus();
setInterval(fetchState, 15000);
