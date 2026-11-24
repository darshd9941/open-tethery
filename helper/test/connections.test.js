'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHelper } = require('../lib/index');
const { classifyInterface, connectionList, lanAddresses } = require('../lib/lan');
const { createZip, readZip } = require('../lib/zip');
const { buildReport } = require('../lib/report');
const { connectPanel } = require('../tools/fake-panel');
const { connectViewer } = require('../tools/fake-viewer');

const v4 = (address, internal = false) => [{ address, family: 'IPv4', internal, netmask: '255.255.255.0' }];

// Mimics what os.networkInterfaces() returns on a Windows PC with many adapters.
const WINDOWS = {
  'Loopback Pseudo-Interface 1': v4('127.0.0.1', true),
  'Wi-Fi': v4('192.168.1.20'),
  Ethernet: v4('192.168.1.21'),
  'Local Area Connection* 10': v4('192.168.137.1'),
  'Ethernet 3': v4('172.20.10.2'), // iPhone USB Personal Hotspot
  'Ethernet 4': v4('192.168.42.129'), // Android USB tethering
  'Remote NDIS based Internet Sharing Device': v4('192.168.43.5'),
  Tailscale: v4('100.101.102.103'),
  'vEthernet (WSL)': v4('172.28.0.1'),
  'VirtualBox Host-Only Network': v4('192.168.56.1'),
  NordLynx: v4('10.5.0.2'),
  'Bluetooth Network Connection': v4('169.254.3.4'),
};

test('classify: Windows-style adapter names and subnets', () => {
  const k = classifyInterface;
  assert.strictEqual(k('Wi-Fi', '192.168.1.20'), 'wifi');
  assert.strictEqual(k('Wi-Fi 2', '10.0.0.4'), 'wifi');
  assert.strictEqual(k('wlp3s0', '10.0.0.4'), 'wifi');
  assert.strictEqual(k('Ethernet', '192.168.1.21'), 'ethernet');
  assert.strictEqual(k('eth0', '10.0.0.4'), 'ethernet');
  assert.strictEqual(k('Local Area Connection* 10', '192.168.137.1'), 'hotspot');
  assert.strictEqual(k('Local Area Connection* 3', '169.254.9.9'), 'other');
  assert.strictEqual(k('Wi-Fi', '172.20.10.3'), 'hotspot'); // PC joined the iPhone hotspot
  assert.strictEqual(k('Ethernet 3', '172.20.10.2'), 'usb'); // cable to iPhone
  assert.strictEqual(k('Ethernet 4', '192.168.42.129'), 'usb');
  assert.strictEqual(k('Wi-Fi', '192.168.42.20'), 'hotspot');
  assert.strictEqual(k('Remote NDIS based Internet Sharing Device', '192.168.43.5'), 'usb');
  assert.strictEqual(k('Apple Mobile Device Ethernet', '169.254.1.1'), 'usb');
  assert.strictEqual(k('Tailscale', '100.101.102.103'), 'tailscale');
  assert.strictEqual(k('Ethernet 9', '100.80.0.1'), 'tailscale');
  assert.strictEqual(k('NordLynx', '10.5.0.2'), 'vpn');
  assert.strictEqual(k('OpenVPN TAP-Windows6', '10.8.0.2'), 'vpn');
  assert.strictEqual(k('vEthernet (WSL)', '172.28.0.1'), 'other');
  assert.strictEqual(k('VirtualBox Host-Only Network', '192.168.56.1'), 'other');
  assert.strictEqual(k('Bluetooth Network Connection', '169.254.3.4'), 'other');
});

test('connectionList: fields, one recommended, normal LAN beats hotspot', () => {
  const list = connectionList({ interfaces: WINDOWS, port: 47825, code: 'CL7G' });
  assert.strictEqual(list.length, 11); // no loopback
  assert.strictEqual(list.filter((c) => c.recommended).length, 1);
  assert.strictEqual(list[0].recommended, true);
  assert.ok(['wifi', 'ethernet'].includes(list[0].kind));
  for (const c of list) {
    assert.deepStrictEqual(Object.keys(c).sort(), ['ip', 'kind', 'label', 'name', 'recommended', 'url']);
    assert.strictEqual(c.url, `http://${c.ip}:47825/c/CL7G`);
  }
  const hot = list.find((c) => c.ip === '192.168.137.1');
  assert.strictEqual(hot.kind, 'hotspot');
  assert.strictEqual(hot.label, 'Phone hotspot');
  assert.ok(list.indexOf(hot) > 1);
});

test('connectionList: hotspot alone is recommended; lanIp override ranks first', () => {
  const only = { 'Local Area Connection* 10': v4('192.168.137.1') };
  const list = connectionList({ interfaces: only, port: 1, code: 'AAAA' });
  assert.strictEqual(list[0].recommended, true);
  assert.strictEqual(lanAddresses({ interfaces: WINDOWS, lanIp: '100.101.102.103' })[0].ip, '100.101.102.103');
});

test('zip: round trip, empty entry and utf-8 name', () => {
  const buf = createZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/ü.json', data: Buffer.from('{"x":1}') }, { name: 'e', data: '' }]);
  const out = readZip(buf);
  assert.deepStrictEqual(out.map((e) => e.name), ['a.txt', 'dir/ü.json', 'e']);
  assert.strictEqual(out[0].data.toString(), 'hello');
  assert.strictEqual(out[2].data.length, 0);
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);
});

test('report: redacts the session code everywhere', () => {
  const zip = buildReport({
    code: 'CL7G',
    log: ['x joined CL7G'],
    cfg: {},
    session: { code: 'CL7G', primaryUrl: 'http://1.2.3.4:1/c/CL7G' },
    interfaces: WINDOWS,
    recentStates: [{ code: 'CL7G' }],
    viewers: [],
    version: require('../package.json').version,
  });
  const files = readZip(zip);
  assert.ok(files.length >= 8);
  for (const f of files) assert.ok(!f.data.toString().includes('CL7G'), f.name);
  assert.ok(files.find((f) => f.name === 'session.json').data.toString().includes('****'));
});

function req(port, p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}
const session = async (port) => JSON.parse((await req(port, '/api/session')).body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('integration: connections in /api/session, panel picks one, report zip', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-conn-'));
  const configPath = path.join(tmp, 'config.json');
  const reportsDir = path.join(tmp, 'reports');
  const helper = createHelper({ port: 0, ingestPort: 0, logFile: null, echo: false, configPath, reportsDir, interfaces: WINDOWS, viewerDir: tmp });
  const { port } = await helper.start();
  const clients = [];
  try {
    const s = await session(port);
    assert.strictEqual(s.connections.length, 11);
    assert.strictEqual(s.connections[0].url, s.primaryUrl);
    assert.ok(s.connections[0].recommended);

    const panel = await connectPanel({ port });
    clients.push(panel);
    panel.send({ t: 'panel-settings', connection: '192.168.137.1' });
    for (let i = 0; i < 40 && !(await session(port)).primaryUrl.includes('192.168.137.1'); i++) await sleep(50);
    const s3 = await session(port);
    assert.ok(s3.primaryUrl.startsWith('http://192.168.137.1:'), s3.primaryUrl);
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).lanIp, '192.168.137.1');
    assert.ok(!s3.connections.find((c) => c.ip === '192.168.137.1').recommended);

    panel.send({ t: 'panel-settings', connection: '8.8.8.8' }); // not an interface: ignored
    await sleep(100);
    assert.ok((await session(port)).primaryUrl.includes('192.168.137.1'));

    panel.send({ t: 'panel-settings', connection: null }); // back to automatic
    for (let i = 0; i < 40 && (await session(port)).primaryUrl.includes('192.168.137.1'); i++) await sleep(50);
    assert.ok((await session(port)).primaryUrl.includes('192.168.1.'));

    clients.push(await connectViewer({ port, code: helper.hub.code }));
    await sleep(100);

    assert.strictEqual((await req(port, '/api/report')).status, 405);
    const r = await req(port, '/api/report', 'POST');
    assert.strictEqual(r.status, 200);
    const { path: file } = JSON.parse(r.body);
    assert.ok(file.startsWith(reportsDir) && /open-tethery-report-.*\.zip$/.test(file));
    const entries = readZip(fs.readFileSync(file));
    const names = entries.map((e) => e.name);
    for (const n of ['helper-log.txt', 'config.json', 'session.json', 'interfaces.json', 'system.json', 'state-messages.json', 'viewers.json', 'firewall-hint.txt']) {
      assert.ok(names.includes(n), n);
    }
    for (const e of entries) assert.ok(!e.data.toString().includes(helper.hub.code), `${e.name} leaks the code`);
    assert.ok(JSON.parse(entries.find((e) => e.name === 'state-messages.json').data).length >= 1);
    assert.strictEqual(JSON.parse(entries.find((e) => e.name === 'viewers.json').data).length, 1);
    assert.ok(JSON.parse(entries.find((e) => e.name === 'system.json').data).node);
  } finally {
    for (const c of clients) if (c.close) c.close();
    await helper.stop();
  }
});
