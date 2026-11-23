# Native Transmit plugin (Premiere Pro)

Our own thin Mercury Transmit plugin. Premiere hands it every frame the Program
Monitor shows; it forwards them to the local helper (relay), which streams to
phones: video (JPEG stills, up to 15 fps) and audio (push audio, 48 kHz stereo
PCM). Wire format:
[`docs/transmit-protocol.md`](../../docs/transmit-protocol.md) (OTX1).

Builds against the Adobe Premiere Pro C++ SDK headers, which are not in this
repo. See the top-level README for where to put the SDK.

Note: Adobe's own Transmitter sample is marked "ADOBE CONFIDENTIAL" and is not
copied into this repo. The code here is written from scratch against the SDK
headers and documentation.

## Files

| File | What it does |
|---|---|
| `src/OpenTetheryTransmit.cpp` | `xTransmitEntry` export and the `tmModule` callbacks. Copies the newest frame and returns at once. |
| `src/FrameSender.cpp/.h` | "Latest frame" slot (newest wins) and the worker thread: downscale, JPEG, TCP send, reconnect, state + heartbeat. |
| `src/Otx1.h` | OTX1 message builders and the helper-to-plugin reader (pure C++, unit-tested). |
| `src/AudioPush.h` | Float planar to int16 stereo conversion/downmix and the lock-protected audio queue (pure C++, unit-tested). |
| `src/JpegEncoder.cpp/.h` | JPEG encoding with Windows Imaging Component (built into Windows, no extra libraries). |
| `src/Log.h` | Logging to `OutputDebugString` only. |
| `test/run.sh` | Host-side unit tests (g++ and node, no Windows needed). |
| `install.ps1` | Copies the built `.prm` into Adobe's MediaCore plug-in folder (asks for admin). |

## Build

Needs Visual Studio 2022 (toolset v143, "Desktop development with C++").

```bat
"C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe" ^
  native\transmit\OpenTetheryTransmit.vcxproj /p:Configuration=Release /p:Platform=x64
```

Output: `build\native\Release\OpenTetheryTransmit.prm` (intermediates in
`build\native\obj\`; nothing is written inside `native\transmit\`).

The SDK is found through the MSBuild property `PremiereSdk`, which must point
at the SDK's `Examples` folder (the one holding `Headers\`). Default:
`sdk\Premiere Pro 27.0 C++ SDK\Examples` at the repo root. Override with the
`PREMIERE_SDK` environment variable or `/p:PremiereSdk=...`.

Check the export (VS Developer prompt): `dumpbin /exports OpenTetheryTransmit.prm`
should list `xTransmitEntry`.

## Install

1. Close Premiere Pro.
2. `powershell -ExecutionPolicy Bypass -File native\transmit\install.ps1`
   (copies to `C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\OpenTethery\`;
   Windows asks for admin rights). `-Uninstall` removes it.
3. Start Premiere, open **Preferences > Playback**, tick
   **Open Tethery (phone preview)** under Video Device, and make sure
   **Enable Mercury Transmit** is on.
4. For sound, see "Audio" below (one extra tick; your speakers stay the main output).
5. Start the relay. The plugin connects to `127.0.0.1:47826` and retries every
   2 s, so the order does not matter.

## Audio (push audio)

Premiere's Transmit interface treats a plug-in as an audio *clock device* only
if it implements a playback clock. We do not: your normal speakers stay the
clock ("primary") device and Open Tethery is an extra, mirrored ("secondary")
output that Premiere *pushes* a copy of the mix to (`PushAudio`, Transmit
interface version 4). So:

1. **Preferences > Playback > Audio Device**: leave your normal output (speakers
   or headphones) selected. Do not try to select Open Tethery as the main device.
2. In the same Preferences > Playback page, in the Audio/Video device lists, tick
   **Open Tethery (phone preview)** for **audio** as well as for video (it appears as
   an additional output with channels "Open Tethery L" / "Open Tethery R"). Wording and
   position of the audio tick differ between Premiere versions, so see "Needs PC test".
3. Press play. The phone must have audio turned on (speaker button in the viewer).

Details: 48 kHz, stereo. Host buffers of any size are accepted; the plug-in
copies them into a queue (1 s max, oldest dropped on overflow) and the worker
thread sends 20 ms int16 chunks (OTX1 type 5) stamped with the media time of
the first sample. More than two channels are folded down (L R C LFE Ls Rs: centre
and surrounds at -3 dB, LFE dropped); mono goes to both sides. Audio is not
buffered while the helper is not connected. After Effects (host `AfterFX.exe`) gets
no audio at all.

Environment switches (set before starting Premiere):
`OPEN_TETHERY_AUDIO=0` disables audio entirely; `OPEN_TETHERY_AUDIO=push` reports
only the push-audio capability and not "audio device" (try this if Premiere shows
an audio entry that misbehaves).

## How it behaves

- **Pixel format:** asks Premiere for 8-bit BGRA (`PrPixelFormat_BGRA_4444_8u`),
  any size. Frames in any other format are skipped (still disposed).
- **Orientation:** uncompressed Premiere frames have a lower-left origin; the
  plugin starts at `GetPixels`, steps by `GetRowBytes` (may be negative) and
  writes rows top-down. If a future Premiere ever shows the picture upside
  down, set the environment variable `OPEN_TETHERY_FLIP=1` before starting
  Premiere to invert the row order.
- **Speed:** `PushVideo` only copies the frame into a buffer (no allocation once
  warmed up), disposes every PPix it was given and returns. While playing it
  takes at most 15 frames a second; when paused or scrubbing it takes every
  frame so the newest always wins. The worker thread box-downscales to at most
  1280 px on the long edge, encodes JPEG at quality 0.8 and sends.
- **Time:** playhead from `tmPushVideo.inTime` (converted to 254016000000
  ticks/s; if Premiere sends a negative "immediate" time, the last known time
  is reused, or -1 if none). Frame rate from the instance's ticks-per-frame,
  reduced to an exact fraction (e.g. 30000/1001).
- **Playing state:** the plugin does not offer a clock, so
  the state comes from each frame's play mode (Playing vs Stopped/Scrubbing).
  If frames stop arriving during playback for 1 s, it reports paused.
  `StartPlaybackClock` / `StopPlaybackClock` also update it if Premiere calls them.
- **Network:** state message on connect and on change, heartbeat after 1 s
  without sending. Send timeout 1 s; on any error the socket is closed and
  retried 2 s later. Premiere's thread never touches the socket.
- **Logs:** `[OpenTethery] ...` lines via `OutputDebugString` (view with
  Sysinternals DebugView). No files are written.

## Needs PC test (audio)

- The plug-in shows up with an audio option in Preferences > Playback, and ticking it makes Premiere call `StartPushAudio`
  (DebugView: `push audio started`). If no audio entry appears, try `OPEN_TETHERY_AUDIO=push`.
- Sound reaches the phone in time with the picture; speakers still play normally. Check lip-sync; if the phone is
  consistently early/late, tell us by how many ms (the helper/viewer can add an offset).
- Seeking/looping while playing causes no clicks that last more than a moment (queue starts a new segment on a time jump).
- Premiere does not hang or stutter when the helper is not running (audio is dropped, not buffered).
