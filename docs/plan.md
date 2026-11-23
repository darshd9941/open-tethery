> Superseded by [PRODUCT-PLAN.md](PRODUCT-PLAN.md) (23 Nov 2026). Kept for history.

# Open Tethery: assessment and build plan

Prepared 23 Nov 2026. Read-only review of `E:\premiere-live-stream`, `E:\screen live video`
and `E:\screen live`, plus the public site tethery.app. No code folders were changed.

Goal: an original tool (own name, own design, no Tethery code, text or assets) that shows
a QR code inside Premiere Pro / After Effects; scanning it on any phone, tablet or laptop on
the same network shows the editor's output live, including real-time playback.

---

## 1. What the three folders are

| Folder | What it is | State |
|---|---|---|
| `E:\screen live` | **Photoshop** live preview. UXP panel (`plugin/`, manifest v5, PS 24.4+) grabs canvas pixels with the Imaging API, encodes ICC-tagged JPEG, sends over WebSocket to a Node relay (`relay/server.js`, `ws`), which serves a phone PWA viewer (`viewer/`). Has a build plan, test tools (`tools/mock-plugin.js`, `test-viewer.js`, `test-session.js`, `screenshot.js`) and screenshots in `build/`. | **Working and most mature.** Relay log shows 3 real phones (192.168.1.x) connected to one session; token auth, session expiry, firewall helper, colour pipeline, packaging notes. |
| `E:\screen live video` | Same relay/viewer design ported to **Premiere Pro + After Effects** via a **CEP** panel (`extension/`, CSXS 9, PPRO 14+ / AEFT 17+) with ExtendScript (`host/host.jsx`). Polls a timeline signature every 250 ms; when the playhead stops, exports **one still PNG** of the current frame and sends it. Viewer adds 9:16 / 4:5 / 1:1 / title-safe guides and timecode. | **Partly working, still frames only.** Relay log shows the panel registering from Premiere, but no evidence a Premiere frame reached a phone. Capture is fragile (see below). |
| `E:\premiere-live-stream` | Native C++ **Mercury Transmit** plugin attempt. Contains the Premiere Pro 27.0 C++ SDK (zip + unpacked) and `Transmitter/`, which is Adobe's sample transmitter essentially unmodified. README says "scaffold only". | **Not started in practice.** `x64/Debug/.../unsuccessfulbuild` shows the only build failed. `PushVideo` receives frames and throws them away; audio, encoding and networking are all stubs. |

### Overlaps
- The two "screen live" folders share the same architecture (panel â†’ `ws://127.0.0.1:<port>/ws` â†’ Node relay â†’ LAN viewer) and near-identical `relay/`, `viewer/`, `icc.js`, firewall `.bat`, `config.json`. They have already diverged:
  - `screen live` has the better **relay** (681 lines: session expiry, stricter handshake, payload limits) and better **viewer** core (726 lines), plus all the test tools and a `.gitignore`.
  - `screen live video` has the **video-specific** viewer extras (aspect guides, timecode/sequence HUD) and the Pr/AE panel.
- None of the three is under git.

### Problems in `screen live video` capture (why it can't become real-time)
- `host.jsx` uses `exportAsMediaDirect` with a **hard-coded Premiere 2026 preset path** (`...Adobe Premiere Pro 2026\MediaIO\systempresets\...PNG Sequence (Match Source).epr`), so other versions fail.
- It **changes the user's In/Out points** to export one frame and never restores them; it may also reopen the sequence.
- One export per frame takes hundreds of ms to seconds, so it can only ever show a still after you stop scrubbing. **Playback, audio and smooth scrubbing are impossible on this path.**
- Fixed temp filenames, PNG (large), base64 over WebSocket.

ExtendScript/CEP is fine for the **control panel**, but the **pixels must come from a Mercury Transmit plugin**. That is the supported API that receives every frame Premiere and After Effects render during playback and scrubbing, plus the audio mix in Premiere. Tethery's own note that "After Effects does not stream sound yet" matches what Transmit offers (AE has video transmit, no audio), which strongly suggests it uses the same route.

---

## 2. Target feature set (from tethery.app, public site)

| Tethery feature | Ours today |
|---|---|
| QR pairing + short 4-character code, lockout after wrong guesses, ending session kicks all viewers | QR + 128-bit token in URL hash; new Start invalidates old token. No short code, no lockout. |
| **Real-time playback**: colour, effects, titles, trims stream live while playing | âŒ Still frame after pause only (Pr/AE). |
| Up to 4K playback, stats HUD (resolution, fps, bitrate, connection) | âŒ Stills; HUD shows timecode/name/resolution only. |
| **Audio** through the phone speaker (Premiere only) | âŒ |
| Multiple devices at once, all follow the playhead | âœ… Relay broadcasts to many viewers (tested with 3 phones in the Photoshop version). |
| Any browser, nothing to install (iPhone, iPad, Android, laptop) | âœ… PWA viewer, wake lock, pinch/zoom, 1:1. |
| Accurate colour: stream labelled Rec. 709, guidance to turn off True Tone etc. | âœ… for stills (sRGB / P3 ICC injection). Video will need Rec. 709 tagging instead. |
| Overlays: grid, guides, **live scopes** | Partial: 9:16, 4:5, 1:1, title-safe guides. No grid or scopes. |
| **Social previews**: frame inside Instagram/TikTok/YouTube/etc. UI at true size | âŒ (must be our own drawn mock-ups, not copied platform assets). |
| Frame export (save a still on the phone) | âŒ (easy). |
| Device notifications | âŒ |
| Wi-Fi, hotspot, cable (USB tether), VPN/Tailscale; optional online link | LAN + hotspot work; no cable guide, no remote link. |
| Encrypted "like a video call", frames never touch a server | âŒ Plain HTTP + WebSocket on LAN. WebRTC gives this for free. |
| Licensing, 2 seats, Mac + Windows, Premiere/AE 2025+ | âŒ Windows only, unpackaged dev install (PlayerDebugMode). |

**Overall progress vs. target: roughly 25-30%.** Pairing, relay, multi-viewer and the phone viewer UX are solid and reusable. The hard core of the product (native frame capture during playback, video encoding, low-latency transport, audio) is at 0%.

---

## 3. Recommended architecture

```
Premiere Pro / After Effects
 â”œâ”€ Control panel (UXP in Premiere 25+, CEP for AE until its UXP is ready)
 â”‚    Start/Stop, QR + 4-char code, viewer list, quality, audio toggle
 â”‚    talks to the helper over ws://127.0.0.1:<port>/control
 â””â”€ Native Mercury Transmit plugin (C++, thin)          â† frames + audio
      PushVideo: PPix â†’ downscale + convert (BGRA / NV12)
      PushAudio: float PCM 48 kHz stereo (Premiere only)
      â†’ localhost socket / shared memory â†’ helper
                â”‚
Helper process (separate process, so a crash never takes down Premiere)
   Phase 1: the existing Node relay  Â·  later: optional native binary
   - H.264 hardware encode (NVENC / QuickSync / AMF via Media Foundation on Windows,
     VideoToolbox on Mac), Opus audio
   - WebRTC (DTLS-SRTP, encrypted) via node-datachannel / libdatachannel
   - HTTP: serves viewer page + signaling, QR/code pairing, lockout
   - Fallback transport: JPEG frames over WebSocket (what exists today)
                â”‚  LAN / hotspot / USB tether / Tailscale
Phone viewer (static web page, no install)
   <video> fed by the WebRTC track (hardware H.264 decode, jitter buffer, A/V sync)
   overlays (guides, grid, scopes on a canvas), social-preview frames, stats HUD
```

Key decisions and why:
1. **Mercury Transmit for pixels**, never screen capture or per-frame export. It gets every rendered frame in playback and scrub with no side effects on the user's project, in both Pr and AE.
2. **Keep the native plugin thin.** It only copies frames and audio out. Encoding, networking and pairing live in the helper. This keeps the C++ small, keeps Premiere stable, and reuses the existing Node relay.
3. **WebRTC as the main transport.** It should work from a plain `http://192.168.x.x` page (WebCodecs needs a secure context, so it is a poor fit for a LAN IP page), uses the phone's hardware decoder, handles audio sync and jitter, and is encrypted. Signaling runs over the existing WebSocket. *Verify on iPhone Safari and Android Chrome in the Phase 2 spike.*
4. **JPEG-over-WebSocket stays as the fallback** (paused frame, weak devices, debugging). It already works.
5. **Colour:** tag the H.264 stream as BT.709 (VUI primaries/transfer/matrix); keep full-quality ICC stills for frame export and paused-frame detail.
6. **Panel tech:** Premiere 25+ supports UXP; AE UXP status must be checked. Build one web UI that runs in CEP (AE) and UXP (Pr), since it only talks to the helper over WebSocket.

---

## 4. Which folder to consolidate into

**Consolidate into `E:\premiere-live-stream`**, restructured as one git repo (rename later if you like). It already holds the Premiere 27.0 SDK and the Transmitter project, which become the product's core. Copy the other pieces in and leave the two old folders untouched as reference:

```
E:\premiere-live-stream\
  native\transmit\      â† from Transmitter\ (rewritten)
  sdk\                  â† stays, git-ignored (Adobe SDK licence: don't commit/redistribute)
  relay\                â† from "screen live"\relay (the more mature one) + Pr/AE bits
  viewer\               â† "screen live"\viewer core + guides/timecode from "screen live video"
  panel\cep\            â† from "screen live video"\extension (export-based capture removed)
  panel\uxp\            â† new, later
  photoshop\            â† "screen live"\plugin, kept working as a bonus
  tools\                â† "screen live"\tools test scripts
  docs\
```

---

## 5. Phased execution plan

Model tiers follow your preference: **Opus** = plan, design, review, hard debugging;
**Sonnet** = write code from a clear brief; **Haiku** = file sweeps, copying/merging, running tests, docs.

### Phase 0: Consolidate (half a day)
| Task | Model |
|---|---|
| `git init` in `E:\premiere-live-stream`, `.gitignore` (sdk/, the SDK zip, x64/, node_modules, logs, build/) | Haiku |
| Copy relay/viewer/tools from `screen live`, panel from `screen live video`, per Â§4 | Haiku |
| Merge the two viewers (port guides + timecode HUD into the `screen live` viewer) and the relay differences | Sonnet (Opus reviews the diff) |
| Run `tools/test-viewer.js` / `mock-plugin.js` against the merged relay; report pass/fail | Haiku |

**Done when:** one repo; mock plugin â†’ relay â†’ phone viewer works with guides and timecode.

### Phase 1: Native transmit plugin that delivers frames (2-4 days, highest risk)
| Task | Model |
|---|---|
| Get the SDK Transmitter sample to **build and load** in Premiere 2026 (VS 2022 x64, SDK include paths, `.prm` into the MediaCore plug-ins folder) and appear under Preferences > Playback | Opus guides, Sonnet edits the project; Haiku reads build logs |
| In `PushVideo`: read the PPix via the PPix suite, scale to â‰¤1280 px BGRA, put the latest frame in a ring buffer (drop old frames, never block Premiere's thread) | Sonnet from an Opus brief |
| Send frames to the helper over a localhost socket (length-prefixed). First as **JPEG** (WIC or libjpeg-turbo) so today's relay and viewer show it unchanged | Sonnet |
| Load the same build in After Effects (Preferences > Video Preview) | Sonnet; Opus debugs host differences |

**Done when:** pressing play in Premiere shows moving video on the phone (even 10-15 fps JPEG), scrubbing follows, and Premiere stays stable for 30 minutes. This alone beats the current still-frame path.

### Phase 2: Real video transport (3-5 days)
| Task | Model |
|---|---|
| **Spike first:** minimal WebRTC page served over `http://<LAN-IP>` playing a test H.264 stream on iPhone Safari + Android Chrome. Choose node-datachannel (in the Node relay) vs libdatachannel (native helper) | Opus decides; Sonnet builds the spike |
| Hardware H.264 encode in the helper (low latency, no B-frames, keyframe when a viewer joins or on seek), BT.709 tags | Sonnet; Opus reviews latency settings |
| WebRTC signaling over the existing WebSocket; viewer switches to `<video>`; JPEG path kept for paused frames | Sonnet |
| Adaptive quality: 720p default, 1080p, up to 4K on strong Wi-Fi; per-viewer bitrate from WebRTC stats | Sonnet |
| Stats HUD (resolution, fps, bitrate, connection) | Sonnet |

**Done when:** 1080p playback on the phone, under ~200 ms delay on home Wi-Fi, 3 phones at once, colours within a few levels of Premiere on a test chart.

### Phase 3: Audio in Premiere (1-2 days)
| Task | Model |
|---|---|
| Implement the `PushAudio`/clock path and forward 48 kHz stereo PCM to the helper | Sonnet |
| Opus encode + WebRTC audio track; "tap for sound" button (mobile autoplay rules) | Sonnet |
| A/V sync check with a clap/flash test sequence | Haiku runs it; Opus judges |

**Done when:** timeline audio plays from the phone speaker in sync during playback.

### Phase 4: Pairing, security, panel UX (2 days)
| Task | Model |
|---|---|
| Short 4-character session code next to the QR; lockout after N wrong guesses per device; End Session disconnects everyone | Sonnet; Opus reviews security |
| New control panel (shared HTML for CEP now, UXP later): QR, code, viewer list with kick, quality/audio toggles, Copy link, status. Remove the old `exportAsMediaDirect` capture entirely | Sonnet |
| Plain-language connection help: same Wi-Fi, guest-network isolation, hotspot, USB tether, Tailscale | Haiku drafts, Opus edits |

**Done when:** a non-technical user can start, scan, and fix "phone can't connect" from the panel alone.

### Phase 5: Viewer features (3-5 days)
| Task | Model |
|---|---|
| Overlays: rule-of-thirds grid, custom guides, safe areas (partly there) | Sonnet |
| Live scopes on the phone (waveform, vectorscope, histogram) from a downscaled frame in canvas/WebGL | Sonnet; Opus reviews the maths |
| Social previews: **our own drawn** generic overlays at each platform's real safe-zone sizes (no copied logos or assets), editable account name/avatar | Sonnet; Opus design review |
| Frame export (save the current frame as full-quality PNG on the phone) | Sonnet |
| Notifications (Web Push needs HTTPS, so may be limited on LAN; verify) | Opus decides scope |

### Phase 6: Packaging and cross-platform (3-5 days)
| Task | Model |
|---|---|
| Windows installer: `.prm` into `Common\Plug-ins\7.0\MediaCore`, signed panel (ZXP / `.ccx`, no PlayerDebugMode), helper as a bundled exe, firewall rule | Sonnet; Haiku writes docs |
| macOS build: `Transmitter/Mac` Xcode project already exists; VideoToolbox encoder; notarisation | Sonnet; Opus for signing issues |
| Later, optional: remote link through a small signaling server of your own (frames stay peer-to-peer), licensing | Opus designs first |

### Phase 7: Test and harden (ongoing)
- Matrix: Premiere 2025/2026, AE 2025/2026; iPhone Safari, iPad, Android Chrome (check its "Local network access" permission), desktop Chrome.
- 2-hour playback soak; the plugin must never block or crash the host. (Haiku runs and reports; Opus triages.)

---

## 6. Risks to check early
1. **Transmit plugin loading in Premiere 2026 / AE 2026** with the 27.0 SDK (the only build so far failed). Phase 1 starts here.
2. **WebRTC from a plain HTTP LAN page on iOS Safari.** If blocked: self-signed HTTPS with a one-time trust step, or fMP4 over WebSocket into `ManagedMediaSource` (iOS 17.1+).
3. Frame cost at 4K: conversion and encode must stay off Premiere's render thread; drop frames rather than stall.
4. AE has no audio through Transmit; say so in the UI.
5. Adobe SDK licence: don't commit or redistribute the SDK itself.
6. Originality: own name, UI, copy and social-preview art; Tethery is a feature reference only.

## 7. Suggested first step
Phase 0 plus the first task of Phase 1 (get the sample Transmitter building and selectable in Premiere). If it loads, the rest is engineering; if it doesn't, we find out on day one.

