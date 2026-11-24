'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../client/js/connections.js');
const P = require('../client/js/panel-client.js');

const conns = [
  { kind: 'wifi', label: 'Wi-Fi', name: 'Wi-Fi', ip: '192.168.1.20', url: 'http://192.168.1.20:47825/c/CL7G', recommended: true },
  { kind: 'hotspot', label: 'Phone hotspot', name: 'Local Area Connection* 10', ip: '192.168.137.1', url: 'http://192.168.137.1:47825/c/CL7G', recommended: false },
  { kind: 'usb', label: 'USB cable', name: 'Ethernet 3', ip: '172.20.10.2', url: 'http://172.20.10.2:47825/c/CL7G', recommended: false },
  { kind: 'tailscale', label: 'Tailscale', name: 'Tailscale', ip: '100.101.102.103', url: 'http://100.101.102.103:47825/c/CL7G', recommended: false },
];

test('options list address and mark the recommended one', () => {
  const o = C.options(conns);
  assert.equal(o.length, 4);
  assert.equal(o[0].text, 'Wi-Fi - 192.168.1.20 (best)');
  assert.equal(o[1].text, 'Phone hotspot - 192.168.137.1');
  assert.equal(o[1].value, '192.168.137.1');
  assert.deepEqual(C.options(null), []);
});

test('selected follows primaryUrl', () => {
  assert.equal(C.selected(conns, 'http://192.168.137.1:47825/c/CL7G').kind, 'hotspot');
  assert.equal(C.selected(conns, 'http://10.9.9.9:47825/c/CL7G'), null);
  assert.equal(C.selected(conns, ''), null);
});

test('choice: recommended means automatic, others send the ip, unknown sends nothing', () => {
  assert.equal(C.choiceToSetting(conns, '192.168.1.20'), null);
  assert.equal(C.choiceToSetting(conns, '100.101.102.103'), '100.101.102.103');
  assert.equal(C.choiceToSetting(conns, '1.2.3.4'), undefined);
});

test('help text: 2-3 short lines per kind, key advice present', () => {
  for (const k of ['wifi', 'ethernet', 'hotspot', 'usb', 'tailscale', 'vpn', 'other', 'unknown']) {
    const lines = C.helpLines(k);
    assert.ok(lines.length >= 1 && lines.length <= 3, k);
    for (const l of lines) assert.ok(l.length < 110, l);
  }
  assert.match(C.helpLines('hotspot').join(' '), /Mobile Hotspot in Windows Settings/);
  assert.match(C.helpLines('usb').join(' '), /Personal Hotspot/);
  assert.match(C.helpLines('usb').join(' '), /USB tethering/);
  assert.match(C.helpLines('tailscale').join(' '), /same account/);
});

test('open folder command and dirOf', () => {
  assert.deepEqual(C.openFolderCommand('C:\\Users\\a\\r.zip', 'win32'), { cmd: 'explorer.exe', args: ['/select,C:\\Users\\a\\r.zip'] });
  assert.equal(C.openFolderCommand('/x/r.zip', 'linux'), null);
  assert.equal(C.openFolderCommand('', 'win32'), null);
  assert.equal(C.dirOf('C:\\Users\\a\\reports\\r.zip'), 'C:\\Users\\a\\reports');
  assert.equal(C.dirOf('/home/a/r.zip'), '/home/a');
});

test('panel-client sends panel-settings with connection', () => {
  const sent = [];
  class FakeWS {
    constructor() { this.readyState = 1; FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) { sent.push(JSON.parse(s)); }
    close() {}
  }
  const client = P.create({
    WebSocketImpl: FakeWS,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, name: 'open-tethery' }) }),
    pollState: async () => null,
    runControl: async () => ({ ok: true }),
    timers: { setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {} },
  });
  client.start();
  return new Promise((resolve) => setTimeout(() => {
    FakeWS.last.onmessage({ data: JSON.stringify({ t: 'welcome' }) });
    client.setConnection('192.168.137.1');
    client.setConnection(null);
    client.stop();
    assert.deepEqual(sent.filter((m) => m.t === 'panel-settings'), [
      { t: 'panel-settings', connection: '192.168.137.1' },
      { t: 'panel-settings', connection: null },
    ]);
    resolve();
  }, 50));
});
