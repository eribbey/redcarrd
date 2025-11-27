const state = {
  channels: [],
  logs: [],
  config: {},
};

async function fetchState() {
  const res = await fetch('/api/state');
  const data = await res.json();
  state.channels = data.channels;
  state.logs = data.logs;
  state.config = data.config;
  renderConfig();
  renderChannels();
  renderLogs();
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
    .map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`)
    .join('\n');
  document.getElementById('logs').textContent = logs;
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

fetchState();
setInterval(fetchState, 15000);
