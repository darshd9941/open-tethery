# Native Transmit plugin (Premiere Pro)

Our own thin Mercury Transmit plugin. Premiere hands it every frame the Program
Monitor shows; it forwards them to the local helper (relay), which streams to
phones: video as H.264 (Windows Media Foundation, up to 1920x1080, 30 fps; JPEG
stills stay as the fallback) and audio (push audio, 48 kHz stereo PCM). Wire format:
[`docs/transmit-protocol.md`](../../docs/transmit-protocol.md) (OTX1).

Builds against the Adobe Premiere Pro C++ SDK headers, which are not in this
repo. See the top-level README for where to put the SDK.

Note: Adobe's own Transmitter sample is marked "ADOBE CONFIDENTIAL" and is not
copied into this repo. The code here is written from scratch against the SDK
headers and documentation.

## Files

| File | What it does |
|---|---|
| `src/PocketMonitorTransmit.cpp` | `xTransmitEntry` export and the `tmModule` callbacks. Copies the newest frame and returns at once. |
| `src/FrameSender.cpp/.h` | "Latest frame" slot (newest wins) and the worker thread: downscale, JPEG, TCP send, reconnect, state + heartbeat. |
| `src/Otx1.h` | OTX1 message builders and the helper-to-plugin reader (pure C++, unit-tested). |
| `src/AudioPush.h` | Float planar to int16 stereo conversion/downmix and the lock-protected audio queue (pure C++, unit-tested). |
| `src/H264Encoder.cpp/.h` | Media Foundation H.264 encoder MFT (hardware first, software fallback): constrained baseline, low latency, CBR, Annex B out. |
| `src/ImageOps.h` | Size fitting, box downscale, BGRA to NV12 (BT.709 limited range) (pure C++, unit-tested). |
| `src/AnnexB.h` | NAL splitting, SPS/PPS before every IDR (pure C++, unit-tested). |
| `src/JpegEncoder.cpp/.h` | JPEG encoding with Windows Imaging Component (built into Windows, no extra libraries). |
| `src/Log.h` | Logging to `OutputDebugString` only. |
| `test/run.sh` | Host-side unit tests (g++ and node, no Windows needed). |
| `install.ps1` | Copies the built `.prm` into Adobe's MediaCore plug-in folder (asks for admin). |

## Build

Needs Visual Studio 2022 (toolset v143, "Desktop development with C++").

```bat
"C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe" ^
  native\transmit\PocketMonitorTransmit.vcxproj /p:Configuration=Release /p:Platform=x64
```

Linked extra system libraries: `mfplat mf mfuuid strmiids wmcodecdspuuid` (Media Foundation; all ship with the Windows SDK).

Output: `build\native\Release\PocketMonitorTransmit.prm` (intermediates in
`build\native\obj\`; nothing is written inside `native\transmit\`).

The SDK is found through the MSBuild property `PremiereSdk`, which must point
at the SDK's `Examples` folder (the one holding `Headers\`). Default:
`sdk\Premiere Pro 27.0 C++ SDK\Examples` at the repo root. Override with the
`PREMIERE_SDK` environment variable or `/p:PremiereSdk=...`.

Check the export (VS Developer prompt): `dumpbin /exports PocketMonitorTransmit.prm`
should list `xTransmitEntry`.

## Install

1. Close Premiere Pro.
2. `powershell -ExecutionPolicy Bypass -File native\transmit\install.ps1`
   (copies to `C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\PocketMonitor\`;
   Windows asks for admin rights). `-Uninstall` removes it.
3. Start Premiere, open **Preferences > Playback**, tick
   **Pocket Monitor (phone preview)** under Video Device, and make sure
   **Enable Mercury Transmit** is on.
4. For sound, see "Audio" below (one extra tick; your speakers stay the main output).
5. Start the relay. The plugin connects to `127.0.0.1:47826` and retries every
   2 s, so the order does not matter.

## Video in Premiere

**Preferences > Playback > Video Device** (the "Mercury Transmit" list): tick **Pocket Monitor (phone preview)**
and make sure **Enable Mercury Transmit** is on. That is all for video; the plug-in picks H.264 by itself.

## H.264

- **Encoder:** Media Foundation. It enumerates hardware H.264 encoders (`MFTEnumEx`, NVENC/QuickSync/AMF) first and
  falls back to Microsoft's software encoder. Constrained baseline (profile 66, level 4.0), no B-frames,
  `CODECAPI_AVLowLatencyMode`, CBR (about 8 Mbit/s at 1080p, scaled with pixel count, 1.5 to 12 Mbit/s),
  BT.709 limited range tagged for the SPS VUI, 30 fps nominal.
- **Input:** the BGRA frames Premiere already gives us are converted to NV12 on the worker thread (never on Premiere's
  thread). Pictures larger than 1920x1080 (or 1080x1920 portrait) are box-downscaled first; sizes are rounded down to even.
- **Keyframes:** an IDR is forced every 1.5 s, right after connecting, on every helper request (OTX type 64) and after a
  size change. Every IDR access unit carries SPS+PPS (from the encoder's output or the cached copy).
- **Never silent:** if the picture is static (paused) the last frame is re-encoded at least every 0.7 s, so the helper
  always sees at least one access unit per second.
- **JPEG next to H.264:** the helper tells us with OTX type 65 whether it still needs JPEG. On `jpeg:true` (the default on
  every new connection) JPEG is sent at about 5 fps in addition; on `jpeg:false` only H.264 is sent. JPEG is also sent
  whenever no H.264 has come out for 2 s.
- **Fallback:** if no H.264 encoder can be created, or one stops producing output (30 frames in, none out), or an encode
  call fails, the plug-in retries once with the software encoder and then stays on JPEG only, exactly as before
  (DebugView says `H.264 failed (...)`). Capture rate while playing is 30 fps with H.264 and 15 fps with JPEG only.
- **Switches** (environment variable, set before starting Premiere): `OPEN_TETHERY_H264=0` JPEG only,
  `OPEN_TETHERY_H264=sw` never use a hardware encoder.

## Audio (push audio)

Premiere's Transmit interface treats a plug-in as an audio *clock device* only
if it implements a playback clock. We do not: your normal speakers stay the
clock ("primary") device and Pocket Monitor is an extra, mirrored ("secondary")
output that Premiere *pushes* a copy of the mix to (`PushAudio`, Transmit
interface version 4). So:

1. **Preferences > Playback > Audio Device**: leave your normal output (speakers
   or headphones) selected. Do not try to select Pocket Monitor as the main device.
2. In the same Preferences > Playback page, in the Audio/Video device lists, tick
   **Pocket Monitor (phone preview)** for **audio** as well as for video (it appears as
   an additional output with channels "Pocket Monitor L" / "Pocket Monitor R"). Wording and
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
  takes at most 30 frames a second (15 in JPEG-only mode); when paused or
  scrubbing it takes every frame so the newest always wins. The worker thread
  encodes H.264 (see above) and, when wanted, box-downscales to at most 1280 px
  on the long edge, encodes JPEG at quality 0.8 and sends.
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
  retried 2 s later. Premiere's thread never touches the socket. The worker
  also reads helper messages (type 64 keyframe request, 65 JPEG wanted) from the
  same socket without blocking; unknown types are skipped.
- **Logs:** `[PocketMonitor] ...` lines via `OutputDebugString` (view with
  Sysinternals DebugView). No files are written.

## Tests (no Windows needed)

```sh
native/transmit/test/run.sh                       # g++ unit tests + OTX golden bytes parsed by helper/lib/otx1.js
SDK_HEADERS=/path/to/Headers native/transmit/test/run.sh   # also a mingw-w64 syntax check of the plug-in sources
```

Covers float to int16/downmix, the audio queue (chunking, overflow, seeks, threads), OTX message serialisation
(C++ writes bytes, node parses them with the helper's real parser), the helper-to-plugin reader, BGRA to NV12,
size fitting/scaling and the Annex B SPS/PPS logic. The Media Foundation, socket and Premiere calls cannot run on
Linux; they are only syntax-checked (mingw-w64) and need the PC test below.

## Needs PC test (video, H.264)

1. Build succeeds with the exact MSBuild command above (new libs: mfplat, mf, mfuuid, strmiids, wmcodecdspuuid).
2. DebugView shows `H.264 encoder ready: 1920x1080, ... hardware|software, async|sync` after the first frame with the
   relay running, then `first H.264 access unit sent`. Note which of hardware/software it picked on your GPU.
3. The phone switches to H.264/WebRTC and the picture is smooth at 30 fps with low delay (expect < 300 ms).
4. Colours match Premiere (BT.709: no washed-out or crushed picture) on the phone.
5. Pause: the picture stays alive (a re-encoded AU at least every 0.7 s); a phone joining while paused gets a picture
   within about a second (keyframe on request).
6. Scrub and play 4K and vertical sequences: no crash, picture is fit inside 1920x1080 / 1080x1920.
7. Change sequence resolution while connected: encoder re-inits, a keyframe follows, phone recovers.
8. `OPEN_TETHERY_H264=0` gives the old JPEG-only behaviour; `=sw` forces the software encoder. If `H.264 failed (...)`
   shows up in DebugView, send us that line (it names the failing stage).
9. Profile check: the SPS should say profile_idc 66 (constrained baseline `42e0xx`). Microsoft's software encoder may
   write `42c0xx` or `4200xx`; browsers decode all of these, but tell us what the helper log shows.
10. Premiere stays responsive (no frame-time hit) with H.264 on, at 1080p and 4K.

## Unverified assumptions about the SDK / Media Foundation

- `outAudioAvailable = true` + `outClockAvailable = false` + `outPushAudioAvailable = true` is accepted by Premiere and
  yields an audio tick that triggers push audio (the header only says push is a secondary mode and that "audio transmit
  plug-ins must also implement a clock"; we deliberately do not). Fallback switch: `OPEN_TETHERY_AUDIO=push`.
- `outSamplesPerFrame` is left untouched (host default); `PushAudio` accepts any buffer length up to 16 channels.
- `inTime` of `PushAudio` is the media time of the first sample in host ticks (converted to 254016000000/s).
- `tmAudioMode::outMaxBufferSize = 8192` and `outLatency = 0` are acceptable.
- PrSDKStringSuite version 1 is available through SPBasic to allocate the "Pocket Monitor L/R" output names.
- After Effects is recognised by `AfterFX` in the host executable path.
- Hardware H.264 MFTs accept system-memory NV12 (no D3D manager) and `MF_MT_MPEG2_PROFILE = ConstrainedBase`; if not, it
  retries with Base profile, then software.
- The encoder's `MF_MT_MPEG_SEQUENCE_HEADER` or first IDR contains SPS/PPS in Annex B; if neither does, the keyframe is
  sent without them (the helper then cannot start a phone on it).

## Needs PC test (audio)

- The plug-in shows up with an audio option in Preferences > Playback, and ticking it makes Premiere call `StartPushAudio`
  (DebugView: `push audio started`). If no audio entry appears, try `OPEN_TETHERY_AUDIO=push`.
- Sound reaches the phone in time with the picture; speakers still play normally. Check lip-sync; if the phone is
  consistently early/late, tell us by how many ms (the helper/viewer can add an offset).
- Seeking/looping while playing causes no clicks that last more than a moment (queue starts a new segment on a time jump).
- Premiere does not hang or stutter when the helper is not running (audio is dropped, not buffered).
