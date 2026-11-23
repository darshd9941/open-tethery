# Open Tethery: product plan (v2)

Date: 23 Nov 2026. Status: **waiting for approval. Nothing below is built yet
unless it says "exists".** This replaces `docs/plan.md` (kept for history).

## 0. What we are building, in one paragraph

A tool for Premiere Pro, After Effects and Photoshop. You open a panel inside
the Adobe app, it shows a QR code, you scan it with your phone, and the phone
shows exactly what the Program Monitor (or the Photoshop canvas) shows, live,
including playback and sound. On the phone you can turn on social media
frames (Instagram, YouTube, TikTok, X and more), a histogram and exposure
helpers, and you can play, pause and step through the timeline from the phone.
It is our own code, our own name and our own look. Nothing is copied from
Tethery or from Adobe's confidential samples.

## 1. Lessons from the last round (why this plan is different)

| What went wrong | What this plan does instead |
|---|---|
| The plugin was "installed" but invisible. A Transmit plugin only shows up under Preferences > Playback, which nobody would guess. | The product is a **panel** you open from the Window menu. The Transmit plugin is a hidden engine behind it. The panel tells you, in plain words, whether the engine is switched on, and shows the exact two clicks to switch it on if not. |
| You did not know where the QR code would appear. | The QR code is always in the panel, big, in the middle. Every milestone below says exactly where to look. |
| You were asked to run install commands. | **One installer** (double-click, say Yes once to Windows) puts everything in place. During development I (Claude) run every build, install and test on this PC myself. I only ask you for things that need your hands: clicking inside Premiere, pressing play, scanning with your phone. |
| Progress was hard to judge. | Each milestone ends with something you can see on your phone, plus an automatic test I run first so you are never the first tester. |

**Name.** "Open Tethery" contains the other product's name. Before we ship to
anyone else we should pick our own name (see Questions). Inside this plan it
stays "Open Tethery".

## 2. Feature map: Tethery vs. us

Source: tethery.app home, pricing, help pages (read 23 Nov 2026).
Legend: ✅ exists and works · 🟡 partly exists · ❌ missing · ➕ you asked for it.

| Area | Tethery | Us today | Milestone |
|---|---|---|---|
| **Apps** | Premiere Pro + After Effects 2025+ | Photoshop: ✅ working (UXP panel + relay). Premiere/AE: 🟡 still-frame CEP panel; Transmit plugin built and installed, never confirmed on a phone | M0–M2 |
| Photoshop support ➕ | no | ✅ working, separate code | M0 (merge into one product) |
| Windows / Mac | both | Windows only | Windows now, Mac later (M9) |
| **Install** | one installer: plug-in + panel + helper | three .bat files, manual steps | M0 |
| Panel in Window menu | Window > Extensions > Tethery | 🟡 old "Live Video Preview" CEP panel, hard to find | M0 |
| **Pairing** | QR with 4-letter code, typed code, new code each session | 🟡 QR + long secret token | M0 (QR), M6 (code) |
| Wrong-code lockout, End session, kick | yes | ❌ | M6 |
| Invite another device from phone | yes | ❌ | M6 |
| **Picture** | live playback, Program Monitor, up to 4K | 🟡 stills only (Pr/AE), live canvas (PS) | M1 (smooth), M2 (sharp, fast) |
| Low delay video (WebRTC, H.264) | yes, encrypted | ❌ (JPEG over WebSocket) | M2 |
| Colour accurate, Rec. 709 | yes | ✅ ICC tagging for stills | M2 (for video) |
| Several phones at once | yes | ✅ broadcast to many | keep |
| **Sound** | Premiere only, tap to start, sync offset | ❌ | M3 |
| **Phone viewer** | web page, Home Screen app, no store | ✅ PWA, pinch-zoom, pan, fit | keep |
| Tap panel: audio, overlays, save frame, share, full screen | yes | 🟡 some buttons | M4 |
| Stats readout (fps, size, bitrate, delay, viewers) | yes | ❌ | M4 |
| **Overlays** | | | |
| Timecode, sequence name, play state | yes | ✅ timecode + name | keep |
| Safe zones, thirds, centre mark, grid, guides, letterbox | yes | 🟡 9:16 / 4:5 / 1:1 crop guides, title safe | M4 |
| Social media frames ➕ (Instagram Reels/Feed/Story, YouTube + Shorts, TikTok, X, Facebook, Snapchat, Pinterest, Reddit) | yes | ❌ | M4 |
| Histogram ➕ (luma, RGB, parade) | yes | ❌ | M4 |
| Waveform, vectorscope | yes | ❌ | M4 |
| Exposure helpers ➕ (false colour, zebras for clipped highlights) | not listed | ❌ | M4 (we go beyond Tethery here) |
| Audio meters | yes | ❌ | M4 (after M3) |
| Overlays draggable | yes | ❌ | M4 |
| Save frame (clean or with overlays) | yes | ❌ | M4 |
| **Playback control from phone** ➕ (play/pause, step frame, jump, scrub bar) | not listed | ❌ | M5 (beyond Tethery) |
| Switch between Premiere / AE / Photoshop session on the phone | Pr ↔ AE | ❌ | M5 |
| **Connections** | Wi-Fi, Ethernet, hotspot, USB tether, Tailscale, direct cable, "Online" link via their server | ✅ Wi-Fi only | M7 (local ways), online link optional later |
| Firewall rule set up for you | asks Windows on first run | 🟡 separate admin .bat | M0 |
| Notifications when a session starts | yes (needs online link) | ❌ | later, optional |
| "Send a report" diagnostics | yes | ❌ | M7 |
| **Business** | free tier (watermark, 1080p, 1 device) + paid licence, 2 seats | n/a | only if you want to sell (Questions) |

## 3. Where the existing code fits

| Exists | Path | Keep / change |
|---|---|---|
| Photoshop UXP panel (works) | `apps/photoshop/plugin` | Keep logic, restyle to the shared panel look, talk to the shared helper |
| Photoshop relay + viewer (works, 3 real phones seen) | `apps/photoshop/relay`, `viewer` | Becomes the base of the shared **Helper** and shared **Viewer** |
| Premiere/AE CEP panel (stills) | `apps/premiere-ae/extension` | Rebuilt as the new "Open Tethery" panel (QR + status + engine check). Still-frame export code is retired. |
| Premiere/AE relay + Transmit ingest (OTX1, tested with a fake sender) | `apps/premiere-ae/relay` | Merged into the shared Helper |
| Native Transmit plugin (built, installed to MediaCore\OpenTethery, never seen working on a phone) | `native/transmit` | Keep. First job of M1 is proving it. Later gains H.264 and audio. |
| Old CEP extension `com.screenlive.video` installed in `%APPDATA%\Adobe\CEP\extensions` | — | Replaced by the new panel in M0 so you never see two similar panels |

## 4. Architecture

```
  Premiere Pro / After Effects                Photoshop
  ┌──────────────────────────────┐            ┌──────────────────────┐
  │ Open Tethery panel (CEP)     │            │ Open Tethery panel   │
  │  QR code, status, settings   │            │ (UXP), same look     │
  │  playback commands (Pr/AE)   │            │ sends canvas pixels  │
  ├──────────────────────────────┤            └──────────┬───────────┘
  │ Transmit plugin (C++, hidden)│                       │ WebSocket
  │  Program Monitor frames      │                       │
  │  + timeline audio (Pr)       │                       │
  │  H.264 via Windows' built-in │                       │
  │  hardware encoder            │                       │
  └──────────────┬───────────────┘                       │
                 │ local TCP (OTX protocol)              │
                 ▼                                       ▼
        ┌────────────────────────────────────────────────────┐
        │ Open Tethery Helper (one small background program, │
        │ starts with Windows, uses almost nothing when idle)│
        │  sessions + codes · WebRTC to phones · JPEG fallback│
        │  serves the phone web page · firewall-friendly      │
        └───────────────────────┬────────────────────────────┘
                                │ same Wi-Fi (or hotspot / cable / Tailscale)
                                ▼
                 Phone / tablet / laptop browser (no app install)
                 picture, sound, overlays, scopes, playback buttons
```

Key decisions (Opus):

1. **Panel = CEP for Premiere and After Effects.** CEP is still present in
   Premiere/AE 2027 on this PC (other CEP panels are installed and debug mode
   is on), it is what Tethery uses (Window > Extensions), and it can start
   programs and talk to the helper. Photoshop keeps UXP, because that is what
   already works there. A Premiere UXP panel is a later option once Adobe's
   UXP for Premiere is mature; the panel web code is shared so switching is cheap.
2. **Pixels only from Transmit** in Premiere/AE (never screen capture, never
   per-frame export). Photoshop reads the canvas through its imaging API (works).
3. **Encoding inside the plugin's worker thread** with Windows Media
   Foundation (built into Windows, uses the GPU encoder, no downloads). The
   helper only forwards packets, so it stays small JavaScript.
4. **WebRTC to the phone**, JPEG over WebSocket kept as automatic fallback.
5. **Scopes and social frames are drawn on the phone**, from the decoded
   picture (WebGL). The PC does no extra work and the stream stays clean.
6. **Playback control** goes phone → helper → panel → Premiere. First choice:
   the Premiere scripting API inside the panel (play, stop, set playhead).
   Backup: the SDK's Control Surface transport interface (native, headers are
   in the SDK we have). After Effects: play/stop/jump through its scripting API;
   frame-accurate scrubbing in AE may be limited (see Risks).
7. **Helper is one .exe** built with Node's built-in "single executable"
   feature (Node 22 is already on this PC), so you never need Node yourself.
8. **Installer**: a single `OpenTetherySetup.exe`. It closes the Adobe apps if
   you agree, copies the plugin, both panels and the helper, adds the firewall
   rule and the Windows start-up entry, and has an uninstaller. Until the real
   installer exists (M8), I install builds myself on this PC.
9. **Social frames are our own drawings** (outlines of where each app puts
   its buttons, captions and profile bar), not screenshots or logos copied
   from those apps.

## 5. How we work (and who does what)

- **Opus (me, planner/reviewer):** this plan, design decisions, task briefs,
  reviewing every change, hard debugging, anything that touches install
  paths, admin rights or the native plugin's threading.
- **Sonnet (builder):** writes the code from my briefs: panels, helper, viewer,
  overlays, plugin features, tests.
- **Haiku (scout):** finds things in code, runs builds and tests, reads logs,
  updates docs.
- **I do on this PC:** every build (MSBuild, npm), every install (I ask Windows
  for admin once per install), automatic tests with a fake Premiere and a
  headless phone browser, screenshots of the phone page.
- **You do (only what needs your hands):** open the panel in the Adobe app,
  press play, scan the QR with your phone, tell me what you see. Each request
  comes with exact click-by-click steps.

Each task below is tagged **[Opus]**, **[Sonnet]** or **[Haiku]**.

## 6. Milestones

Every milestone has: what you will see, the tasks, my automatic checks, and
your hands-on check (usually 2 minutes).

### M0. A panel you can find, with the QR code in it

**You will see:** In Premiere Pro: **Window > Extensions > Open Tethery**. A
panel opens with a big QR code and a status line. Same panel in After Effects
(**Window > Extensions > Open Tethery**) and Photoshop (**Plugins > Open
Tethery**). Scan the QR and your phone shows a "Connected, waiting for
picture" screen with your PC's name.

Tasks:
- [Opus] Merge plan: one `helper/`, one `viewer/`, one `panels/cep`, one `panels/uxp-photoshop`. Write briefs.
- [Haiku] Move files into the new layout, fix paths, keep git history.
- [Sonnet] Shared Helper: merge the two relays (sessions, QR URL, Transmit ingest, Photoshop ingest) into one process, one port.
- [Sonnet] New CEP panel: starts the Helper if it is not running, shows QR + status: "Helper running", "Premiere engine: on/off", "Phones connected: N". If the engine is off it shows the two exact clicks (Edit > Preferences > Playback, tick "Open Tethery"). Panel reports "panel opened" to the Helper log so I can confirm it loaded without seeing your screen.
- [Sonnet] Photoshop panel restyled to match, pointing at the shared Helper.
- [Sonnet] Dev install script that I run: copies panel, plugin, helper; adds firewall rule and start-up entry; removes the old `com.screenlive.video` panel.
- [Haiku] Run all tests, report.

Automatic checks (me): Helper starts; panel page loads in a headless browser and shows a QR; headless "phone" scans the URL and gets "waiting for picture"; install script leaves files in all expected folders; manifest version range covers Premiere/AE 2027.

Your check: open the panel from the Window menu, scan, confirm the phone says connected. Photoshop: open the panel and confirm the canvas appears on the phone (this already works today, so it should keep working).

### M1. Premiere playback reaches the phone (smooth, not yet sharp)

**You will see:** Press space in Premiere, and the phone plays along at about
15 frames a second, a bit soft. Scrubbing follows. The panel says
"Premiere engine: on, sending".

Tasks:
- [Opus] Review the Transmit plugin against the SDK docs (startup, which callbacks, threading) before you ever test it.
- [Sonnet] Plugin writes a small status file / log line the panel can read (loaded, enabled, frames sent), so we can tell "not loaded" from "loaded but switched off".
- [Sonnet] After Effects: same plugin registered for AE's Mercury Transmit (video only).
- [Haiku] Build, install, run the fake-Premiere test, check the plugin exports.

Automatic checks: plugin builds; export table correct; fake sender → helper → headless phone shows moving frames; 30-minute soak with the fake sender, no memory growth.

Your check: in Premiere, Edit > Preferences > Playback, tick "Open Tethery" (one time only), press play, watch the phone. Same in AE (Edit > Preferences > Video).

### M2. Sharp, fast picture (WebRTC + H.264)

**You will see:** Full HD on the phone, smooth at the sequence frame rate,
delay you barely notice (target under 0.2 s on home Wi-Fi), colours match
the Program Monitor. Three phones at once is fine.

Tasks:
- [Opus] Pick encoder settings (low-delay H.264, BT.709 tags), WebRTC library for the Helper, fallback rules.
- [Sonnet] Plugin: Media Foundation H.264 hardware encode on the worker thread; new OTX message type for video packets.
- [Sonnet] Helper: WebRTC sessions per phone, forwards packets; automatic fallback to JPEG.
- [Sonnet] Viewer: WebRTC player, reconnect, fallback.
- [Haiku] Colour test chart, latency test (timecode burned in vs. phone clock), report.

Automatic checks: headless phone receives H.264 over WebRTC; measured delay on loopback; colour chart levels within ±3; fallback kicks in when WebRTC is blocked.

Your check: play a clip with fast motion; compare phone and monitor side by side; try with 2–3 devices.

### M3. Sound (Premiere)

**You will see:** An Audio button on the phone. Tap it and you hear the
timeline, in step with the picture. After Effects shows "no sound from After
Effects" (Adobe does not send AE audio to plugins).

Tasks: [Sonnet] plugin audio callback → Opus encoding → WebRTC audio track; [Sonnet] viewer audio button + sync offset slider; [Haiku] sync test with a beep-and-flash clip.

Your check: play a clip with speech; the phone sound matches lips.

### M4. Overlays, social frames, scopes, exposure, save frame

**You will see:** Tap the picture, then **Overlays**. A grid of tiles:
- **Social frames:** Instagram Reels / Feed / Story, YouTube (normal + Shorts), TikTok, X, Facebook, Snapchat, Pinterest, Reddit. Each draws that app's button, caption and profile areas over your video, so you can see if text or faces get covered. Optional your handle and picture.
- **Exposure:** histogram (luma / RGB / parade), false colour, zebras for clipped highlights.
- **Scopes:** waveform, vectorscope with skin-tone line. Three sizes, drag anywhere.
- **Guides:** safe zones, thirds, centre mark, custom grid, letterbox (2.39, 1.85, etc.).
- **Info:** timecode, sequence name, play state, frame rate, stats (size, fps, bitrate, delay, viewers).
- **Save frame:** clean, or with overlays, named by sequence and timecode.

Tasks:
- [Opus] Overlay data format (one JSON file per social platform describing its zones, so adding a platform is a data change, not code); scope maths review.
- [Sonnet] WebGL scopes from the live picture; overlay tiles and drag; social frame drawings; save frame.
- [Haiku] Screenshot every overlay on a phone-size headless browser, check nothing overlaps or is cut off.

Automatic checks: scopes on a known test pattern give the right shape (bars on the vectorscope land on the targets); every social frame screenshot matches its spec; save-frame file is produced.

Your check: open three or four overlays on a real clip and tell me if anything looks wrong or is missing.

### M5. Control playback from the phone

**You will see:** A slim bar at the bottom of the phone: play/pause, one
frame back/forward, jump 5 s, and a scrub bar with the current timecode.
Premiere follows instantly. Swipe or tap the app name to switch between
Premiere, After Effects and Photoshop if more than one is open.

Tasks:
- [Opus] Choose the control path (scripting API first, Control Surface backup) after a quick test of both; decide what AE can and cannot do.
- [Sonnet] Panel: control commands; Helper: command channel with permission (only phones in the session, and a "allow control" switch in the panel); Viewer: transport bar.
- [Haiku] Test that commands from a phone without the code are rejected.

Your check: press play/pause and step frames from the phone; confirm Premiere follows.

### M6. Pairing and safety

**You will see:** The panel shows a 4-letter code under the QR. A phone can
type the code instead of scanning. Wrong guesses lock that phone out. "End
session" disconnects everyone. You can remove one phone. "Share" on a phone
shows a QR to invite another device. "Allow control from phones" switch.

Tasks: [Sonnet] codes, lockout, kick, share; [Opus] security review (codes expire, nothing reachable without a code, the panel-only pages only answer this PC); [Haiku] brute-force test.

### M7. Other ways to connect + diagnostics

**You will see:** A "Connection" list in the panel: Wi-Fi, Ethernet,
Phone hotspot, USB cable (iPhone / Android), Tailscale. Picking one shows the
right address and short steps. A "Send report" button saves a log bundle to
a folder (nothing is uploaded).

Tasks: [Sonnet] address detection per network adapter, panel list, report bundle; [Haiku] write the help text; [Opus] review.

### M8. Real installer and updates

**You will see:** `OpenTetherySetup.exe`. Double-click, Yes once, done. Start
menu has "Uninstall Open Tethery". Panel shows "update available" when there is one.

Tasks: [Opus] choose installer tool (needs a one-time download of an installer
builder, I will ask first); [Sonnet] installer script, uninstaller, version
check; [Haiku] install/uninstall test on this PC, leaves nothing behind.

Your check: uninstall, install again from the .exe, use it.

### M9. Later / optional

Mac version (needs a Mac to build and test), online link for watching over
the internet (needs a small server), session notifications, free/paid tiers
and licence keys, Final Cut Pro.

## 7. Risks (Opus)

1. **The Transmit plugin may not load in Premiere 2027** with the 27.0 SDK. M1 starts by proving this with logging, before any other native work. If it never loads, fallback is the old still-frame path (works, but no playback).
2. **WebRTC on iPhone over a plain local address.** If Safari refuses, fallback is the JPEG stream (works today) or a local HTTPS certificate.
3. **Playback control in After Effects** has a thinner scripting API; frame stepping may work, smooth scrubbing may not. M5 states exactly what works.
4. **4K encode cost** on the RTX 3060: likely fine with the hardware encoder; we cap at 1080p until measured.
5. **SDK licence:** the Adobe SDK stays out of git (already set up). Adobe's confidential sample is never copied.
6. **Originality and trademarks:** our own name, UI and drawings; social frames are outlines, not copies of those apps' artwork.

## 8. Questions for you (short)

1. **Name:** keep "Open Tethery" for now, or pick a new name before M0? (Recommend: pick one before sharing it with anyone.)
2. **Selling it:** just for you, or do you want free/paid versions later? (Changes nothing until M9.)
3. **Mac:** needed, or Windows only? (Recommend: Windows first.)

## 9. First step after approval

M0. I will start by merging the two relays into one Helper and building the
new panel, then install it on this PC myself and test it headless. The first
thing I will ask you to do is open **Window > Extensions > Open Tethery** in
Premiere and scan the QR code.
