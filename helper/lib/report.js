'use strict';

// "Send report": writes a diagnostics zip to a local folder. Nothing is uploaded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createZip } = require('./zip');

function reportsDir(env = process.env) {
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenTethery', 'reports');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'open-tethery', 'reports');
}

const FIREWALL_HINT = [
  'Phones cannot open the page? Windows Firewall may block inbound TCP 47825.',
  'Allow "Open Tethery" on Private networks, or run in an admin PowerShell:',
  '  netsh advfirewall firewall add rule name="Open Tethery" dir=in action=allow protocol=TCP localport=47825 profile=private',
  'Also check the PC network is set to Private, and that "client isolation" is off on the router / hotspot.',
].join('\n');

// Removes the session code (a join secret) from any text.
function redact(text, code) {
  return code ? String(text).split(code).join('****') : String(text);
}

// o: { code, log[], cfg, session, interfaces, recentStates, viewers, version, now }
function buildReport(o) {
  const code = o.code;
  const json = (v) => `${redact(JSON.stringify(v, null, 2), code)}\n`;
  const when = o.now || new Date();
  const iface = {};
  for (const [name, list] of Object.entries(o.interfaces || {})) {
    iface[name] = (list || []).map((i) => ({ address: i.address, family: i.family, internal: i.internal, netmask: i.netmask }));
  }
  const system = {
    helper: o.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    uptimeSec: Math.round(process.uptime()),
    time: when.toISOString(),
  };
  return createZip(
    [
      { name: 'helper-log.txt', data: `${redact(o.log.join('\n'), code)}\n` },
      { name: 'config.json', data: json(o.cfg) },
      { name: 'session.json', data: json(o.session) },
      { name: 'interfaces.json', data: json(iface) },
      { name: 'system.json', data: json(system) },
      { name: 'state-messages.json', data: json(o.recentStates || []) },
      { name: 'viewers.json', data: json(o.viewers || []) },
      { name: 'firewall-hint.txt', data: `${FIREWALL_HINT}\n` },
    ],
    when,
  );
}

function writeReport(o) {
  const when = o.now || new Date();
  const stamp = when.toISOString().replace(/:/g, '-').replace(/\..+$/, '');
  fs.mkdirSync(o.dir, { recursive: true });
  const file = path.join(o.dir, `open-tethery-report-${stamp}.zip`);
  fs.writeFileSync(file, buildReport({ ...o, now: when }));
  return file;
}

module.exports = { reportsDir, buildReport, writeReport, redact, FIREWALL_HINT };
