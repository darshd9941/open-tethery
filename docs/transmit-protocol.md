# Plugin to relay protocol (OTX1)

The native Transmit plugin inside Premiere sends frames to the local relay over
a plain TCP socket. Phase 1 sends JPEG stills at up to 15 fps; Phase 2 will add
H.264 as a new message type without changing the framing.

- Transport: TCP, `127.0.0.1:47826` (relay listens on loopback only).
- One connection at a time. If a second plugin connects, the relay keeps the
  newest connection and closes the older one.
- The plugin reconnects every 2 s if the relay is not running. It never blocks
  Premiere: if the socket is busy, the frame is dropped (newest frame wins).
- All integers are little-endian.

## Message header (16 bytes)

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic, ASCII `OTXF` |
| 4 | 1 | type (see below) |
| 5 | 3 | reserved, 0 |
| 8 | 4 | payload length in bytes (max 32 MiB; relay drops the connection if larger) |
| 12 | 4 | sequence number, increments per message |

Followed by `payload length` bytes.

## Types

### 1 = video frame, JPEG

Payload = 24-byte frame meta, then JPEG bytes (baseline, sRGB / BT.709 assumed).

| Offset | Size | Field |
|---|---|---|
| 0 | 2 | width of the JPEG |
| 2 | 2 | height of the JPEG |
| 4 | 2 | sequence frame width (before downscale) |
| 6 | 2 | sequence frame height |
| 8 | 8 | playhead position, Premiere ticks (signed; 254016000000 ticks = 1 s) |
| 16 | 4 | frame rate numerator (0 if unknown) |
| 20 | 4 | frame rate denominator |

### 2 = state, UTF-8 JSON

Sent on connect and whenever it changes. Fields (all optional):

```json
{ "app": "premiere", "playing": true, "sequence": "Main edit", "pluginVersion": "0.1.0" }
```

### 3 = heartbeat

Empty payload, sent every 1 s when no frame was sent, so the relay can show
"Premiere connected, idle".
