'use strict';

// Helper configuration: defaults < config file < environment.
//   Windows: %APPDATA%\PocketMonitor\config.json
//   others : $XDG_CONFIG_HOME or ~/.config, then open-tethery/config.json
// File keys: port, ingestPort, lanIp, allowControl, viewerDir.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = { port: 47825, ingestPort: 47826, lanIp: null, allowControl: true, viewerDir: null };
const PHOTOSHOP_PORT = 47823;

function configDir(env = process.env) {
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PocketMonitor');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'open-tethery');
}

function validPort(n) {
  return Number.isInteger(n) && n >= 0 && n <= 65535;
}

function loadConfig({ env = process.env, configPath, mode } = {}) {
  const resolvedMode = mode || env.OPEN_TETHERY_MODE || 'video';
  const isPs = resolvedMode === 'photoshop';
  const file = configPath || path.join(configDir(env), isPs ? 'photoshop-config.json' : 'config.json');
  const cfg = {
    ...DEFAULTS,
    mode: isPs ? 'photoshop' : 'video',
    port: isPs ? PHOTOSHOP_PORT : DEFAULTS.port,
    ingestPort: isPs ? null : DEFAULTS.ingestPort,
    logFileName: isPs ? 'photoshop-helper.log' : 'helper.log',
    configPath: file,
    dir: path.dirname(file),
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (validPort(parsed.port)) cfg.port = parsed.port;
      if (!isPs && validPort(parsed.ingestPort)) cfg.ingestPort = parsed.ingestPort;
      if (typeof parsed.lanIp === 'string' && parsed.lanIp) cfg.lanIp = parsed.lanIp;
      if (typeof parsed.allowControl === 'boolean') cfg.allowControl = parsed.allowControl;
      if (typeof parsed.viewerDir === 'string' && parsed.viewerDir) cfg.viewerDir = parsed.viewerDir;
    }
  } catch {
    // missing or unreadable file: defaults
  }
  const envPort = Number(env.OPEN_TETHERY_PORT);
  if (env.OPEN_TETHERY_PORT && validPort(envPort)) cfg.port = envPort;
  if (env.OPEN_TETHERY_LAN_IP) cfg.lanIp = env.OPEN_TETHERY_LAN_IP;
  if (env.OT_VIEWER_DIR) cfg.viewerDir = env.OT_VIEWER_DIR;
  return cfg;
}

// Merges one key into the config file (keeps unknown keys). Returns false on failure.
function saveConfigKey(file, key, value) {
  let obj = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') obj = parsed;
  } catch {
    // no file yet
  }
  if (value === null || value === undefined) delete obj[key];
  else obj[key] = value;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

module.exports = { saveConfigKey, loadConfig, configDir, DEFAULTS };
