const state = {
  channels: [],
  logs: [],
  config: {},
};

const logKeys = new Set();
let logStream = null;

async function fetchState() {
  const res = await fetch('/api/state');
  const data = await res.json();
  state.channels = data.channels;
  state.config = data.config;
  renderConfig();
  renderChannels();
  syncLogs(data.logs);
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

    previewLink.href = channel.streamUrl || channel.embedUrl;
    previewLink.textContent = channel.streamUrl ? 'Preview stream' : 'Open embed';

    container.appendChild(node);
  });
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

function renderLogs() {
  const logs = state.logs
    .map((l) => {
      const metaText = l.meta && Object.keys(l.meta || {}).length ? ` ${JSON.stringify(l.meta)}` : '';
      return `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}${metaText}`;
    })
    .join('\n');
  document.getElementById('logs').textContent = logs;
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

  if (render) renderLogs();
}

function syncLogs(entries = []) {
  entries
    .slice()
    .reverse()
    .forEach((entry) => addLogEntry(entry, { render: false }));
  renderLogs();
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

fetchState();
startLogStream();
setInterval(fetchState, 15000);
