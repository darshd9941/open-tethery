# Photoshop Live Phone Preview – Build Plan

Plan for an AI coding agent to build a LAN-only tool that mirrors the open Photoshop canvas to any phone browser via QR code, with colour-aware output. Prepared November 3, 2026.

## 1. Problem and goal

The designer makes catalogue images for printed textile products (bedsheets, curtains, table covers). The PC monitor is not colour-accurate, so every check currently means exporting an image, sending it to an iPhone and viewing it there. That is slow.

**Goal:** open a PSD in Photoshop, scan a QR code once on any phone or tablet, and see the canvas update live in the phone browser, with colours converted and tagged correctly so the phone shows them faithfully.

**Constraints given by the user:**

- Runs only on the user's own Wi-Fi network. The PC is on Ethernet, phones are on Wi-Fi, same router.
- No AI features inside the app.
- No hosting, no cloud, no accounts. Everything runs on the PC and on the local network.
- Must work on iPhone and Android and any device with a browser.

**Honest limitation to show in the UI:** a phone screen is a much better reference than an uncalibrated monitor, but it is not a print proof. Final printed colour also depends on fabric and printer.

## 2. Research summary: what already exists

No project was found that combines Photoshop, QR pairing, any-device browser viewing and colour-aware output. Searches covered GitHub, app stores, Adobe forums and general web results. Direct X, Reddit and YouTube results could not be retrieved, so the exact project the user saw is unconfirmed.

### 2.1 Closest open-source project

**gordeev/Photoshop-Mobile-Preview** – https://github.com/gordeev/Photoshop-Mobile-Preview

- A Photoshop UXP plugin plus a small Python relay server and an Android viewer app. iPhone and other devices use a browser viewer served by the relay.
- Sends an sRGB JPEG of the canvas on edits, undo and document switches, not a screen capture.
- Requires Photoshop 24.4 or newer with the Imaging API available.
- Default image size 1600 px, selectable up to 4000 px.
- No QR pairing. Frames travel over unencrypted HTTP/WebSocket with no authentication. States that colour is converted to sRGB and is not a calibrated proofing workflow.
- Brand new (1 commit, 0 stars), no licence seen. Use as a reference design and test it quickly, but check its licence before copying any code.

### 2.2 Older or paid apps (reference only)

- **Adobe Preview CC:** removed from the App Store and from Photoshop in the October 2017 release.
- **Skala Preview:** Mac only, development paused.
- **Design Mirror:** Wi-Fi or USB, supports Photoshop, Sketch and XD, Android and iOS. Reviewers complain about paying per design tool and about instability.
- **CanvasView / Canvas for Photoshop:** iOS only, built on Photoshop Remote Connection, reviews mention crashes and no recent updates.
- **Design Duet:** iPhone app also built on Remote Connection.

### 2.3 Building blocks found

- **Adobe Remote Connection libraries** (Python `photoshop-connection`, .NET `PsDotNet.Kevlar`): can fetch a document thumbnail as JPEG from Photoshop over TCP port 49494. The protocol is old and has known cryptographic weaknesses. **Not recommended.** UXP is the supported path.
- **Photoshop Generator sample** (RationalMatta/photoshop-generator-sample): exposes open documents and layer PNGs over local HTTP. Another legacy option, not recommended.
- **QR pairing pattern:** projects such as Metee01/tui-bridge and alyfe-how/clawcast show the pattern: print or show a QR containing the URL plus a one-time token, phone opens it in a normal browser, no app needed. The pairing design should be copied, not the terminal code.
- **photoshop-mcp / dcc-mcp-photoshop:** confirm that a UXP plugin can only act as a WebSocket client, so a local server must listen and the plugin connects to it.

## 3. Key design decisions

1. **Never capture the monitor.** Screen capture bakes in the uncalibrated display. Pull pixels from the document itself through Photoshop's API.
2. **Use a UXP plugin.** It is Adobe's current plugin system. Avoid the legacy Remote Connection and ExtendScript bridges.
3. **The viewer is a web page.** It works on iPhone, Android and tablets with nothing to install. It can be added to the home screen for full-screen use.
4. **Plugin pushes to a local relay; phones connect to the relay.** UXP can only make outgoing connections, so the relay listens and the plugin connects to it.
5. **LAN only, HTTP.** No tunnel, no cloud, no accounts. A random token in the QR protects the session.
6. **No AI components.** The app grabs pixels, converts colour and sends them.

## 4. Architecture

```
Photoshop (UXP plugin)
    |  WebSocket (plugin connects out to the relay)
    v
Local relay server (on the same PC)
    |  HTTP serves viewer page, WebSocket pushes frames
    v
Phone browser (viewer page)   <-- opened by scanning QR:
                                  http://<PC-LAN-IP>:<port>/#pair=<token>
```

### 4.1 Components

| Component | Language | Job |
| --- | --- | --- |
| UXP plugin panel | JavaScript (UXP) | Start/Stop, status, settings, QR display, grab and send frames |
| Relay server | Node.js (ws + a small HTTP server) or Python | Keep latest frame in memory, pairing tokens, serve viewer, push frames to phones |
| Viewer web page | Plain HTML/CSS/JS | Show image, zoom/pan, reconnect, status |

No database, no external services. Frames are kept in memory only.

## 5. Colour pipeline (the most important part)

### 5.1 Rules

- Get pixels from the document, not from the screen.
- **Convert to a defined profile before sending.** Test both **sRGB** (safe baseline) and **Display P3** (iPhone screens are P3).
- **Embed the ICC profile** in every JPEG or PNG and make sure nothing in the chain strips it (plugin encoder, relay, viewer).
- JPEG quality 92 or higher. Use PNG for flat colour artwork if size allows. Avoid chroma subsampling where the encoder allows it, because flat textile prints show fringing.
- Viewer shows the image with **no filters, no overlays, no UI tint**. Neutral mid-grey background.
- Display which profile the current frame uses, in a small status line.

### 5.2 Why this works

Safari on iPhone colour-manages images that have an embedded profile. Android browsers and vendor display modes vary, so Android needs real-device testing and the UI should say that Android results can differ.

### 5.3 Phone-side reminders (show once in the viewer)

Turn off True Tone, Night Shift / blue-light filter and auto-brightness. Use a fixed brightness. Compare in the same lighting each time.

### 5.4 Colour validation test

Create a test PSD with:

- A grey ramp, RGB primaries and secondaries, skin-tone patches.
- A smooth gradient to expose banding.
- Two or three real catalogue designs with saturated reds, deep blues and pastels.

Compare the live viewer to the same file exported and opened in iPhone Photos. They should be visually identical. This is the acceptance test.

### 5.5 Optional later

Soft-proof toggle using the print house's CMYK profile, so the designer can see out-of-gamut colours before printing.

## 6. Photoshop plugin details

**Requirements to verify first:** the minimum Photoshop version that supports the UXP imaging API (the reference project states 24.4 or newer), and whether the user's installed version qualifies. Agent must confirm from Adobe's UXP documentation.

### 6.1 Capabilities needed

- Read the active document and get pixels at a target size (downscaled), in a chosen colour profile.
- Encode to JPEG or PNG with the ICC profile embedded.
- Listen to document events: edits, undo/redo, layer changes, active document change.
- Open a WebSocket client connection to the relay (manifest must allow network access to the local address).
- Show a panel with Start/Stop, status light, size and quality settings, profile choice (sRGB / Display P3), "Send once" button and the QR code (or a button that opens the pairing page in the browser).

### 6.2 Update logic

- Debounce: send a frame about 300 to 500 ms after the last change.
- Only send the active document.
- Drop stale frames if new edits arrive while a frame is still being captured or sent.
- Guard against huge captures: cap the pixel count so very large catalogue PSDs do not run out of memory.
- Manual "Send now" fallback.

### 6.3 Large files

Catalogue PSDs are very large, so downscale before sending.

- Default: about 1600 to 2400 px on the long edge.
- Setting for up to about 4000 px for more detail at the cost of speed.
- **Phase 2 detail zoom:** when the phone zooms in, the viewer asks the plugin for a higher-resolution crop of that region, so fabric print detail can be inspected without sending the whole file at full size.

### 6.4 Installation

Package as a `.ccx` so it installs by double-click through Creative Cloud. During development load via UXP Developer Tools.

## 7. Relay server details

- Starts with a double-click (Windows `.bat` or packaged exe, macOS `.command`).
- Picks a random free port, or a fixed one saved in settings.
- Finds the correct LAN IP. PCs with VPNs, virtual adapters or both Ethernet and Wi-Fi often report the wrong address, so rank physical adapters first and let the user override in settings.
- Endpoints:
  - `GET /` serves the viewer page.
  - WebSocket for the plugin (sends frames, metadata: document name, size, profile, timestamp).
  - WebSocket for viewers (receives frames, status).
  - Optional: request channel from viewer to plugin for hi-res crops.
- Holds only the latest frame (plus a small history buffer later) in memory.
- Rejects any client without a valid session token.
- Logs connections locally for debugging.

## 8. Viewer page details

### 8.1 MVP

- Opens from QR, reads the token from the URL hash, connects.
- Shows the latest frame full screen: fit to screen, double-tap for 1:1, pinch zoom, pan.
- Keeps the screen awake while open.
- Shows document name, last update time, connection status.
- Auto-reconnects when the phone sleeps or Wi-Fi drops, and re-fetches the latest frame on reconnect.
- Works when added to the home screen on iPhone.

### 8.2 Later

- Several phones connected at the same time.
- Frame history for before/after comparison.
- Side-by-side compare slider.
- Lock current frame.
- Detail-zoom crops (see section 6.3).

## 9. QR pairing and security

- On Start, the relay generates a random session token and the plugin or relay shows a QR containing `http://<LAN-IP>:<port>/#pair=<token>`.
- Token lives only for the session and is regenerated on each Start.
- Put the token in the URL hash so it is not sent to the server in requests. Keep it out of logs.
- Bind to the local network only. Do not port-forward, do not expose to the internet.
- Plain HTTP on the user's own LAN is acceptable for this project. Show a short notice that the preview should only be used on a trusted network.
- Optional later: a PIN or a "approve this device" prompt in the panel.

## 10. Network checklist

- Phone and PC on the same router and subnet (Ethernet PC and Wi-Fi phone are normally fine).
- Do not use a guest Wi-Fi or a mode with client/AP isolation. They block device-to-device traffic.
- Reserve a fixed IP for the PC in the router, or detect the IP at each start.
- Allow the relay through the OS firewall on first run (private network).
- If the QR scans but the page does not load, test the same address in a laptop browser, then check firewall and isolation.
- Fallback: phone hotspot or USB tethering.

## 11. Suggested tech choices

- Plugin: UXP with plain JavaScript, no build tooling beyond what UXP needs.
- Relay: Node.js with the `ws` library and the built-in HTTP module, or Python with the standard library plus a small WebSocket library. Keep dependencies minimal.
- Viewer: plain HTML, CSS and JavaScript, no framework.
- QR generation: a small client-side library inside the plugin panel or relay page.
- No Gradle, no mobile app build required for MVP.

## 12. Build phases

1. **Spike:** plugin grabs the active document at reduced size, converts to a chosen profile, saves a JPEG with an embedded ICC profile. Compare it to the same image in iPhone Photos.
2. **Relay and viewer:** plugin sends that frame to the relay, the viewer shows it on a phone.
3. **Live updates:** document event listening, debounce, stale-frame dropping, reconnect.
4. **QR pairing and token security.**
5. **Colour validation:** test PSD, iPhone and two or three Android phones. Decide default profile (sRGB or Display P3) from results.
6. **Quality of life:** hi-res detail zoom, multiple devices, history, compare slider.
7. **Packaging:** `.ccx` plugin, one-click relay launcher, README with setup and troubleshooting.

## 13. Acceptance criteria

- Scan the QR, frame visible within about 3 seconds.
- After an edit in Photoshop, the phone updates within about 1 second at 1600 px.
- Test swatches and gradients look the same as in iPhone Photos. No visible shift between sRGB and P3 handling.
- Works in iPhone Safari and Android Chrome. Reconnects after the phone sleeps.
- A client without the token is refused.
- Large catalogue PSDs (very high pixel count) do not crash Photoshop or the plugin.
- Works with the PC on Ethernet and the phone on Wi-Fi on the user's network.

## 14. Risks and things the agent must verify

- Exact UXP imaging API calls, available colour profile options, and the minimum Photoshop version. Confirm against current Adobe UXP docs and test on the user's actual version.
- Whether the plugin can render a QR itself or must open a pairing page in the browser.
- Whether the embedded ICC profile survives the plugin's encoder. If not, encode on the relay side with an image library that keeps the profile.
- Licence of gordeev/Photoshop-Mobile-Preview before reusing any of its code. Safest approach is to write original code using it only as a design reference.
- Android browser colour behaviour differs by vendor. Test real devices.
- Memory limits when capturing very large documents.
- A phone is not a print proof. Keep that note visible in the viewer.

## 15. Open items still needed from the user

- Photoshop version and operating system (Windows or Mac).
- Whether Illustrator or CorelDRAW is also used for any catalogue work. If yes, a later phase could support them.
- Whether Android screens are a target as well as the iPhone.

## 16. Reference links

- https://github.com/gordeev/Photoshop-Mobile-Preview
- https://github.com/Metee01/tui-bridge
- https://github.com/alyfe-how/clawcast
- https://github.com/RationalMatta/photoshop-generator-sample
- https://photoshop-connection.readthedocs.io/
- https://www.nuget.org/packages/PsDotNet.Kevlar
- https://pypi.org/project/dcc-mcp-photoshop/
- https://alternativeto.net/software/design-mirror/about
- https://apps.apple.com/app/id788522044
- https://www.creativebloq.com/photoshop/design-duet-app-photoshop-3132250
- https://www.hackdesign.org/toolkit/skala-preview/
