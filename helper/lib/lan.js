'use strict';

// LAN address discovery. Every non-internal IPv4 address is a candidate; the
// likely "phone can reach this" one is ranked first.

const os = require('os');

const VIRTUAL_NAME = /(vethernet|virtualbox|vmware|vmnet|docker|wsl|hyper-v|loopback|vbox|bridge|utun|tun\d)/i;

const LABELS = { wifi: 'Wi-Fi', ethernet: 'Ethernet', hotspot: 'Phone hotspot', usb: 'USB cable', tailscale: 'Tailscale', vpn: 'VPN', other: 'Other network' };

const USB_NAME = /(rndis|remote ndis|apple mobile device|iphone|android|usb\s*(ethernet|tether|lan)|ipheth)/i;
const WIFI_NAME = /(wi-?fi|wlan|wireless|^wl[a-z0-9]+|^ath\d|airport)/i;
const WIRED_NAME = /(ethernet|^eth\d|^en\d|^enp|^eno|^ens|local area connection(?!\*)|^lan\b)/i;
const VPN_NAME = /(vpn|wireguard|^wg\d|openvpn|^tap\b|tap-windows|zerotier|nord|proton|cisco|anyconnect|fortinet|ppp|^tun\d|^utun|hamachi|globalprotect)/i;
const HOTSPOT_SUBNETS = [/^192\.168\.137\./, /^192\.168\.42\./, /^172\.20\.10\./];

// Kind of one interface, from its OS name and IPv4 address. Heuristics only:
//  - Windows Mobile Hotspot (192.168.137.x) is always "hotspot".
//  - Phone tethering subnets (192.168.42.x Android, 172.20.10.x iPhone): "usb" when the
//    adapter looks wired / RNDIS (cable), else "hotspot" (PC joined the phone's Wi-Fi).
function classifyInterface(name, ip) {
  const n = name || '';
  const [a, b] = String(ip).split('.').map(Number);
  if ((a === 100 && b >= 64 && b <= 127) || /tailscale/i.test(n)) return 'tailscale';
  if (/^192\.168\.137\./.test(ip)) return 'hotspot';
  if (USB_NAME.test(n)) return 'usb';
  if (HOTSPOT_SUBNETS.some((re) => re.test(ip))) return WIRED_NAME.test(n) && !WIFI_NAME.test(n) ? 'usb' : 'hotspot';
  if (VIRTUAL_NAME.test(n)) return 'other';
  if (VPN_NAME.test(n)) return 'vpn';
  if (/local area connection\*/i.test(n) || /virtual adapter/i.test(n)) return 'other';
  if (WIFI_NAME.test(n)) return 'wifi';
  if (WIRED_NAME.test(n)) return 'ethernet';
  return 'other';
}

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
  if (ifaceName && classifyInterface(ifaceName, ip) === 'hotspot') score -= 15; // prefer the normal LAN
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

// Every IPv4 interface as a "way to connect" the panel can offer. `recommended` marks the
// automatic best pick (ignores the user's override).
function connectionList({ interfaces = os.networkInterfaces(), port, code } = {}) {
  const found = lanAddresses({ interfaces });
  return found.map((a, i) => {
    const kind = classifyInterface(a.name, a.ip);
    return { kind, label: LABELS[kind], name: a.name, ip: a.ip, url: `http://${a.ip}:${port}/c/${code}`, recommended: i === 0 };
  });
}

function sessionUrls(addresses, port, code) {
  const urls = addresses.map((a) => `http://${a.ip}:${port}/c/${code}`);
  const primaryUrl = urls[0] || `http://127.0.0.1:${port}/c/${code}`;
  return { urls, primaryUrl };
}

module.exports = { lanAddresses, sessionUrls, rankAddress, classifyInterface, connectionList, LABELS };
