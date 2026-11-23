# Open Tethery Helper

One Node 22 process per PC (CommonJS, only runtime dependency `ws`). It implements
`docs/PROTOCOL.md` v1 except real WebRTC media: it serves the phone viewer, takes
frames from the Premiere/AE Transmit plugin (OTX1 on `127.0.0.1:47826`), the CEP panel and
Photoshop source (WebSocket `/ws`), and fans them out to phones on the LAN.

## Run

```
cd helper
npm install
npm start            # http://<LAN-IP>:47825/ , session code printed in the log
npm test             # node --test (units + integration over real sockets)
```

Try it without Adobe apps (three terminals; `CODE` is in the log or `curl http://127.0.0.1:47825/api/session`):

```
node tools/fake-transmit.js --fps 15      # OTX1 sender with a built-in JPEG
node tools/fake-panel.js                  # panel: host-state, acks controls
node tools/fake-viewer.js CODE --audio    # phone stand-in; prints state/stats
```

If the viewer files are missing the helper serves a small placeholder page.

## Configuration

Order: defaults < config file < environment.

- Config file: `%APPDATA%\OpenTethery\config.json` (Windows) or `~/.config/open-tethery/config.json`.
  Keys: `port`, `ingestPort`, `lanIp`, `allowControl`, `viewerDir`. The panel's Connection choice is saved as `lanIp`.
- `OPEN_TETHERY_PORT` (HTTP/WS port, default 47825), `OPEN_TETHERY_LAN_IP` (force the address in the QR URL).
- `OT_VIEWER_DIR` viewer files (default `../viewer`); the installer also sets `OT_EXE_DIR`.
- Log: `helper.log` next to the config file; last lines at `GET http://127.0.0.1:47825/api/log?n=200` (loopback only).
- Single instance: if the port is busy and `/health` answers `open-tethery`, the new process exits 0 quietly.

## Connections and reports (M7)

- `lib/lan.js` `classifyInterface(name, ip)` sorts each IPv4 interface into wifi / ethernet / hotspot / usb / tailscale / vpn / other
  (names plus subnets; unit tests use Windows-style fixture tables). `/api/session` returns them as `connections`.
- `POST /api/report` (loopback) writes `open-tethery-report-<date>.zip` (store-only zip, `lib/zip.js`) to
  `%LOCALAPPDATA%\OpenTethery\reports` or `~/.config/open-tethery/reports`: log tail, config, session (code redacted),
  interfaces, versions, last 50 panel states, viewers with telemetry, firewall hint. Nothing is uploaded.

## Layout

`lib/` config, lan (address ranking + connection kinds), zip + report (diagnostics bundle), session (codes, lockout), qr (QR encoder, byte mode ECC M v1-10),
otx1 (plugin parser), ingest (TCP listener), otv1 (binary media framing), state (aggregation, aspect, timecode),
hub (WebSocket clients, fan-out, control routing, stats), static (viewer files), log, index (HTTP wiring),
`webrtc.js` (stub: `available:false`; the interface a real module must implement is documented in the file).

Notes: the Transmit plugin goes idle after 3 s without a frame or heartbeat; a source (Photoshop) stays live while
connected after its first frame. Source JPEG bytes are forwarded unchanged. Panel/source roles and the `/api/*`
loopback endpoints also refuse requests that carry a web `Origin` (http/https, non-loopback), so a web page cannot drive them.

## Needs PC test

- Windows Firewall: first run must allow inbound TCP 47825 on the private network so phones can connect (`installer/` prompts or adds a rule).
- Real Transmit plugin: connect over 47826 inside Premiere / After Effects, check frames, heartbeats, idle after stop, newest-connection-wins on restart.
- CEP panel connecting from inside Premiere/AE (`ws://127.0.0.1:47825/ws`, role `panel`): confirm the host's `Origin` header is not rejected, host-state, control commands, `get-state`.
- Photoshop UXP plugin as role `source`: same Origin check, frame upload size, live-while-connected.
- LAN address choice with several adapters (VPN, WSL, Tailscale): the first URL in `/api/session` must be the one a phone reaches; use `lanIp` to override.
- Phone on Wi-Fi: frame rate and `dropped` in stats under a weak signal.
- Connection kinds on real hardware: Windows Mobile Hotspot adapter (192.168.137.x), iPhone Personal Hotspot over USB (Apple Mobile Device Ethernet, 172.20.10.x), Android USB tethering (RNDIS, 192.168.42.x or other), Tailscale: check each is classified as expected and that a phone can open the URL.
- Report zip opens in Windows Explorer ("Extract all") and contains the expected files; writing under `%LOCALAPPDATA%` works.
