const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const defaultConfig = {
  categories: [],
  rebuildIntervalMinutes: 60,
  lifetimeHours: 24,
  timezone: 'UTC',
};

function loadConfig(logger) {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return { ...defaultConfig, ...JSON.parse(raw) };
    }
  } catch (error) {
    logger?.warn('Failed to load config, using defaults', { error: error.message });
  }
  return { ...defaultConfig };
}

function saveConfig(config, logger) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (error) {
    logger?.error('Failed to save config', { error: error.message });
  }
}

module.exports = { loadConfig, saveConfig, defaultConfig, CONFIG_PATH };
