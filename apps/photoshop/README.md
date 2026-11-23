# Live Phone Preview

Mirror the open Photoshop canvas to any phone or tablet on your own Wi-Fi, with
the colour profile attached so the phone shows it as faithfully as it can.

Open a PSD, press **Start** in the Photoshop panel, scan the QR code once, and
the phone browser shows the canvas update as you edit. No app to install on the
phone, no cloud, no accounts, no AI.

> A phone screen is a much better colour reference than an uncalibrated monitor,
> but it is **not a print proof**. Fabric and printer still affect the final
> colour. Keep this in mind for every approval.

---

## What is in this folder

| Path | What it does |
| --- | --- |
| `Start Live Preview.bat` | One-click relay launcher (also opens the status page). |
| `Allow Firewall (admin).bat` | Optional Windows Firewall rule for the relay port (persists until removed). |
| `config.json` | Relay port and optional LAN IP override. |
| `relay/` | Node.js relay: serves the viewer, keeps the latest frame, injects ICC profiles. |
| `viewer/` | Phone web page: pinch zoom, pan, reconnect, wake lock. |
| `plugin/` | Photoshop UXP panel: captures the document, sends frames, shows the QR. |
| `tools/` | Development helpers (mock plugin, tests, screenshots, icon/test-image generators). |
| `build/` | Generated test images and screenshots (not needed for normal use). |
| `logs/` | Relay connection log (created on first run). |

---

## Requirements

- Windows 10/11 for the one-click launcher and firewall helper. The relay itself
  is plain Node.js and should run on macOS/Linux, but the `.bat`/PowerShell
  helpers are Windows-only.
- **Node.js 18 or newer** (tested with 22.17).
- **Adobe Photoshop 24.4 or newer** with the UXP Imaging API.
  Tested against **Photoshop 2026 (27.11)**.
- PC and phone on the **same router / subnet**. PC on Ethernet and phone on
  Wi-Fi is fine, as long as the router bridges them.
- **UXP Developer Tools** (installed with Creative Cloud) to load the plugin
  during development. For everyday use you can package it as a `.ccx`.

No npm packages are needed on the phone, and no app store account is involved.

---

## Quick start

### 1. Start the relay

Double-click **`Start Live Preview.bat`**.

- The first run installs the single relay dependency (`ws`) locally.
- A console window stays open and a browser tab opens the relay status page.
- Windows may ask for firewall permission the first time. Allow it on
  **Private** *and* **Public** if Windows offers both. Windows often classifies
  a wired Ethernet connection as **Public**, which still works; this app only
  listens on the local network. If the prompt never appears and the phone cannot
  connect, run **`Allow Firewall (admin).bat`** once (it opens only the relay
  TCP port).

The console prints the PC address, for example:

```
This PC:  http://192.168.1.212:47823/
```

### 2. Load the Photoshop panel

1. Open Photoshop.
2. Open **UXP Developer Tools**.
3. Click **Add Plugin**, choose `plugin/manifest.json` from this folder.
4. Click **Load** next to the plugin.
5. In Photoshop open **Plugins → Live Phone Preview** (or
   **Window → Extensions**).

The panel shows a status dot, Start/Stop, the QR area, and settings.

### 3. Start and scan

1. In the panel press **Start**.
2. A QR code appears. Scan it with the phone camera.
3. The phone browser opens `http://<PC-IP>:<port>/#pair=<token>` and shows the
   current document.
4. Edit the PSD. The phone updates roughly 300–500 ms after you stop editing.

The token is in the URL hash, so it is not sent in the HTTP request. It is
regenerated every time you press Start. A client without the current token is
refused.

### 4. Add to the phone home screen (optional)

- **iPhone Safari:** Share → Add to Home Screen.
- **Android Chrome:** menu → Add to Home screen.

The viewer is a PWA and launches full screen. It remembers the last token in
`localStorage`, so a home-screen launch can reconnect while the same session is
still running. A new Start invalidates the old token; rescan when that happens.

---

## Using the panel

| Control | What it does |
| --- | --- |
| **Start / Stop** | Starts a pairing session and the live updates, or ends it. |
| **Send now** | Forces one frame (useful if an edit did not trigger an update). |
| **Open the viewer on this PC** | Opens the viewer in the default browser for a quick check. |
| **Size** | Long edge of the preview: 1200–4000 px. 1600 px is the default. Larger is sharper but heavier on large catalogue files. |
| **Profile** | `sRGB` by default. `Display P3` appears only if Windows has a Display P3 profile installed (see below). |
| **Relay port** | Must match `config.json` (default `47823`). Changing it requires Stop/Start and a relay restart. |

The plugin only sends the **active document**. It debounces edits, drops stale
frames, and caps the capture at 12 megapixels so very large catalogue PSDs do
not exhaust plugin memory.

---

## Packaging the plugin (optional)

Loading through UXP Developer Tools is fine for daily use on one machine. To
build a distributable `.ccx`:

1. Open **UXP Developer Tools → Plugins**, find **Live Phone Preview**, and
   click **Package** (or the package icon).
2. Select `plugin/manifest.json` and save the `.ccx` outside the plugin folder.
3. Double-click the `.ccx`, or open **Creative Cloud → Marketplaces → Add
   plugin**, and install it.
4. Restart Photoshop; the panel appears under **Plugins → Live Phone Preview**.

The package is only signed automatically if you configure a certificate. On a
machine that has not trusted your certificate, Photoshop may refuse the
unsigned build — in that case keep using **Load** in UXP Developer Tools, which
runs in developer mode.

---

## Colour pipeline

This is the part that matters most.

1. Pixels come from the document through Photoshop's Imaging API — **never from
   the monitor**. Screen capture would bake in the uncalibrated display.
2. Photoshop converts the pixels to the selected profile (`sRGB IEC61966-2.1`
   by default, or Display P3) before encoding.
3. The plugin encodes a JPEG and sends it to the relay.
4. The relay **strips any existing ICC tag and injects the matching ICC
   profile** as a standard JPEG `APP2 ICC_PROFILE` segment, losslessly. This is
   what makes the phone interpret the numbers correctly.
5. The viewer applies **no CSS filters, no tint, no overlay** over the image.
   The surrounding UI is neutral mid-grey (`#808080`).

The relay ships two CC0 profiles in `relay/profiles/`:

- `sRGB.icc` — the safe baseline, used by default.
- `DisplayP3.icc` — optional, for iPhone screens.

### Enabling Display P3 (optional)

Photoshop can only convert to a profile installed in the operating system.
Windows usually does not install Display P3 by default, so the option is hidden
until it exists.

1. Right-click `relay/profiles/DisplayP3.icc` → **Install profile**
   (on Windows 11 you may need **Color Management → All Profiles → Add**).
2. Restart Photoshop.
3. Reopen the panel. The Profile picker now offers **Display P3**.

If you are unsure, stay on sRGB. An sRGB-tagged frame looks correct on both
iPhone and Android and is the safer default for catalogue approvals.

### Phone-side checklist

Show this once in the viewer, but keep it in mind:

- Turn off **True Tone**, **Night Shift** / any blue-light filter, and
  **auto-brightness**.
- Use a fixed brightness.
- Compare in the same lighting every time.
- Android browsers and vendor display modes vary; verify important colours on
  the actual device.

### Acceptance test

1. Build the test PSD described in the plan: grey ramp, RGB primaries and
   secondaries, skin tones, a smooth gradient, and two or three real catalogue
   designs with saturated reds, deep blues and pastels.
2. Open it in Photoshop, start the preview, and view it on the phone.
3. Export the same file and open it in iPhone Photos.
4. The live viewer and Photos should look visually identical. Check gradients
   for banding and flat textile fills for fringing.

A quick synthetic frame is included: run
`powershell -File tools\make-test-image.ps1` and send
`build/test-frame.jpg` through `tools/mock-plugin.js`.

---

## Troubleshooting

**The phone cannot open the page (QR scans, then times out).**

- Confirm the phone and PC are on the same router and subnet.
- Do not use guest Wi-Fi or an AP-isolation mode; they block phone-to-PC
  traffic.
- Allow Node.js through Windows Firewall on **Private** and **Public** networks,
  or run `Allow Firewall (admin).bat`.
- Test `http://<PC-IP>:<port>/` in a laptop browser on the same network.
- If the PC has VPNs or virtual adapters, the printed IP may be wrong. Set the
  correct address explicitly in `config.json`:

  ```json
  { "port": 47823, "lanIp": "192.168.1.212" }
  ```

  Then restart the relay.
- Fallback: use the phone's hotspot or USB tethering and connect the PC to it.

**The panel says "Relay not reachable".**

- Is the `Start Live Preview.bat` console still open?
- Does the port in the panel match `config.json`?
- Check `logs/relay.log`.

**Port 47823 is already in use.**

Close the other relay window, or change the port in both `config.json` and the
plugin panel. If you created a firewall rule for the old port, run the firewall
helper again.

**The preview updates slowly on a huge PSD.**

Lower **Size** to 1600 or 1200. Frames are sent only after you stop editing for
about 350 ms. The 4000 px setting is intended for detail checks, not continuous
painting.

**Colours look different from Photoshop.**

- Check the profile pill in the viewer (`sRGB` or `Display P3`).
- Turn off phone display filters as above.
- Make sure the relay was not started from an old copy; the ICC injection lives
  in `relay/icc.js`.
- Android colour management varies by vendor. Test the real device.
- A phone is not a print proof.

**UXP Developer Tools says "Plugin load timed out" or "Plugin Load Failed".**

This is UDT waiting on Photoshop, not a plugin error. Photoshop is busy, showing
a modal dialog, or hung.

- Check Photoshop in Task Manager. If it says **Not responding** or is using
  many GB of private memory, close and restart Photoshop, then click **Load**
  again. A hung host will always time out.
- Close any open Photoshop dialog (Preferences, Save, Camera Raw, a progress
  window) and try again.
- Wait until Photoshop has finished starting and a document is open before
  loading the plugin.
- If it still fails, check the newest log in
  `%APPDATA%\Adobe\Adobe Photoshop 2026\Logs\UXPLogs_*.log` for a plugin error.

**The QR code does not render in the panel.**

The panel falls back to showing the full URL. Check that
`plugin/lib/qrcode.js` exists. You can still open the URL manually on the phone.

---

## Security and privacy

- The relay binds to `0.0.0.0` on your LAN only. There is no port forwarding, no
  tunnel, no cloud and no account.
- The frame data is held in memory only, and only the latest frame is kept.
- A random 128-bit session token is required. It is generated on each Start,
  placed in the URL **hash**, and sent to the relay inside the WebSocket
  handshake message rather than in the request line.
- Plain HTTP is used on the local network. Only run this on a network you trust.
  Do not expose the port to the internet.
- Logs contain connection events, not frame data or tokens.

---

## Current scope and honest limitations

Implemented (MVP):

- UXP panel with Start/Stop, status, size, profile, port, Send now, QR.
- Document-pixel capture (not screen capture), sRGB conversion, ICC-tagged JPEG.
- Relay with LAN IP detection, token auth, latest-frame cache, reconnect grace.
- Viewer with fit/1:1, pinch zoom, pan, auto-reconnect, wake lock, PWA install,
  connection/document/profile/time status, and a one-time colour reminder.
- Mock-plugin and viewer test harnesses.

Not implemented yet (the plan's later phases):

- Hi-res detail crop when the phone zooms in.
- Frame history, before/after compare slider, lock frame.
- Multiple simultaneous sessions (multiple phones are supported; one Photoshop
  session at a time).
- Soft-proof toggle with the print house's CMYK profile.
- A packaged `.ccx` installer built automatically (use UXP Developer Tools →
  Package for now).
- Configurable JPEG quality/subsampling. The UXP encoder controls these; the
  relay does not re-encode, so it stays lossless apart from the original JPEG.
- Illustrator / CorelDRAW.

Android is supported in the browser, but colour behaviour differs by vendor and
needs real-device testing. iPhone Safari is the primary reference device.

---

## Development

```powershell
# Relay (foreground)
node relay\server.js

# Pretend to be Photoshop (send the generated test frame)
node tools\mock-plugin.js --loop

# Connect like the viewer and verify the embedded ICC profile
node tools\test-viewer.js

# Verify a wrong token is rejected
node tools\test-viewer.js --bad

# True mobile-emulated screenshot (390x844 @2x)
node tools\screenshot.js "http://127.0.0.1:47823/#pair=<token>" build\viewer.png

# Regenerate icons / test image
powershell -File tools\make-icons.ps1
powershell -File tools\make-test-image.ps1
```

The relay's `/info` endpoint reports the detected IP, plugin state, viewer count
and current frame metadata (never the token).

### Architecture

```
Photoshop (UXP plugin)
    |  WebSocket: register + frames (base64 JPEG + metadata)
    v
Relay (Node.js + ws, this PC)
    |  HTTP: viewer page, /info
    |  WebSocket: welcome, status, frames
    v
Phone browser (viewer)
    <- opened by scanning  http://<PC-IP>:<port>/#pair=<token>
```

Frames flow plugin → relay → all authenticated viewers. The relay keeps one
frame and one session token in memory. No database.

---

## Credits and licences

- QR rendering: [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator)
  by Kazuhiko Arase, MIT licence (vendored at `plugin/lib/qrcode.js`).
- ICC profiles: [Compact ICC Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles)
  by Chris Cox, CC0 1.0 (see `relay/profiles/LICENSE-Compact-ICC-Profiles.txt`).
- Relay WebSocket library: [`ws`](https://github.com/websockets/ws), MIT.
- Design reference only:
  [gordeev/Photoshop-Mobile-Preview](https://github.com/gordeev/Photoshop-Mobile-Preview).
  No source code was copied from it; this implementation is original.

This tool is for local, trusted-network use. Test colour decisions on the real
substrate before production.
