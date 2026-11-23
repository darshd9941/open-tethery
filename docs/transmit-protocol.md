# Plugin to relay protocol (OTX1)

The native Transmit plugin inside Premiere sends frames to the local relay over
a plain TCP socket. Phase 1 sends JPEG stills at up to 15 fps; Phase 2 (M2) adds
H.264 video (type 4), PCM audio (type 5) and two helper-to-plugin messages (types 64 and 65) without changing the framing.

- Transport: TCP, `127.0.0.1:47826` (relay listens on loopback only).
- The connection is bidirectional: the plugin sends types 1-5, the helper sends types 64-65 back on the same socket
  (same header). The plugin must read from the socket (non-blocking) and ignore unknown types.
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

### 4 = video, H.264 access unit (plugin to helper)

One complete access unit (one picture) in **Annex B** format: start codes `00 00 00 01` (or `00 00 01`) before every NAL
unit, no length prefixes. The helper forwards it to phones over WebRTC and never decodes or re-encodes it.

Payload = 16-byte meta, then the Annex B bytes.

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | flags: bit 0 = keyframe (IDR). Other bits 0 |
| 1 | 3 | reserved, 0 |
| 4 | 2 | encoded width |
| 6 | 2 | encoded height |
| 8 | 8 | playhead position, Premiere ticks (signed, as in type 1; 254016000000 ticks = 1 s) |

Encoder requirements (what the C++ must do):

- H.264 **constrained baseline** (profile_idc 66, constraint_set1 on; `profile-level-id` 42e0xx), level 4.0 or lower for 1080p,
  Media Foundation `eAVEncH264VProfile_ConstrainedBase`. Use level 5.1 only if the viewer must show 4K.
- **No B-frames**, one slice per picture is fine (several are fine too), low-latency mode on (`CODECAPI_AVLowLatencyMode`),
  CBR or capped VBR around 6-12 Mbit/s for 1080p. Colour: BT.709, limited range, tagged in the SPS VUI
  (`colour_primaries=1`, `transfer_characteristics=1`, `matrix_coefficients=1`, `video_full_range_flag=0`).
- **Every keyframe access unit must start with SPS and PPS** in front of the IDR slice (set `CODECAPI_AVEncH264...` /
  prepend the cached SPS+PPS if the encoder does not repeat them). The helper starts a phone on a keyframe.
- Keyframe every 1-2 seconds, plus one immediately after a type 64 request (below) or after a resolution change.
- One type-4 message per picture, in decode order. Do not send the access unit delimiter (the helper drops it anyway).
- While the connection is up and an H.264 stream is active, send **at least one access unit per second** even if the picture
  does not change (repeat the last frame): the helper treats 3 s without RTP as a dead stream and falls back to JPEG.
- Width/height are the encoded picture size (the sequence aspect must be kept; downscale 4K to at most 1920x1080 or what the
  user chose). Type 1's sequence size fields are still the ones used for letter-boxing and the state message.

The first type-4 message after connecting switches the helper to "H.264 active" (WebRTC offered to phones). When the connection
drops, H.264 is no longer active.

### 5 = audio, PCM chunk (plugin to helper)

Payload = 16-byte meta, then samples. Same layout as PROTOCOL.md section 5 kind 2, plus the playhead time.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | sample rate (48000) |
| 4 | 1 | channels (2) |
| 5 | 1 | format: `1` = int16 interleaved |
| 6 | 2 | frame count (samples per channel in this chunk; ~960 for 20 ms) |
| 8 | 8 | playhead time of the first sample, Premiere ticks (signed) |

The sample bytes must be exactly `frames * channels * 2` long, otherwise the message is dropped. The helper forwards it to
phones as OTV1 kind 2, only to viewers that turned audio on. (Opus over WebRTC comes later; PCM stays the fallback.)

## Helper to plugin messages

Sent by the helper on the same socket. Same 16-byte header (magic `OTXF`).

### 64 = request keyframe

Empty payload. Produce an IDR access unit (with SPS/PPS) as soon as possible. Sent when a phone starts WebRTC and when a
phone reports picture loss (PLI). The helper sends at most one every 0.5 s. A plugin without an H.264 encoder ignores it.

### 65 = JPEG wanted, UTF-8 JSON

`{"jpeg":true}` or `{"jpeg":false}`. Tells the plugin whether it must keep sending type-1 JPEG frames **while it also sends
H.264**. The helper needs JPEG for phones that have no WebRTC (old browser, ICE failed, fallback). Rules:

- A new connection starts as `jpeg: true`; the helper sends type 65 only when the answer changes (so a plugin that never
  receives one must send JPEG).
- `jpeg: true`: send JPEG at a low rate, about 5 fps (at most 5-10 fps; stills are enough because the phones are the fallback),
  in addition to H.264. `jpeg: false`: send no JPEG at all, H.264 only (saves CPU).
- A plugin that has no H.264 encoder never sends type 4 and keeps sending JPEG as in phase 1; type 65 does not apply to it.
- The helper sets `jpeg: false` only when H.264 is flowing and every connected phone is on WebRTC (or no phone is connected).
