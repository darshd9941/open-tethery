# Open Tethery wire protocol (v1)

Owner: host stream (helper + Premiere/AE panel + Transmit plugin). Viewer and
Photoshop streams follow this file; propose changes by PR against it.

There is **one helper process** (`helper/`, Node 22) per PC. Everything talks
to it:

```
 Premiere / AE ──Transmit plugin──TCP 127.0.0.1:47826 (OTX1, see transmit-protocol.md)──┐
 Pr/AE CEP panel ────────────── WS  ws://127.0.0.1:47825/ws  (role "panel") ───────────────┤
 Photoshop UXP plugin ───────── WS  ws://127.0.0.1:47825/ws  (role "source") ──────────────┤ helper
 Phones / browsers ──────────── HTTP + WS  http://<LAN-IP>:47825/        (role "viewer") ──┘
```

- Port **47825** (HTTP + WebSocket, all interfaces). Port **47826** is the
  plugin ingest, loopback only.
- Everything is one WebSocket path: `/ws`. Text messages are UTF-8 JSON
  objects with a `t` field. Binary messages carry media (see "Binary media").
- Unknown `t` values and unknown fields must be ignored (forward compatible).
- Times: `ms` = Unix milliseconds. Media time = seconds as a float (`time`).

## 1. HTTP endpoints

| Path | Who | Returns |
|---|---|---|
| `GET /` | anyone | Viewer app (`viewer/index.html`). Shows a code-entry box when no code is in the URL. |
| `GET /c/CL7G` | anyone | Same viewer app; the code is read from the path. **This is what the QR encodes.** |
| `GET /health` | anyone | `{"ok":true,"name":"open-tethery","version":"0.2.0","protocol":1}` |
| `GET /api/session` | loopback only | `{"code":"CL7G","urls":["http://192.168.1.20:47825/c/CL7G", ...],"primaryUrl":"...","viewers":2,"source":{...state...}}` |
| `GET /api/qr.svg?text=...` | loopback only | QR code as SVG (so panels need no QR library). Omit `text` for the primary URL. |
| `POST /api/session/new` | loopback only | Makes a new code, disconnects all viewers. Returns the same body as `GET /api/session`. |

Static viewer files are served from `viewer/` (owned by the viewer stream).
The helper never caches `index.html` (`Cache-Control: no-store`).

## 2. Session code

- 4 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), shown
  upper-case; input is case-insensitive.
- A new code is made when the helper starts and on `POST /api/session/new`.
- Wrong code: the helper answers `{"t":"error","code":"bad-code"}` and closes.
  After **5 wrong codes from one IP in 5 minutes**, that IP gets
  `{"t":"error","code":"locked","retryInSec":N}` for 60 s.

## 3. Handshake

First message from every client must be `hello`, within 5 s, or the helper
closes the socket.

```json
{ "t": "hello", "role": "viewer", "code": "CL7G", "name": "Pixel 8", "protocol": 1,
  "accept": ["jpeg", "pcm"] }
```

- `role`: `"viewer"` (needs `code`), `"panel"` or `"source"` (loopback only,
  no code).
- `accept` (viewer): media the viewer can play. v1 media: `"jpeg"`, `"pcm"`.
  Reserved for later: `"webrtc"` (H.264 + Opus, see §7).

Reply:

```json
{ "t": "welcome", "id": "v3", "role": "viewer", "protocol": 1,
  "control": true, "server": { "name": "open-tethery", "version": "0.2.0" } }
```

`control` = whether this viewer may send playback commands right now (the
panel's "Allow control from phones" switch). It is re-sent in `perm` when it
changes: `{"t":"perm","control":false}`.

Right after `welcome` the helper sends the current `state` and, if there is
one, the newest video frame.

## 4. State (helper → viewer, helper → panel)

Sent on join and whenever anything changes (at most ~4 per second; timecode
also comes with every frame, so viewers should not rely on `state` for it).

```json
{
  "t": "state",
  "status": "live",
  "host": { "app": "premiere", "appName": "Premiere Pro", "version": "27.0" },
  "sequence": { "name": "Main edit", "width": 3840, "height": 2160,
                "fpsNum": 24000, "fpsDen": 1001, "fps": 23.976,
                "aspect": "16x9", "par": 1, "duration": 512.3 },
  "playing": false,
  "time": 12.5,
  "timecode": "00:00:12:12",
  "audio": { "available": true, "sampleRate": 48000, "channels": 2 },
  "engine": { "transmit": true, "sending": true },
  "viewers": 2
}
```

- `status`: `"idle"` (no source connected, or no frame for 3 s) or `"live"`.
- `host.app`: `"premiere" | "aftereffects" | "photoshop"`.
- `aspect`: reduced ratio written with `x` (`"16x9"`, `"9x16"`, `"4x5"`,
  `"1x1"`, `"2.39x1"` for non-integer ones rounded to 2 decimals).
- `engine.transmit`: the Transmit plugin is connected to the helper.
  `false` in Premiere/AE means "turn on Open Tethery in Preferences > Playback
  (Premiere) / Preferences > Video Preview (After Effects)".
- Any field may be missing when unknown. Photoshop sends `sequence.name` = the
  document name and no `fps`/`time`.

## 5. Binary media (helper → viewer)

Every binary WebSocket message starts with a 24-byte little-endian header:

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic ASCII `OTV1` |
| 4 | 1 | kind: `1` = JPEG video frame, `2` = PCM audio |
| 5 | 1 | flags (bit 0 = keyframe/still; others 0) |
| 6 | 2 | reserved, 0 |
| 8 | 4 | sequence number (per kind) |
| 12 | 4 | reserved, 0 |
| 16 | 8 | media time, float64 seconds (NaN when unknown) |

### kind 1 — JPEG frame

Payload after the header: 8 more bytes then the JPEG.

| Offset | Size | Field |
|---|---|---|
| 24 | 2 | JPEG width |
| 26 | 2 | JPEG height |
| 28 | 2 | source width (sequence frame, before downscale) |
| 30 | 2 | source height |
| 32 | … | JPEG bytes (sRGB / BT.709 assumed; may carry an ICC profile) |

Viewers draw the JPEG letter-boxed to `source width:height`. The helper drops
frames for slow viewers (newest frame wins; never queues more than one).

### kind 2 — PCM audio

Payload after the header: 8 more bytes then samples.

| Offset | Size | Field |
|---|---|---|
| 24 | 4 | sample rate (48000) |
| 28 | 1 | channels (2) |
| 29 | 1 | format: `1` = int16 interleaved |
| 30 | 2 | frame count (samples per channel in this chunk) |
| 32 | … | samples |

Chunks are ~20 ms. Audio is only sent to viewers that sent
`{"t":"audio","on":true}` (default off, so phones stay quiet until the user
taps the speaker). The viewer should keep ~80–150 ms of jitter buffer and
schedule by `media time`; when playback stops no chunks arrive.

## 6. Viewer → helper messages

| Message | Meaning |
|---|---|
| `{"t":"audio","on":true}` | start / stop audio chunks for this viewer |
| `{"t":"control","cmd":"play"}` | play |
| `{"t":"control","cmd":"pause"}` | pause |
| `{"t":"control","cmd":"toggle"}` | play/pause |
| `{"t":"control","cmd":"seek","time":12.5}` | move playhead to seconds |
| `{"t":"control","cmd":"step","frames":-1}` | step N frames (+/-) |
| `{"t":"control","cmd":"jump","to":"start"}` | `"start"` / `"end"` |
| `{"t":"ping","ts":1732350000000}` | helper answers `{"t":"pong","ts":…,"serverTs":…}` |
| `{"t":"info","name":"Pixel 8","w":1080,"h":2400}` | optional device info shown in the panel's phone list |

Control replies: `{"t":"control-ack","cmd":"seek","ok":true}` or
`{"t":"error","code":"control-off"|"no-host"|"unsupported","cmd":"step"}`.
Scrubbing: viewers should send at most ~15 `seek` per second; the helper keeps
only the newest pending seek.

Scopes, overlays, social frames, save frame and share are viewer-side only and
need no messages.

## 7. Reserved: WebRTC (later, M2)

When both sides list `"webrtc"` in `accept`, signalling rides the same socket:
`{"t":"rtc-offer","sdp":"..."}`, `{"t":"rtc-answer","sdp":"..."}`,
`{"t":"rtc-ice","candidate":{...}}`. Binary kinds 1/2 stay as the fallback.
Not implemented in v1; viewers must not depend on it.

## 8. Panel ↔ helper (role "panel", loopback only)

The CEP panel inside Premiere/AE knows the names the plugin cannot see and
executes playback commands.

Panel → helper:

```json
{ "t": "host-state", "host": {"app":"premiere","appName":"Premiere Pro","version":"27.0"},
  "sequence": {"name":"Main edit","width":3840,"height":2160,"fpsNum":24000,"fpsDen":1001,"duration":512.3},
  "playing": false, "time": 12.5 }
{ "t": "panel-settings", "allowControl": true }
{ "t": "new-session" }
{ "t": "kick", "id": "v3" }
{ "t": "control-result", "req": 7, "ok": true }
```

Helper → panel: `state` (§4, plus `viewerList: [{"id":"v3","name":"Pixel 8","ip":"192.168.1.31"}]`,
`code`, `urls`, `primaryUrl`), and playback commands to run:

```json
{ "t": "control", "req": 7, "cmd": "seek", "time": 12.5 }
```

## 9. Source (role "source", loopback only) — Photoshop and test tools

A source pushes its own frames when there is no Transmit plugin:

- `{"t":"source-state", ...same fields as host-state...}`
- Binary: the same `OTV1` kind-1 layout as §5 (helper rewrites the sequence
  number). Max 32 MiB.

If both the Transmit plugin and a source are connected, the newest one to send
a frame is what viewers see.
