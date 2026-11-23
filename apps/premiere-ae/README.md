# Live Video Preview (Premiere Pro & After Effects)

Mirror your active **Premiere Pro sequence** or **After Effects composition** directly to any phone or tablet on your local Wi-Fi in real time as you edit and scrub.

Open your timeline, start the panel, scan the QR code once with your phone camera, and your phone screen updates automatically whenever you pause scrubbing or make an edit.

- **Zero Phone App**: Runs directly in Safari or Chrome as an installable PWA.
- **Accurate Colors**: Preserves color fidelity with embedded sRGB or Display P3 ICC profile metadata.
- **Video Aspect Ratio & Safe Guides**: Built-in 9:16 vertical crop guide (TikTok/Reels/Shorts), 4:5, 1:1 square, and 80% Title Safe guides.
- **Timecode & Comp Display**: Shows real-time playhead timecode, sequence/comp name, and resolution right on the mobile status bar.
- **Local & Private**: No cloud, no accounts, no subscriptions. Runs entirely over your local Wi-Fi network.

---

## Directory Structure

| Path | Description |
| --- | --- |
| `Start Live Preview.bat` | One-click launcher for the local Node.js relay server. |
| `Install Extension.bat` | One-click installer for the Adobe CEP panel in Premiere Pro & After Effects. |
| `Allow Firewall (admin).bat` | Optional Windows Firewall rule helper for port 47825. |
| `config.json` | Configurable relay port (default `47825`) and LAN IP override. |
| `relay/` | Node.js relay server with WebSocket broadcast and ICC profile injection. |
| `viewer/` | Mobile web application with pinch-zoom, pan, 1:1 fit, and aspect guides. |
| `extension/` | Universal CEP extension for Premiere Pro and After Effects. |
| `scripts/` | Standalone ExtendScript / ScriptUI helpers. |

---

## Requirements

1. **Windows 10 / 11**
2. **Node.js 18 or newer** (LTS recommended)
3. **Adobe Premiere Pro** (2020 through 2026+) and/or **Adobe After Effects** (2020 through 2026+)
4. PC and Phone connected to the **same Wi-Fi router / subnet**.

---

## Quick Start (3 Steps)

### Step 1: Install the Panel (One-time)
Double-click **`Install Extension.bat`**.
- This automatically links the extension into `%APPDATA%\Adobe\CEP\extensions`.
- Enables `PlayerDebugMode` in the Windows registry so Premiere & AE load the development panel seamlessly.

### Step 2: Start the Relay
Double-click **`Start Live Preview.bat`**.
- Starts the relay on port `47825` (keeps running in a console window).
- Opens the local status page in your browser.

### Step 3: Open in Premiere Pro or After Effects
1. Open Premiere Pro or After Effects.
2. In the top menu, go to:
   **`Window` → `Extensions` → `Live Video Preview`**
3. In the panel, click **Start Preview**.
4. Scan the QR code with your phone camera.
5. Scrub your timeline or move the playhead — the phone updates within ~350ms of pausing on a frame!

---

## Features & Controls

### Panel Controls
- **Start / Stop Preview**: Generates a secure session token and starts the live sync loop.
- **Send Now**: Forces an immediate capture of the current playhead frame.
- **Scrub Pause Delay**: Adjust the debounce slider (200ms - 800ms). Default 350ms ensures smooth editing without unnecessary exports while dragging.
- **Color Profile**: Select `sRGB` (universal safe default) or `Display P3` (iPhone / high-gamut mobile screens).

### Mobile Phone Controls
- **Pinch to Zoom & Pan**: Fluid multi-touch zoom up to 10× to inspect fine details.
- **Double Tap / 1:1 Button**: Toggles between "Fit to Screen" and "1:1 pixel exact" scaling.
- **Guides Button**: Cycles through aspect ratio overlays:
  - **9:16**: Shows TikTok / Instagram Reels / YouTube Shorts crop box over 16:9 footage.
  - **4:5**: Shows Instagram portrait feed crop box.
  - **1:1**: Shows square crop box.
  - **Title Safe**: 80% action/title safe boundary.
- **Screen Keep-Awake**: Uses the Screen Wake Lock API to prevent the phone display from dimming or sleeping while you edit.
- **Single Tap**: Toggles the top HUD overlay on/off for distraction-free full-screen viewing.

---

## How It Works Under The Hood

```
┌────────────────────────────────────────┐
│ Adobe Premiere Pro / After Effects     │
│ (Universal CEP Panel)                  │
│  - Timeline signature watcher (250ms)  │
│  - Frame export at CTI (debounced)     │
│  - WebSocket client                    │
└──────────────────┬─────────────────────┘
                   │ ws://127.0.0.1:47825/ws
                   ▼
┌────────────────────────────────────────┐
│ Node.js Relay Server                   │
│  - Auto-detects local LAN IP           │
│  - Injects ICC profile (sRGB / P3)     │
│  - Broadcasts frame + timecode meta    │
└──────────────────┬─────────────────────┘
                   │ LAN Wi-Fi (HTTP & WS)
                   ▼
┌────────────────────────────────────────┐
│ Mobile PWA Viewer (Phone Browser)      │
│  - Dual-buffer zero-flicker rendering  │
│  - 9:16 / 4:5 / 1:1 Social Crop Guides │
│  - Touch gestures & Screen Wake Lock   │
└────────────────────────────────────────┘
```

---

## Troubleshooting

- **Phone cannot open the QR link**:
  - Verify that the phone and PC are connected to the exact same Wi-Fi router (avoid guest Wi-Fi networks with AP-isolation enabled).
  - Run **`Allow Firewall (admin).bat`** to ensure Windows Firewall allows port `47825`.
- **Panel doesn't appear under `Window > Extensions`**:
  - Run **`Install Extension.bat`** and restart Premiere Pro / After Effects.
- **Timeline says "Open a sequence/comp"**:
  - In Premiere: Click inside your sequence timeline so it becomes active.
  - In After Effects: Click inside your composition panel so it is active.
