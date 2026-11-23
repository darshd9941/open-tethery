// "Connection" list and report helpers (pure). Loads in CEP (window.OT.connections) and in Node tests.
(function (root, factory) {
  var api = factory();
  root.OT = root.OT || {};
  root.OT.connections = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  var HELP = {
    wifi: [
      'Phone and PC on the same Wi-Fi network.',
      'Scan the QR code with the phone camera.'
    ],
    ethernet: [
      'PC on a cable, phone on Wi-Fi of the same router.',
      'If the phone cannot open the page, check that the router does not isolate Wi-Fi clients.'
    ],
    hotspot: [
      'Turn on Mobile Hotspot in Windows Settings, join it from the phone, then scan.',
      'Or join your phone\'s own hotspot from this PC and scan.'
    ],
    usb: [
      'iPhone: turn on Personal Hotspot, plug in by cable, tap Trust.',
      'Android: turn on USB tethering in the phone\'s hotspot settings.',
      'Then scan. No Wi-Fi needed.'
    ],
    tailscale: [
      'Install Tailscale on the PC and the phone, signed in to the same account.',
      'Works from anywhere. Scan, or open the address on the phone.'
    ],
    vpn: [
      'A VPN adapter. Phones usually cannot reach it; pick Wi-Fi or Ethernet instead.'
    ],
    other: [
      'A virtual or unknown adapter. Use it only if the others do not work.'
    ]
  };

  function helpLines(kind) {
    return HELP[kind] || HELP.other;
  }

  function hostOf(url) {
    var m = /^https?:\/\/([^:\/]+)/.exec(url || '');
    return m ? m[1] : '';
  }

  // Dropdown rows: { value: ip, text: "Wi-Fi - 192.168.1.20 (recommended)", kind, url }
  function options(connections) {
    return (connections || []).map(function (c) {
      return {
        value: c.ip,
        text: c.label + ' - ' + c.ip + (c.recommended ? ' (best)' : ''),
        kind: c.kind,
        url: c.url
      };
    });
  }

  // The connection currently used for the QR: the one whose address is in primaryUrl.
  function selected(connections, primaryUrl) {
    var host = hostOf(primaryUrl);
    var list = connections || [];
    for (var i = 0; i < list.length; i++) if (list[i].ip === host) return list[i];
    return null;
  }

  // What to send in panel-settings for a chosen ip: null (automatic) for the recommended one.
  function choiceToSetting(connections, ip) {
    var list = connections || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].ip === ip) return list[i].recommended ? null : ip;
    }
    return undefined; // unknown: send nothing
  }

  // Command to show a file in the OS file manager. Returns { cmd, args } or null.
  function openFolderCommand(filePath, platform) {
    if (!filePath) return null;
    if (platform === 'win32') return { cmd: 'explorer.exe', args: ['/select,' + filePath] };
    if (platform === 'darwin') return { cmd: 'open', args: ['-R', filePath] };
    return null;
  }

  function dirOf(filePath) {
    var s = String(filePath || '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : s;
  }

  return {
    helpLines: helpLines,
    options: options,
    selected: selected,
    choiceToSetting: choiceToSetting,
    openFolderCommand: openFolderCommand,
    dirOf: dirOf,
    hostOf: hostOf
  };
});
