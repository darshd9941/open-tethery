'use strict';

// LAN address discovery. Every non-internal IPv4 address is a candidate; the
// likely "phone can reach this" one is ranked first.

const os = require('os');

const VIRTUAL_NAME = /(vethernet|virtualbox|vmware|vmnet|docker|wsl|hyper-v|loopback|vbox|bridge|utun|tun\d)/i;

function rankAddress(ip, ifaceName) {
  const [a, b] = ip.split('.').map(Number);
  let score;
  if (a === 192 && b === 168) score = 100;
  else if (a === 10) score = 90;
  else if (a === 172 && b >= 16 && b <= 31) score = 80;
  else if (a === 100 && b >= 64 && b <= 127) score = 60; // CGNAT, e.g. Tailscale
  else if (a === 169 && b === 254) score = 5; // link-local
  else score = 40;
  if (VIRTUAL_NAME.test(ifaceName || '')) score -= 50;
  return score;
}

// interfaces: os.networkInterfaces() shape (injectable for tests).
function lanAddresses({ lanIp, interfaces = os.networkInterfaces() } = {}) {
  const found = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const info of list || []) {
      const v4 = info.family === 'IPv4' || info.family === 4;
      if (!v4 || info.internal) continue;
      found.push({ ip: info.address, name, rank: rankAddress(info.address, name) });
    }
  }
  found.sort((x, y) => y.rank - x.rank || x.ip.localeCompare(y.ip));
  if (lanIp) {
    const rest = found.filter((f) => f.ip !== lanIp);
    return [{ ip: lanIp, name: 'override', rank: 1000 }, ...rest];
  }
  return found;
}

function sessionUrls(addresses, port, code) {
  const urls = addresses.map((a) => `http://${a.ip}:${port}/c/${code}`);
  const primaryUrl = urls[0] || `http://127.0.0.1:${port}/c/${code}`;
  return { urls, primaryUrl };
}

module.exports = { lanAddresses, sessionUrls, rankAddress };
